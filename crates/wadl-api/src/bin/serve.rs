//! The server binary: one hardened router over whichever store is configured.
//!
//! One binary is the deployment story (see `docs/production-posture.md`): the
//! API and the built shell ship together, wrapped in the same security
//! headers, concurrency shedding and request timeout that production runs —
//! development exercises the hardened path daily instead of meeting it at
//! accreditation. Built with the `postgres` feature, `DATABASE_URL` selects
//! the database-backed store (RLS armed per request); otherwise the seeded
//! in-memory demo world answers, and the startup banner says which. The
//! remaining production swap is identity: the header shim gives way to the
//! proxy-asserted mode when `WADL_PROXY_KEY` is set.
//!
//! Configuration is environment-only — no config file to drift from the
//! deployed reality:
//!
//! * `WADL_PORT` — listen port, default 8080.
//! * `WADL_BIND` — listen address, default `127.0.0.1`. Loopback by default
//!   on purpose: exposing the port is a decision, made in the unit file that
//!   sets this, behind whatever terminates TLS.
//! * `WADL_STATIC_DIR` — a built `shell-web/dist` to serve as the site; unset
//!   means API-only (development, where vite serves the shell).
//! * `WADL_DEMO_DOCS` — a directory of the hull's documents (yard clock,
//!   compartment register, zone chart, geometry, couplings, field-condition
//!   log, and a `*.xer`) to load at boot through the doors' own paths; the
//!   served hull IS the documents. `reference/cvn73` is the shipped one.
//! * `WADL_SCHEDULE_XER` — a P6 export to load as the schedule of record
//!   (overrides any `*.xer` in `WADL_DEMO_DOCS`).
//! * `WADL_MAX_IN_FLIGHT`, `WADL_REQUEST_TIMEOUT_SECS` — overload limits;
//!   defaults in [`wadl_api::hardening::Limits`].
//! * `WADL_PROXY_KEY` — arms proxy-asserted identity: requests must carry a
//!   matching `x-wadl-proxy-key` header before their identity headers are
//!   trusted. Unset means the dev header shim. See `wadl-api`'s auth module.
//!
//! The port default is not hardcoded at call sites because an orphaned dev
//! server silently holding the port once made every later start bind nothing —
//! while the old build kept answering, so the symptom was a 404 on a route
//! that had just been added rather than an error anyone would read as "wrong
//! process".

use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::sync::Arc;
use std::time::Duration;

use wadl_api::hardening::{self, Limits};
use wadl_domain::Clock;
use wadl_store::clock::SystemClock;
use wadl_store::InMemoryStore;

