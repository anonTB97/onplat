//! Schedule runs on the in-memory store: one write records the run and
//! serves it, the served pointer follows a serve-prior-run, a revert keeps
//! history, and the document cap drops rows but never a run.

#![allow(
    missing_docs,
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]

use uuid::Uuid;
use wadl_store::memory::{FieldMapDoc, InMemoryStore, ScheduleOfRecord, MAX_RUN_DOCS};
use wadl_store::model::{
    ActivityStatus, ActivitySummary, ImportedBy, Reliability, RunCounts, ScheduleRun,
    ScheduleRunReport, ScheduleRunSummary,
};
use wadl_store::{Repositories as _, StoreError, TenantScope};

fn run_named(label: &str, code: &str, at_ms: i64) -> ScheduleRun {
    ScheduleRun {
        summary: ScheduleRunSummary {
            run_id: Uuid::nil(),
            seq: 0,
            label: label.to_owned(),
            imported_at_ms: at_ms,
            imported_by: ImportedBy {
                org: wadl_domain::ids::OrgId::from_uuid(Uuid::from_u128(1)),
                person: None,
                via: "boot".to_owned(),
            },
            encoding: "utf-8".to_owned(),
            decoded_by: "server".to_owned(),
            projects_served: vec![],
            counts: RunCounts::default(),
            field_map: serde_json::json!({}),
            served: false,
            schema_version: 0,
        },
        report: ScheduleRunReport::default(),
        doc: Some(ScheduleOfRecord {
            label: label.to_owned(),
            activities: vec![ActivitySummary {
                activity_id: wadl_domain::ids::ActivityId::from_uuid(Uuid::from_u128(0xA1)),
                code: code.to_owned(),
                name: code.to_owned(),
                work_order_code: None,
                compartment_no: None,
                compartment_reliability: Reliability::Low,
                wbs_area: None,
                trade: String::new(),
                planned: None,
                budget_hours: wadl_domain::units::ManHours::ZERO,
                earned_hours: wadl_domain::units::ManHours::ZERO,
                status: ActivityStatus::NotStarted,
                is_milestone: false,
                source_ref: format!("{label} · {code}"),
                work_type: None,
            }],
            edges: vec![],
            parsed_in: None,
        }),
    }
}

#[tokio::test]
async fn every_commit_is_a_run_and_the_served_pointer_moves() {
    let (store, world) = InMemoryStore::demo();
    let scope = TenantScope::new(world.yard_org, [world.cvn73]);
    assert!(store
        .served_schedule_run(&scope, world.cvn73)
        .await
        .unwrap()
        .is_none());
    assert!(store
        .list_schedule_runs(&scope, world.cvn73)
        .await
        .unwrap()
        .is_empty());

    let first = store
        .commit_schedule_run(&scope, world.cvn73, run_named("a.xer", "A1", 1_000))
        .await
        .unwrap();
    let second = store
        .commit_schedule_run(&scope, world.cvn73, run_named("b.xer", "B1", 2_000))
        .await
        .unwrap();
    assert_eq!((first.seq, second.seq), (1, 2));
    assert_ne!(first.run_id, second.run_id);
    assert!(second.served);
    let runs = store.list_schedule_runs(&scope, world.cvn73).await.unwrap();
    assert_eq!(runs.len(), 2, "newest first");
    assert_eq!(runs[0].seq, 2);
    assert!(runs[0].served && !runs[1].served);
    assert_eq!(
        store.list_activities(&scope, world.cvn73).await.unwrap()[0].code,
        "B1"
    );

    // Another hull on the same tenant has its own history and pointer.
    let other = TenantScope::new(world.yard_org, [world.cvn71]);
    assert!(store
        .list_schedule_runs(&other, world.cvn71)
        .await
        .unwrap()
        .is_empty());
    assert!(matches!(
        store.schedule_run(&other, world.cvn73, first.run_id).await,
        Err(StoreError::NotFound)
    ));
}

