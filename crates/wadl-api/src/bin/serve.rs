//! Development server: serves the seeded demo world on `127.0.0.1:8080`.
//!
//! Milestone-1 convenience only — it wires the in-memory demo store behind the
//! router so the shell (and `curl`) have something to talk to. Production wiring
//! passes a PostgreSQL-backed store and real session identity. No outbound
//! connections; it binds loopback and waits.

use std::net::SocketAddr;

use wadl_api::demo_app;

#[tokio::main]
async fn main() -> std::io::Result<()> {
    let (app, world) = demo_app();

    // Print the demo identity so an operator can set the dev-shim headers.
    println!("Shipyard AI Onboard — demo API on http://127.0.0.1:8080");
    println!("  x-org-id:            {}", world.yard_org);
    println!(
        "  x-assigned-vessels:  {},{},{}",
        world.cvn73, world.cvn71, world.cvn75
    );
    println!("  try: GET /api/vessels");

    let addr = SocketAddr::from(([127, 0, 0, 1], 8080));
    let listener = tokio::net::TcpListener::bind(addr).await?;
    axum::serve(listener, app).await
}
