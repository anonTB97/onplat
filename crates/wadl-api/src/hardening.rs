//! Production hardening for the HTTP surface, hand-rolled on what the tree
//! already carries.
//!
//! Everything here is deliberately small enough to read in one sitting,
//! because for an accreditation review "what does this layer do" must be
//! answerable from this file: browser protections are a fixed set of headers
//! written once; overload protection is a semaphore and a timer from tokio;
//! the static site is served by the handler below, whose traversal guard is
//! visible, rather than by a file-server dependency with its own release
//! cadence and CVE history. The policy this implements — and the reasoning
//! for hand-rolling over adding crates — lives in `docs/production-posture.md`.

use std::path::{Component, Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use axum::extract::Request;
use axum::http::{header, HeaderValue, Method, StatusCode, Uri};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::any;
use axum::Router;
use std::io::Write as _;

use flate2::write::GzEncoder;
use flate2::Compression;
use tokio::sync::Semaphore;
use wadl_domain::Clock;

/// Overload limits for [`harden`]. Both exist so that one runaway client — or
/// one slow downstream — degrades service loudly (fast 503s) instead of
/// silently (unbounded queueing until the host dies).
#[derive(Clone, Copy, Debug)]
pub struct Limits {
    /// Requests allowed in flight at once; the excess is shed with a 503.
    pub max_in_flight: usize,
    /// How long a handler may run before the request is abandoned with a 503.
    /// Measured to first response, so a large streamed body is not cut off.
    pub request_timeout: Duration,
}

impl Default for Limits {
    fn default() -> Self {
        Self {
            // Generous for a yard's worth of planners; small enough that a
            // load test finds the ceiling before an incident does.
            max_in_flight: 512,
            // The slowest honest request we serve — a full 256 MB import — has
            // been measured in single-digit seconds; 30 gives 5× headroom.
            request_timeout: Duration::from_secs(30),
        }
    }
}

/// Applies the production middleware to a finished router: concurrency
/// shedding and a per-request timeout innermost, security headers on every
/// response, and the audit log outermost.
///
/// Ordering is the point: headers wrap the guard so even a shed 503 carries
/// the full header set — an origin that answers differently under load is the
/// kind of inconsistency scanners flag — and the audit layer wraps everything
/// so refusals of every kind (shed, timed out, unauthorized) are recorded
/// exactly as loudly as successes.
pub fn harden(router: Router, limits: Limits, clock: Arc<dyn Clock>) -> Router {
    let gate = Arc::new(Semaphore::new(limits.max_in_flight));
    let timeout = limits.request_timeout;
    router
        .layer(middleware::from_fn(compressed))
        .layer(middleware::from_fn(move |req: Request, next: Next| {
            let gate = Arc::clone(&gate);
            async move { guarded(&gate, timeout, req, next).await }
        }))
        .layer(middleware::from_fn(security_headers))
        .layer(middleware::from_fn(move |req: Request, next: Next| {
            let clock = Arc::clone(&clock);
            async move { audited(clock.as_ref(), req, next).await }
        }))
}

/// The audit stream: one JSON object per request on stdout.
///
/// What is logged: every `/api` request, and every non-2xx response wherever
/// it came from — a refused action is precisely the record an assessor asks
/// for, so refusals can never be quieter than successes. What is *not*
/// logged: 2xx static-asset and health traffic (volume without meaning), the
/// query string (time-control instants add nothing to accountability), and
/// request bodies (an import's content is accounted for by the ledger and
/// the door's own receipt, not the transport log).
///
/// The `org` field repeats the caller's asserted tenant so log lines can be
/// grouped per tenant; in proxy-asserted mode (see `auth`) that assertion is
/// only accepted from the authenticated proxy hop.
async fn audited(clock: &dyn Clock, req: Request, next: Next) -> Response {
    let method = req.method().clone();
    let path = req.uri().path().to_owned();
    let org = req
        .headers()
        .get("x-org-id")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("-")
        .to_owned();
    let started = clock.now().epoch_millis();
    let res = next.run(req).await;
    let finished = clock.now().epoch_millis();
    let status = res.status().as_u16();
    if path.starts_with("/api") || status >= 400 {
        println!(
            "{}",
            serde_json::json!({
                "audit": "http",
                "ts_ms": finished,
                "method": method.as_str(),
                "path": path,
                "status": status,
                "dur_ms": finished - started,
                "org": org,
            })
        );
    }
    res
}

/// The concurrency + timeout guard. Shedding uses `try_acquire` — a request
/// over the limit is refused immediately rather than queued, so the caller's
/// retry logic (and a load balancer's health check) sees the truth at once.
async fn guarded(gate: &Semaphore, timeout: Duration, req: Request, next: Next) -> Response {
    let Ok(_permit) = gate.try_acquire() else {
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            "at capacity — retry shortly",
        )
            .into_response();
    };
    match tokio::time::timeout(timeout, next.run(req)).await {
        Ok(res) => res,
        Err(_) => (
            StatusCode::SERVICE_UNAVAILABLE,
            "request took too long and was abandoned",
        )
            .into_response(),
    }
}

