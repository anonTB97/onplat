//! Test support: the API app over the memory store or PostgreSQL, chosen at
//! runtime by `DATABASE_URL`, so the suites that boot the reference hull run
//! on both.
//!
//! **Reset strategy on PostgreSQL: a fresh hull per test, never a reset.**
//! [`reference_hull`] mints a v7 hull under the yard tenant (hull number
//! `T-<8 hex>`), applies the hull-row statement through `bootstrap_hull`,
//! loads `reference/cvn73` and the full export onto it through the same
//! loader the CLI and the boot path use, and points the world's `cvn73` at
//! it. Documents, hazards, the schedule and the ledger are all per hull, so
//! tests run in parallel with no `TRUNCATE`, no per-test database and no
//! ordering. A developer's database accumulates `T-…` hulls; the module
//! prints the hull number so an owner session can drop them.
//!
//! `DATABASE_URL` set and the crate built with `--features postgres` →
//! PostgreSQL; set without the feature → memory, with one printed line;
//! unset → memory. [`seed_world`] is always the memory demo world — the
//! 24-space story the seed-dependent suites assert on.

// A test-support module compiled into each test binary that declares it:
// not every binary uses every helper, and `pub` here is the module's API.
#![allow(
    dead_code,
    unreachable_pub,
    clippy::doc_markdown,
    clippy::unused_async,
    clippy::indexing_slicing,
    clippy::expect_used,
    clippy::panic
)]

use std::path::{Path, PathBuf};
use std::sync::{Arc, Once};

use axum::body::Body;
use axum::http::{Method, Request, StatusCode};
use serde_json::Value;
use tower::ServiceExt;
use wadl_api::documents::{self, LoadVia, LoadedDocuments};
use wadl_api::schedule::{self, XerLoad};
use wadl_domain::time::{TestClock, Timestamp};
use wadl_store::memory::{DemoWorld, InMemoryStore, DEMO_ANCHOR_MS};
use wadl_store::{Actor, Repositories, TenantScope};

/// Which store answers.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Backend {
    Memory,
    Postgres,
}

/// The `via` every row a test loads carries.
pub const VIA: &str = "test";

/// An app, its world and its store.
pub struct TestWorld {
    pub app: axum::Router,
    pub world: DemoWorld,
    pub store: Arc<dyn Repositories>,
    pub backend: Backend,
    /// What [`reference_hull`] loaded; empty for [`seed_world`] and
    /// [`empty_hull`].
    pub loaded: LoadedDocuments,
}

pub fn docs_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../reference/cvn73")
}

pub fn full_xer() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../reference/p6-sample/CVN73-PIA26-full.xer")
}

fn anchor() -> Timestamp {
    Timestamp::from_epoch_millis(DEMO_ANCHOR_MS)
}

/// The backend `DATABASE_URL` and the feature set select, announced once.
pub fn backend() -> Backend {
    static ONCE: Once = Once::new();
    let url = std::env::var("DATABASE_URL")
        .ok()
        .filter(|u| !u.trim().is_empty());
    let chosen = match url {
        Some(_) if cfg!(feature = "postgres") => Backend::Postgres,
        Some(_) => {
            ONCE.call_once(|| {
                eprintln!("DATABASE_URL set but wadl-api built without --features postgres; running on memory");
            });
            Backend::Memory
        }
        None => Backend::Memory,
    };
    ONCE.call_once(|| {
        eprintln!(
            "backend: {}",
            match chosen {
                Backend::Postgres => "postgresql",
                Backend::Memory => "memory",
            }
        );
    });
    chosen
}

fn router(store: &Arc<dyn Repositories>) -> axum::Router {
    let clock = TestClock::new(anchor());
    wadl_api::build_router(wadl_api::AppState::new(store.clone(), Arc::new(clock)))
}

/// The memory demo world at the anchor — the 24-space story, always.
pub async fn seed_world() -> TestWorld {
    let (store, world) = InMemoryStore::demo_at(anchor());
    let store: Arc<dyn Repositories> = Arc::new(store);
    TestWorld {
        app: router(&store),
        world,
        store,
        backend: Backend::Memory,
        loaded: LoadedDocuments::default(),
    }
}

/// A hull with no documents loaded: the demo world on memory, a freshly
/// bootstrapped hull on PostgreSQL. For tests that load their own files.
pub async fn empty_hull() -> TestWorld {
    let (store, world, backend) = fresh_store().await;
    TestWorld {
        app: router(&store),
        world,
        store,
        backend,
        loaded: LoadedDocuments::default(),
    }
}

/// The reference hull through the loader — `reference/cvn73` and the full
/// export, `via: test` — on the backend `DATABASE_URL` selects.
pub async fn reference_hull() -> TestWorld {
    let (store, world, backend) = fresh_store().await;
    let scope = world.yard_scope().with_actor(Actor::system(VIA));
    let loaded = documents::load_docs(
        store.as_ref(),
        &scope,
        world.cvn73,
        &docs_dir(),
        DEMO_ANCHOR_MS,
        LoadVia {
            via: VIA,
            dry_run: false,
        },
    )
    .await
    .unwrap_or_else(|e| panic!("the reference hull loads through the doors: {e}"));
    let bytes = std::fs::read(full_xer()).expect("the reference export is in the tree");
    schedule::commit_xer(
        store.as_ref(),
        &scope,
        world.cvn73,
        XerLoad {
            label: "CVN73-PIA26-full.xer",
            bytes: &bytes,
            via: VIA,
            now_ms: DEMO_ANCHOR_MS,
            dry_run: false,
        },
    )
    .await
    .unwrap_or_else(|e| panic!("the reference export commits: {e}"));
    TestWorld {
        app: router(&store),
        world,
        store,
        backend,
        loaded,
    }
}