/// Builds the store: the database-backed one when the binary carries the `postgres`
/// feature AND `DATABASE_URL` is set (the migrated, seeded database is the
/// world — run `wadl migrate && wadl seed` first); the in-memory demo world
/// otherwise. Returns the store plus its banner line, so the operator can see
/// which one is answering.
// Async for the postgres connect path; compiled without that feature there is
// nothing to await, and the signature must not change with the feature set.
#[allow(clippy::unused_async)]
async fn build_store(
    clock: &Arc<dyn Clock>,
) -> std::io::Result<(Arc<dyn wadl_store::Repositories>, &'static str)> {
    #[cfg(feature = "postgres")]
    if let Ok(url) = std::env::var("DATABASE_URL") {
        let store = wadl_store::pg::PgStore::connect(&url).await.map_err(|e| {
            eprintln!("cannot connect to DATABASE_URL: {e}");
            std::io::Error::other("database connection failed")
        })?;
        if std::env::var("WADL_SCHEDULE_XER").is_ok() {
            // The boot loader is a demo-store affordance; a database's schedule
            // arrives through the import door, with identity and a ledger entry.
            eprintln!("WADL_SCHEDULE_XER is ignored with DATABASE_URL — import via the API");
        }
        return Ok((
            Arc::new(store),
            "PostgreSQL (row-level security armed per request)",
        ));
    }

    let (store, world) = InMemoryStore::demo_at(clock.now());
    // `WADL_DEMO_DOCS=<dir>` loads the hull's documents — compartment
    // register, zone chart, geometry, couplings, the morning's log — through
    // the same paths the doors use, so the served hull IS the documents and
    // the 24-space seed is only what stands in when a document is absent.
    // A `*.xer` in the directory is the schedule of record unless
    // `WADL_SCHEDULE_XER` names one explicitly.
    let mut xer_path = std::env::var("WADL_SCHEDULE_XER").ok();
    if let Ok(dir) = std::env::var("WADL_DEMO_DOCS") {
        let dir = std::path::PathBuf::from(&dir);
        let loaded = wadl_api::documents::load_demo_docs(
            &store,
            &world.yard_scope(),
            world.cvn73,
            &dir,
            clock.now().epoch_millis(),
        )
        .await
        .map_err(|e| {
            eprintln!("WADL_DEMO_DOCS {} rejected: {e}", dir.display());
            std::io::Error::other("demo documents rejected")
        })?;
        println!("demo documents from {}:", dir.display());
        if let Some((name, zone, shifts)) = &loaded.clock {
            println!("  yard clock:          {name} — {zone}, {shifts} shifts");
        }
        if let Some((name, decks, spaces)) = &loaded.register {
            println!("  register:            {name} — {spaces} spaces on {decks} decks");
        }
        if let Some((name, blocks)) = &loaded.zones {
            println!("  zone chart:          {name} — {blocks} blocks");
        }
        if let Some((name, spaces, bands)) = &loaded.geometry {
            println!("  geometry:            {name} — {spaces} surveyed, {bands} deck bands");
        }
        if let Some((name, authored, derived)) = &loaded.couplings {
            println!("  couplings:           {name} — {authored} authored, {derived} derived");
        }
        if let Some((name, raised)) = &loaded.hazards {
            println!("  field conditions:    {name} — {raised} raised");
        }
        if xer_path.is_none() {
            let mut xers: Vec<std::path::PathBuf> = std::fs::read_dir(&dir)
                .map(|rd| {
                    rd.filter_map(Result::ok)
                        .map(|e| e.path())
                        .filter(|p| p.extension().is_some_and(|x| x == "xer"))
                        .collect()
                })
                .unwrap_or_default();
            xers.sort();
            xer_path = xers
                .into_iter()
                .next()
                .map(|p| p.to_string_lossy().into_owned());
        }
    }
    // `WADL_SCHEDULE_XER=<path>` loads a real P6 export as the in-focus hull's
    // schedule of record: the register, Daily Ops, executability and the issue
    // board all serve the export instead of the generated demo rows, and the
    // reconciliation report starts saying what the export does not cover. This
    // is the seam the generator was built to survive, demonstrable end to end.
    if let Some(path) = xer_path {
        let label = std::path::Path::new(&path)
            .file_name()
            .map_or_else(|| path.clone(), |f| f.to_string_lossy().into_owned());
        let input = std::fs::read_to_string(&path).map_err(|e| {
            eprintln!("cannot read WADL_SCHEDULE_XER {path}: {e}");
            e
        })?;
        match wadl_api::schedule::load_xer(&store, world.cvn73, &label, &input) {
            Ok(loaded) => {
                println!(
                    "schedule of record: {label} — {} activities for {} · parsed in {}",
                    loaded.activities, world.cvn73, loaded.parsed_in
                );
                for finding in &loaded.wall_clock_findings {
                    println!("  wall clock:          {finding}");
                }
            }
            Err(reasons) => {
                // All-or-nothing, and refusing to start beats serving a partial
                // schedule as though it were the whole one.
                eprintln!("WADL_SCHEDULE_XER {path} rejected: {reasons}");
                return Err(std::io::Error::other("schedule of record rejected"));
            }
        }
    }
    Ok((Arc::new(store), "in-memory demo world"))
}