/// Bodies below this size ship uncompressed: the frame costs more than it
/// saves, and tiny responses are latency-bound, not bandwidth-bound.
const COMPRESS_FLOOR: usize = 16 * 1024;

/// Bodies above this ceiling pass through untouched rather than being
/// buffered twice; nothing the API serves is near it, and a bound beats a
/// surprise.
const COMPRESS_CEILING: usize = 256 * 1024 * 1024;

/// Gzip for the text-shaped responses, hand-rolled (the workspace's stated
/// posture: no tower-http; every layer readable in one sitting).
///
/// Admitted for one measured number: the full activity register at key-op
/// grain (~40k rows) serializes to ~23 MB, which compresses ~10:1 — the
/// difference between a kiosk refresh and a stalled one on a yard network.
/// `Compression::fast()` because the win is the wire, not the ratio: level 1
/// already takes JSON down an order of magnitude at a fraction of the CPU of
/// the default level, and this runs inside the concurrency permit.
///
/// What is compressed: 2xx responses the client asked gzip for, whose
/// content-type is JSON or text-shaped, that are not already encoded and not
/// trivially small. Everything else — images (already compressed), errors
/// (small), HEAD-shaped bodies — passes through untouched.
async fn compressed(req: Request, next: Next) -> Response {
    let wants_gzip = req
        .headers()
        .get(header::ACCEPT_ENCODING)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| v.contains("gzip"));
    let res = next.run(req).await;
    if !wants_gzip || !res.status().is_success() {
        return res;
    }
    let compressible = res
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|ct| {
            ct.starts_with("application/json")
                || ct.starts_with("text/")
                || ct.starts_with("application/javascript")
                || ct.starts_with("image/svg")
        });
    if !compressible || res.headers().contains_key(header::CONTENT_ENCODING) {
        return res;
    }
    let (mut parts, body) = res.into_parts();
    let Ok(bytes) = axum::body::to_bytes(body, COMPRESS_CEILING).await else {
        // A body we refuse to buffer is a body we refuse to recompose; serve
        // a plain error rather than a truncated payload dressed as success.
        return (StatusCode::INTERNAL_SERVER_ERROR, "response too large").into_response();
    };
    if bytes.len() < COMPRESS_FLOOR {
        return Response::from_parts(parts, axum::body::Body::from(bytes));
    }
    let mut enc = GzEncoder::new(Vec::with_capacity(bytes.len() / 8), Compression::fast());
    if enc.write_all(&bytes).is_err() {
        return Response::from_parts(parts, axum::body::Body::from(bytes));
    }
    let Ok(gz) = enc.finish() else {
        return Response::from_parts(parts, axum::body::Body::from(bytes));
    };
    parts
        .headers
        .insert(header::CONTENT_ENCODING, HeaderValue::from_static("gzip"));
    parts
        .headers
        .insert(header::VARY, HeaderValue::from_static("accept-encoding"));
    parts.headers.remove(header::CONTENT_LENGTH);
    Response::from_parts(parts, axum::body::Body::from(gz))
}