/// The store and world for a fresh hull on the selected backend.
async fn fresh_store() -> (Arc<dyn Repositories>, DemoWorld, Backend) {
    match backend() {
        Backend::Memory => {
            let (store, world) = InMemoryStore::demo_at(anchor());
            (Arc::new(store), world, Backend::Memory)
        }
        Backend::Postgres => {
            #[cfg(feature = "postgres")]
            {
                let (store, world) = postgres::fresh_hull().await;
                (store, world, Backend::Postgres)
            }
            #[cfg(not(feature = "postgres"))]
            {
                unreachable!("Backend::Postgres is only chosen with the postgres feature")
            }
        }
    }
}

#[cfg(feature = "postgres")]
mod postgres {
    use super::{Arc, DemoWorld, InMemoryStore, Repositories, DEMO_ANCHOR_MS};
    use uuid::Uuid;
    use wadl_domain::ids::VesselId;
    use wadl_store::model::HullStatement;
    use wadl_store::pg::PgStore;

    /// The seed's yard tenant and class; `existed` on a seeded database,
    /// `created` on a freshly migrated one.
    const YARD_ORG: Uuid = Uuid::from_u128(0x01);

    /// A new hull under the yard tenant, bootstrapped, with the memory
    /// world's ids for everything else so `world.yard_org` and the headers
    /// read the same as on memory.
    pub(super) async fn fresh_hull() -> (Arc<dyn Repositories>, DemoWorld) {
        let url = std::env::var("DATABASE_URL").expect("DATABASE_URL");
        let store = PgStore::connect(&url)
            .await
            .expect("connects to DATABASE_URL");
        let hull = Uuid::now_v7();
        let hull_no = format!("T-{}", &hull.simple().to_string()[24..]);
        let statement: HullStatement = serde_json::from_value(serde_json::json!({
            "organization": { "org_id": YARD_ORG, "kind": "shipbuilder", "name": "Demo Yard", "country": "USA" },
            "class": { "class_id": Uuid::from_u128(0xC0068), "code": "CVN-68", "name": "Nimitz class", "hull_type": "CVN", "frame_min": 1, "frame_max": 260 },
            "vessel": { "vessel_id": hull, "hull_no": hull_no, "name": "Test hull" },
            "availability": { "availability_id": Uuid::now_v7(), "code": "T-26", "kind": "PIA", "location": "Test dock", "start_on": "2026-01-05", "end_on": "2026-09-30" }
        }))
        .expect("the test statement is well formed");
        store
            .bootstrap_hull(&statement, "test-support.json", false, DEMO_ANCHOR_MS)
            .await
            .expect("the test hull bootstraps");
        eprintln!("test hull {hull_no} ({hull}) bootstrapped");
        let (_, mut world) = InMemoryStore::demo_at(super::anchor());
        world.cvn73 = VesselId::from_uuid(hull);
        (Arc::new(store), world)
    }
}

impl TestWorld {
    /// The scope a test loads under: the yard's, on the binary's test account.
    pub fn scope(&self) -> TenantScope {
        self.world.yard_scope().with_actor(Actor::system(VIA))
    }

    /// `method` on `/api/vessels/<hull><path>` under the hull's headers.
    pub async fn call(
        &self,
        method: Method,
        path_under_hull: &str,
        body: Option<Value>,
    ) -> (StatusCode, Value) {
        let uri = format!(
            "/api/vessels/{}{path_under_hull}",
            self.world.cvn73.as_uuid()
        );
        self.request(method, &uri, body).await
    }

    /// `GET /api/vessels/<hull><path>`.
    pub async fn get(&self, path_under_hull: &str) -> (StatusCode, Value) {
        self.call(Method::GET, path_under_hull, None).await
    }

    /// `GET <path>` at the root, under the hull's headers (`/health` ignores
    /// them).
    pub async fn get_root(&self, path: &str) -> (StatusCode, Value) {
        self.request(Method::GET, path, None).await
    }

    async fn request(&self, method: Method, uri: &str, body: Option<Value>) -> (StatusCode, Value) {
        let mut request = Request::builder()
            .method(method)
            .uri(uri)
            .header("x-org-id", self.world.yard_org.as_uuid().to_string())
            .header("x-assigned-vessels", self.world.cvn73.as_uuid().to_string());
        if body.is_some() {
            request = request.header("content-type", "application/json");
        }
        let request = request
            .body(body.map_or_else(Body::empty, |b| Body::from(b.to_string())))
            .expect("a well-formed request");
        let response = self
            .app
            .clone()
            .oneshot(request)
            .await
            .expect("the router answers");
        let status = response.status();
        let bytes = axum::body::to_bytes(response.into_body(), 1 << 26)
            .await
            .expect("a readable body");
        (
            status,
            serde_json::from_slice(&bytes).unwrap_or(Value::Null),
        )
    }
}