#[tokio::main]
async fn main() -> std::io::Result<()> {
    // `WADL_PROXY_KEY=""` is the one configuration that must not boot: it
    // reads as "proxy mode armed" to an operator and admits nothing — or,
    // before the gate learned to refuse it, everything. Failing here is
    // louder and safer than either.
    if wadl_api::auth::proxy_key_is_empty() {
        eprintln!("WADL_PROXY_KEY is set but empty — set a key, or unset it for the dev shim");
        return Err(std::io::Error::other("empty proxy key"));
    }
    let clock: Arc<dyn Clock> = Arc::new(SystemClock);
    let (store, store_banner) = build_store(&clock).await?;

    let state = wadl_api::AppState::new(store, Arc::clone(&clock));
    let mut app = wadl_api::build_router(state);

    // With a built shell on disk, this binary is the whole product.
    if let Ok(dist) = std::env::var("WADL_STATIC_DIR") {
        let dist = std::path::PathBuf::from(dist);
        if !dist.join("index.html").is_file() {
            eprintln!(
                "WADL_STATIC_DIR {} has no index.html — is it a built dist?",
                dist.display()
            );
            return Err(std::io::Error::other("static dir rejected"));
        }
        println!("serving shell from {}", dist.display());
        app = hardening::static_site(app, dist);
    }

    // Anything unparseable falls back rather than failing to start: a typo in
    // an env var should not look like a broken binary.
    let defaults = Limits::default();
    let limits = Limits {
        max_in_flight: env_parse("WADL_MAX_IN_FLIGHT").unwrap_or(defaults.max_in_flight),
        request_timeout: env_parse("WADL_REQUEST_TIMEOUT_SECS")
            .map_or(defaults.request_timeout, Duration::from_secs),
    };
    let app = hardening::harden(app, limits, Arc::clone(&clock));

    let port: u16 = env_parse("WADL_PORT").unwrap_or(8080);
    let bind: IpAddr = env_parse("WADL_BIND").unwrap_or(IpAddr::V4(Ipv4Addr::LOCALHOST));

    // Print the demo identity so an operator can set the dev-shim headers,
    // and which trust boundary is armed so nobody has to guess from behavior.
    let identity = if std::env::var("WADL_PROXY_KEY").is_ok() {
        "proxy-asserted — identity headers accepted only with x-wadl-proxy-key"
    } else {
        "dev header shim — identity headers trusted as given (loopback only)"
    };
    // The seeded identity below is identical in both stores by construction —
    // `wadl seed` writes the same world the demo store builds in memory.
    println!("Shipyard AI Onboard — API on http://{bind}:{port}");
    println!("  store:               {store_banner}");
    println!("  identity trust:      {identity}");
    println!("  x-org-id:            00000000-0000-0000-0000-000000000001");
    println!(
        "  x-assigned-vessels:  00000000-0000-0000-0000-000000000073,\
         00000000-0000-0000-0000-000000000071,00000000-0000-0000-0000-000000000075"
    );
    println!("  try: GET /api/vessels");

    let addr = SocketAddr::from((bind, port));
    // Reported rather than swallowed: "address in use" is the one startup
    // failure a developer needs to see, and it used to be invisible.
    let listener = tokio::net::TcpListener::bind(addr).await.map_err(|e| {
        eprintln!("cannot bind {addr}: {e}");
        e
    })?;
    // Graceful shutdown: in-flight requests finish, then the process exits —
    // so a deploy or a `systemctl stop` never truncates an import mid-commit.
    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await
}

/// Parses an env var, treating "unset" and "unparseable" the same way: use
/// the default. The one thing this must never do is panic at startup.
fn env_parse<T: std::str::FromStr>(name: &str) -> Option<T> {
    std::env::var(name).ok().and_then(|v| v.parse().ok())
}

/// Resolves when the process is asked to stop: Ctrl-C anywhere, SIGTERM on
/// unix (what systemd and container runtimes actually send).
async fn shutdown_signal() {
    let ctrl_c = async {
        // If the signal handler cannot install, waiting forever is the honest
        // fallback — the process still stops on SIGKILL, and starting a server
        // that cannot be politely stopped beats not starting at all.
        if tokio::signal::ctrl_c().await.is_err() {
            std::future::pending::<()>().await;
        }
    };
    #[cfg(unix)]
    let term = async {
        match tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
            Ok(mut s) => {
                s.recv().await;
            }
            Err(_) => std::future::pending().await,
        }
    };
    #[cfg(not(unix))]
    let term = std::future::pending::<()>();
    tokio::select! {
        () = ctrl_c => {},
        () = term => {},
    }
    println!("shutdown requested — draining in-flight requests");
}