/// Stamps the browser-protection headers on every response.
///
/// The CSP allows exactly what the shell is: same-origin documents, scripts
/// and fetches, inline `style` attributes (React styles), `data:` images (the
/// favicon), and nothing framed, embedded, or loaded from anywhere else. No
/// third-party origin appears because the product loads nothing from one —
/// that is a property this header now *enforces* rather than merely enjoys.
async fn security_headers(req: Request, next: Next) -> Response {
    let mut res = next.run(req).await;
    let h = res.headers_mut();
    h.insert(
        header::CONTENT_SECURITY_POLICY,
        HeaderValue::from_static(
            "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; \
             img-src 'self' data:; connect-src 'self'; font-src 'self'; \
             object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
        ),
    );
    h.insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    h.insert(header::X_FRAME_OPTIONS, HeaderValue::from_static("DENY"));
    h.insert(
        header::REFERRER_POLICY,
        HeaderValue::from_static("no-referrer"),
    );
    h.insert(
        header::HeaderName::from_static("cross-origin-opener-policy"),
        HeaderValue::from_static("same-origin"),
    );
    h.insert(
        header::HeaderName::from_static("cross-origin-resource-policy"),
        HeaderValue::from_static("same-origin"),
    );
    h.insert(
        header::HeaderName::from_static("permissions-policy"),
        HeaderValue::from_static("camera=(), microphone=(), geolocation=(), usb=()"),
    );
    res
}

/// Installs the built shell as this router's fallback, making the API and the
/// site one binary — one artifact to scan, sign, and deploy; no separate web
/// server with its own configuration to accredit.
///
/// Anything that is not an API route lands here: `/assets/*` files serve with
/// an immutable cache header (vite content-hashes the names), anything
/// path-shaped without an extension serves `index.html` (the shell routes in
/// the fragment), and the traversal guard in [`resolve`] decides what a path
/// may reach before the filesystem is consulted.
pub fn static_site(router: Router, dist: PathBuf) -> Router {
    let dist = Arc::new(dist);
    router.fallback(any(move |method: Method, uri: Uri| {
        let dist = Arc::clone(&dist);
        async move { serve_file(&dist, &method, &uri).await }
    }))
}

/// Maps a request path to a file under `dist`, or to nothing.
///
/// The guard is allow-listing, not clean-up: a path is either made purely of
/// ordinary components — no `..`, no root, no drive prefix, and no percent
/// escapes or backslashes that could smuggle one past the check — or it does
/// not touch the filesystem at all. Vite emits plain ASCII names, so refusing
/// the exotic costs nothing.
fn resolve(dist: &Path, uri_path: &str) -> Option<PathBuf> {
    if uri_path.contains('%') || uri_path.contains('\\') {
        return None;
    }
    let rel = uri_path.trim_start_matches('/');
    if rel.is_empty() {
        return Some(dist.join("index.html"));
    }
    let rel = Path::new(rel);
    if rel.components().any(|c| !matches!(c, Component::Normal(_))) {
        return None;
    }
    Some(dist.join(rel))
}

/// Serves one file from the dist directory. Reads happen on the blocking pool
/// so a large asset cannot stall the request reactor.
async fn serve_file(dist: &Path, method: &Method, uri: &Uri) -> Response {
    if method != Method::GET && method != Method::HEAD {
        return StatusCode::METHOD_NOT_ALLOWED.into_response();
    }
    let Some(mut path) = resolve(dist, uri.path()) else {
        return StatusCode::NOT_FOUND.into_response();
    };
    // No extension means it is a route, not a file — the shell owns those.
    if path.extension().is_none() {
        path = dist.join("index.html");
    }
    let mime = content_type(&path);
    let immutable = uri.path().starts_with("/assets/");
    let read = tokio::task::spawn_blocking(move || std::fs::read(path)).await;
    let Ok(Ok(bytes)) = read else {
        return StatusCode::NOT_FOUND.into_response();
    };
    (
        [
            (header::CONTENT_TYPE, mime),
            (
                header::CACHE_CONTROL,
                if immutable {
                    "public, max-age=31536000, immutable"
                } else {
                    "no-cache"
                },
            ),
        ],
        bytes,
    )
        .into_response()
}

