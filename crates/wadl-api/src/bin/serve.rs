//! Development server: serves the seeded demo world on loopback.
//!
//! Milestone-1 convenience only — it wires the in-memory demo store behind the
//! router so the shell (and `curl`) have something to talk to. Production wiring
//! passes a PostgreSQL-backed store and real session identity. No outbound
//! connections; it binds loopback and waits.
//!
//! The port comes from `WADL_PORT`, defaulting to 8080. Hardcoded, it meant an
//! orphaned dev server silently held the port and every later start bound
//! nothing — while the old build kept answering, so the symptom was a 404 on a
//! route that had just been added rather than an error anyone would read as
//! "wrong process".

use std::net::SocketAddr;
use std::sync::Arc;

use wadl_domain::Clock;
use wadl_store::clock::SystemClock;
use wadl_store::InMemoryStore;

#[tokio::main]
async fn main() -> std::io::Result<()> {
    let clock = SystemClock;
    let (store, world) = InMemoryStore::demo_at(clock.now());

    // `WADL_SCHEDULE_XER=<path>` loads a real P6 export as the in-focus hull's
    // schedule of record: the register, Daily Ops, executability and the issue
    // board all serve the export instead of the generated demo rows, and the
    // reconciliation report starts saying what the export does not cover. This
    // is the seam the generator was built to survive, demonstrable end to end.
    if let Ok(path) = std::env::var("WADL_SCHEDULE_XER") {
        let label = std::path::Path::new(&path)
            .file_name()
            .map_or_else(|| path.clone(), |f| f.to_string_lossy().into_owned());
        let input = std::fs::read_to_string(&path).map_err(|e| {
            eprintln!("cannot read WADL_SCHEDULE_XER {path}: {e}");
            e
        })?;
        match wadl_api::schedule::load_xer(&store, world.cvn73, &label, &input) {
            Ok(count) => {
                println!(
                    "schedule of record: {label} — {count} activities for {}",
                    world.cvn73
                );
            }
            Err(reasons) => {
                // All-or-nothing, and refusing to start beats serving a partial
                // schedule as though it were the whole one.
                eprintln!("WADL_SCHEDULE_XER {path} rejected: {reasons}");
                return Err(std::io::Error::other("schedule of record rejected"));
            }
        }
    }

    let state = wadl_api::AppState::new(Arc::new(store), Arc::new(clock));
    let app = wadl_api::build_router(state);

    // Anything unparseable falls back rather than failing to start: a typo in an
    // env var should not look like a broken binary.
    let port: u16 = std::env::var("WADL_PORT")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(8080);

    // Print the demo identity so an operator can set the dev-shim headers.
    println!("Shipyard AI Onboard — demo API on http://127.0.0.1:{port}");
    println!("  x-org-id:            {}", world.yard_org);
    println!(
        "  x-assigned-vessels:  {},{},{}",
        world.cvn73, world.cvn71, world.cvn75
    );
    println!("  try: GET /api/vessels");

    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    // Reported rather than swallowed: "address in use" is the one startup failure
    // a developer needs to see, and it is the one that used to be invisible.
    let listener = tokio::net::TcpListener::bind(addr).await.map_err(|e| {
        eprintln!("cannot bind 127.0.0.1:{port}: {e}");
        e
    })?;
    axum::serve(listener, app).await
}
