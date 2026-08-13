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
use tokio::sync::Semaphore;

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

/// Applies the production middleware to a finished router: security headers
/// on every response, then concurrency shedding and a per-request timeout.
///
/// The headers layer is outermost so even a shed 503 carries the full header
/// set — an origin that answers differently under load is the kind of
/// inconsistency scanners flag.
pub fn harden(router: Router, limits: Limits) -> Router {
    let gate = Arc::new(Semaphore::new(limits.max_in_flight));
    let timeout = limits.request_timeout;
    router
        .layer(middleware::from_fn(move |req: Request, next: Next| {
            let gate = Arc::clone(&gate);
            async move { guarded(&gate, timeout, req, next).await }
        }))
        .layer(middleware::from_fn(security_headers))
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