/// Content type by extension — the closed set vite actually emits, plus wasm
/// for the day the engine ships to the browser. Unknown extensions download
/// rather than render, which is the safe default.
fn content_type(path: &Path) -> &'static str {
    match path.extension().and_then(|e| e.to_str()) {
        Some("html") => "text/html; charset=utf-8",
        Some("js") => "text/javascript",
        Some("css") => "text/css",
        Some("svg") => "image/svg+xml",
        Some("json" | "map" | "webmanifest") => "application/json",
        Some("png") => "image/png",
        Some("ico") => "image/x-icon",
        Some("woff2") => "font/woff2",
        Some("wasm") => "application/wasm",
        Some("txt") => "text/plain; charset=utf-8",
        _ => "application/octet-stream",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The compression layer's whole contract in one place: a large JSON body
    /// for a gzip-accepting client compresses (and round-trips); everything
    /// else — a client that never asked, a body under the floor, an image —
    /// passes through byte-identical.
    #[tokio::test]
    async fn compression_applies_exactly_where_it_claims() {
        use axum::routing::get;
        use tower::ServiceExt;

        let big = serde_json::to_string(&vec!["the same forty bytes of json"; 4096]).unwrap();
        let big_len = big.len();
        assert!(big_len > COMPRESS_FLOOR);
        let app = Router::new()
            .route(
                "/big",
                get(move || {
                    let body = big.clone();
                    async move { ([(header::CONTENT_TYPE, "application/json")], body) }
                }),
            )
            .route(
                "/small",
                get(|| async { ([(header::CONTENT_TYPE, "application/json")], "{}") }),
            )
            .route(
                "/png",
                get(|| async { ([(header::CONTENT_TYPE, "image/png")], vec![0_u8; 64 * 1024]) }),
            )
            .layer(middleware::from_fn(compressed));

        let ask = |path: &'static str, gzip: bool| {
            let app = app.clone();
            async move {
                let mut req = axum::http::Request::builder().uri(path);
                if gzip {
                    req = req.header(header::ACCEPT_ENCODING, "gzip, br");
                }
                let res = app
                    .oneshot(req.body(axum::body::Body::empty()).unwrap())
                    .await
                    .unwrap();
                let encoding = res
                    .headers()
                    .get(header::CONTENT_ENCODING)
                    .map(|v| v.to_str().unwrap_or("?").to_owned());
                let bytes = axum::body::to_bytes(res.into_body(), COMPRESS_CEILING)
                    .await
                    .unwrap();
                (encoding, bytes)
            }
        };

        // The one case that compresses — and it round-trips.
        let (enc, bytes) = ask("/big", true).await;
        assert_eq!(enc.as_deref(), Some("gzip"));
        assert!(
            bytes.len() * 4 < big_len,
            "json should crush: {}",
            bytes.len()
        );
        let mut dec = flate2::read::GzDecoder::new(&bytes[..]);
        let mut out = String::new();
        std::io::Read::read_to_string(&mut dec, &mut out).unwrap();
        assert_eq!(out.len(), big_len);

        // A client that never asked gets identity bytes.
        let (enc, bytes) = ask("/big", false).await;
        assert_eq!(enc, None);
        assert_eq!(bytes.len(), big_len);

        // Below the floor: not worth the frame.
        let (enc, _) = ask("/small", true).await;
        assert_eq!(enc, None);

        // Already-compressed shapes pass through.
        let (enc, bytes) = ask("/png", true).await;
        assert_eq!(enc, None);
        assert_eq!(bytes.len(), 64 * 1024);
    }

    #[test]
    fn traversal_shapes_never_reach_the_filesystem() {
        let dist = Path::new("/srv/dist");
        for evil in [
            "/../etc/passwd",
            "/assets/../../etc/passwd",
            "/..",
            "/%2e%2e/etc/passwd",
            "/assets/%2e%2e%2fsecret",
            "/a\\..\\b",
            "//etc/passwd", // empty first component is not Normal? guarded either way
        ] {
            let got = resolve(dist, evil);
            if let Some(p) = &got {
                assert!(
                    p.starts_with(dist) && !p.to_string_lossy().contains(".."),
                    "{evil} resolved to {}",
                    p.display()
                );
            }
        }
        assert_eq!(resolve(dist, "/../x"), None);
        assert_eq!(resolve(dist, "/a/../x"), None);
    }

    #[test]
    fn ordinary_paths_resolve_under_dist() {
        let dist = Path::new("/srv/dist");
        assert_eq!(
            resolve(dist, "/assets/index-abc123.js"),
            Some(dist.join("assets/index-abc123.js"))
        );
        assert_eq!(resolve(dist, "/"), Some(dist.join("index.html")));
    }

    #[test]
    fn content_types_cover_the_vite_output() {
        assert_eq!(
            content_type(Path::new("a/index.html")),
            "text/html; charset=utf-8"
        );
        assert_eq!(content_type(Path::new("a/x.js")), "text/javascript");
        assert_eq!(
            content_type(Path::new("a/x.bin")),
            "application/octet-stream"
        );
    }
}