#[tokio::test]
async fn serving_a_prior_run_moves_the_pointer_and_a_revert_keeps_history() {
    let (store, world) = InMemoryStore::demo();
    let scope = TenantScope::new(world.yard_org, [world.cvn73]);
    let first = store
        .commit_schedule_run(&scope, world.cvn73, run_named("a.xer", "A1", 1_000))
        .await
        .unwrap();
    store
        .commit_schedule_run(&scope, world.cvn73, run_named("b.xer", "B1", 2_000))
        .await
        .unwrap();

    // Serve the prior run: pointer and register follow; nothing new recorded.
    let served = store
        .serve_schedule_run(&scope, world.cvn73, first.run_id)
        .await
        .unwrap();
    assert!(served.served && served.seq == 1);
    assert_eq!(
        store
            .served_schedule_run(&scope, world.cvn73)
            .await
            .unwrap()
            .unwrap()
            .run_id,
        first.run_id
    );
    assert_eq!(
        store.list_activities(&scope, world.cvn73).await.unwrap()[0].code,
        "A1"
    );
    assert_eq!(
        store
            .list_schedule_runs(&scope, world.cvn73)
            .await
            .unwrap()
            .len(),
        2
    );
    assert_eq!(
        store
            .schedule_source(&scope, world.cvn73)
            .await
            .unwrap()
            .as_deref(),
        Some("a.xer")
    );

    // Revert to the generated register: the runs stay, the pointer clears.
    store
        .clear_schedule_of_record(&scope, world.cvn73)
        .await
        .unwrap();
    assert!(store
        .served_schedule_run(&scope, world.cvn73)
        .await
        .unwrap()
        .is_none());
    assert_eq!(
        store
            .list_schedule_runs(&scope, world.cvn73)
            .await
            .unwrap()
            .len(),
        2
    );
    assert!(store
        .schedule_source(&scope, world.cvn73)
        .await
        .unwrap()
        .is_none());

    // A run without its document is refused, not recorded.
    let mut bare = run_named("c.xer", "C1", 3_000);
    bare.doc = None;
    assert!(matches!(
        store.commit_schedule_run(&scope, world.cvn73, bare).await,
        Err(StoreError::Backend(_))
    ));
    assert_eq!(
        store
            .list_schedule_runs(&scope, world.cvn73)
            .await
            .unwrap()
            .len(),
        2
    );
}

#[tokio::test]
async fn the_document_cap_drops_rows_but_never_a_run() {
    let (store, world) = InMemoryStore::demo();
    let scope = TenantScope::new(world.yard_org, [world.cvn73]);
    let mut ids = Vec::new();
    for i in 0..=MAX_RUN_DOCS {
        let n = i64::try_from(i).unwrap();
        let summary = store
            .commit_schedule_run(&scope, world.cvn73, run_named(&format!("{i}.xer"), "X", n))
            .await
            .unwrap();
        ids.push(summary.run_id);
    }
    let runs = store.list_schedule_runs(&scope, world.cvn73).await.unwrap();
    assert_eq!(runs.len(), MAX_RUN_DOCS + 1, "every run is listed");
    let oldest = store
        .schedule_run(&scope, world.cvn73, ids[0])
        .await
        .unwrap()
        .unwrap();
    assert!(oldest.doc.is_none(), "rows dropped");
    assert_eq!(oldest.summary.label, "0.xer", "summary kept");
    let newest = store
        .schedule_run(&scope, world.cvn73, ids[MAX_RUN_DOCS])
        .await
        .unwrap()
        .unwrap();
    assert!(newest.doc.is_some());
    assert!(matches!(
        store.serve_schedule_run(&scope, world.cvn73, ids[0]).await,
        Err(StoreError::Backend(_))
    ));
    assert!(store
        .serve_schedule_run(&scope, world.cvn73, ids[1])
        .await
        .is_ok());
}

#[tokio::test]
async fn the_field_map_document_round_trips_and_boot_reads_it_unscoped() {
    let (store, world) = InMemoryStore::demo();
    let scope = TenantScope::new(world.yard_org, [world.cvn73]);
    assert!(store
        .field_map(&scope, world.cvn73)
        .await
        .unwrap()
        .is_none());
    assert!(store.field_map_of(world.cvn73).is_none());
    let doc = FieldMapDoc {
        label: "CVN73-fieldmap.json".to_owned(),
        map: serde_json::json!({ "compartment": { "source": "udf", "name": "COMPT" } }),
    };
    store
        .set_field_map(&scope, world.cvn73, doc.clone())
        .await
        .unwrap();
    assert_eq!(
        store.field_map(&scope, world.cvn73).await.unwrap(),
        Some(doc.clone())
    );
    assert_eq!(store.field_map_of(world.cvn73), Some(doc.clone()));
    let navy = TenantScope::new(world.navy_org, [world.cvn73]);
    assert!(matches!(
        store.field_map(&navy, world.cvn73).await,
        Err(StoreError::NotFound)
    ));
    store.clear_field_map(&scope, world.cvn73).await.unwrap();
    assert!(store
        .field_map(&scope, world.cvn73)
        .await
        .unwrap()
        .is_none());
}
