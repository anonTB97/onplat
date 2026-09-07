//! Owner-mode operations on PostgreSQL: the writes an operator's session
//! makes outside any tenant scope, because row-level security forbids the
//! application role from creating a tenant — the same reason `seed_demo`
//! runs as the connecting role.
//!
//! Today: [`PgStore::bootstrap_hull`], the hull-row statement
//! `docs/pilot-playbook.md` §1 files, applied as one transaction and
//! ledgered on the hull it creates.

use sqlx::{Postgres, Transaction};
use uuid::Uuid;

use wadl_domain::ids::{OrgId, VesselId};

use crate::error::StoreError;
use crate::model::{BootstrapOutcome, HullStatement, RowOutcome};
use crate::pg::PgStore;
use crate::scope::{Actor, TenantScope};

/// The ledger action a hull-row statement writes on the hull it created.
pub const HULL_BOOTSTRAPPED: &str = "HULL_BOOTSTRAPPED";

/// The `source_system` the provenance row carries.
const SOURCE_SYSTEM: &str = "bootstrap";

impl PgStore {
    /// Applies a hull-row statement: organisation, class, hull and
    /// availability, in FK order, each `created` or `existed` by primary key.
    /// A natural-key clash under a *different* id — the same hull number or
    /// class code already there with another uuid, or an id that belongs to
    /// another tenant — is [`StoreError::Conflict`] and rolls everything
    /// back: a second statement for the same hull with a new id is a
    /// mistake, not an update.
    ///
    /// When anything was created, the same transaction writes an
    /// `ingest_run` provenance row (`source_system: bootstrap`, the statement
    /// file's name) and — switching to the application role under the new
    /// tenant, through the ledger's own chain logic — the hull's first ledger
    /// row, `HULL_BOOTSTRAPPED`, whose detail carries the statement, the
    /// per-row outcome, `via: cli` and the instant. A statement whose four
    /// rows all exist writes nothing and no ledger row. A `dry_run` reports
    /// `would create` and writes nothing.
    ///
    /// Runs as the **connecting role outside any tenant scope**.
    ///
    /// # Errors
    /// [`StoreError::Conflict`] for a statement that does not validate or
    /// that clashes as above (nothing written); [`StoreError::Backend`] on
    /// any statement failure.
    pub async fn bootstrap_hull(
        &self,
        statement: &HullStatement,
        source_file: &str,
        dry_run: bool,
        now_ms: i64,
    ) -> Result<BootstrapOutcome, StoreError> {
        let problems = statement.validate();
        if !problems.is_empty() {
            return Err(StoreError::Conflict(format!(
                "the statement does not validate: {}",
                problems.join("; ")
            )));
        }
        let mut tx = self.pool().begin().await?;
        let organization = organization_row(&mut tx, statement, dry_run).await?;
        let class = class_row(&mut tx, statement, dry_run).await?;
        let vessel = vessel_row(&mut tx, statement, dry_run).await?;
        let availability = availability_row(&mut tx, statement, dry_run).await?;
        let mut outcome = BootstrapOutcome {
            organization,
            class,
            vessel,
            availability,
            ledger_seq: None,
            dry_run,
        };
        if dry_run || !outcome.changes_anything() {
            tx.rollback().await?;
            return Ok(outcome);
        }
        let org = OrgId::from_uuid(statement.organization.org_id);
        let hull = VesselId::from_uuid(statement.vessel.vessel_id);
        let occurred_at = chrono::DateTime::from_timestamp_millis(now_ms)
            .ok_or_else(|| StoreError::Backend("instant out of range".to_owned()))?;
        sqlx::query(
            "INSERT INTO ingest_run (org_id, vessel_id, source_system, source_file, started_at, finished_at, notes)
             VALUES ($1, $2, $3, $4, $5, $5, 'hull-row statement applied by wadl bootstrap-hull')",
        )
        .bind(org.as_uuid())
        .bind(hull.as_uuid())
        .bind(SOURCE_SYSTEM)
        .bind(source_file)
        .bind(occurred_at)
        .execute(&mut *tx)
        .await?;
        // The ledger row is written as the application role under the new
        // tenant, inside this transaction, so it chains exactly like a row
        // the API writes — and so the hull's first row exists only if the
        // hull does.
        sqlx::query("SET LOCAL ROLE wadl_app")
            .execute(&mut *tx)
            .await?;
        sqlx::query("SELECT set_config('app.org_id', $1, true)")
            .bind(org.as_uuid().to_string())
            .execute(&mut *tx)
            .await?;
        let scope = TenantScope::new(org, [hull]).with_actor(Actor::system("cli"));
        let detail = serde_json::json!({
            "statement": statement,
            "outcome": {
                "organization": outcome.organization,
                "class": outcome.class,
                "vessel": outcome.vessel,
                "availability": outcome.availability,
            },
            "via": "cli",
            "by_org": org.to_string(),
            "at_ms": now_ms,
        });
        let detail = serde_json::to_string(&detail).unwrap_or_default();
        let record = crate::pg_repo::append_audit_in(
            &mut tx,
            &scope,
            hull,
            HULL_BOOTSTRAPPED,
            &detail,
            None,
            now_ms,
        )
        .await?;
        tx.commit().await?;
        outcome.ledger_seq = Some(record.seq);
        Ok(outcome)
    }
}

/// The tenant row, by `org_id`.
async fn organization_row(
    tx: &mut Transaction<'_, Postgres>,
    s: &HullStatement,
    dry_run: bool,
) -> Result<RowOutcome, StoreError> {
    let present: Option<Uuid> =
        sqlx::query_scalar("SELECT org_id FROM organization WHERE org_id = $1")
            .bind(s.organization.org_id)
            .fetch_optional(&mut **tx)
            .await?;
    if present.is_some() {
        return Ok(RowOutcome::Existed);
    }
    if dry_run {
        return Ok(RowOutcome::WouldCreate);
    }
    sqlx::query(
        "INSERT INTO organization (org_id, kind, name, country) VALUES ($1, $2::org_kind, $3, $4)",
    )
    .bind(s.organization.org_id)
    .bind(&s.organization.kind)
    .bind(&s.organization.name)
    .bind(&s.organization.country)
    .execute(&mut **tx)
    .await?;
    Ok(RowOutcome::Created)
}

/// The class row: by `class_id` (which must belong to the statement's
/// tenant), else refused when `(org_id, code)` names another id.
async fn class_row(
    tx: &mut Transaction<'_, Postgres>,
    s: &HullStatement,
    dry_run: bool,
) -> Result<RowOutcome, StoreError> {
    let owner: Option<Uuid> =
        sqlx::query_scalar("SELECT org_id FROM ship_class WHERE class_id = $1")
            .bind(s.class.class_id)
            .fetch_optional(&mut **tx)
            .await?;
    if let Some(owner) = owner {
        return if owner == s.organization.org_id {
            Ok(RowOutcome::Existed)
        } else {
            Err(StoreError::Conflict(format!(
                "class {}: class_id names a class in another tenant",
                s.class.code
            )))
        };
    }
    let clash: Option<Uuid> =
        sqlx::query_scalar("SELECT class_id FROM ship_class WHERE org_id = $1 AND code = $2")
            .bind(s.organization.org_id)
            .bind(&s.class.code)
            .fetch_optional(&mut **tx)
            .await?;
    if clash.is_some() {
        return Err(StoreError::Conflict(format!(
            "class {} already exists in this tenant under a different id — a second statement for the same class with a new id is a mistake, not an update",
            s.class.code
        )));
    }
    if dry_run {
        return Ok(RowOutcome::WouldCreate);
    }
    sqlx::query(
        "INSERT INTO ship_class (class_id, org_id, code, name, hull_type, frame_min, frame_max)
         VALUES ($1, $2, $3, $4, $5, $6, $7)",
    )
    .bind(s.class.class_id)
    .bind(s.organization.org_id)
    .bind(&s.class.code)
    .bind(&s.class.name)
    .bind(&s.class.hull_type)
    .bind(s.class.frame_min)
    .bind(s.class.frame_max)
    .execute(&mut **tx)
    .await?;
    Ok(RowOutcome::Created)
}

/// The hull row: by `vessel_id` (which must belong to the statement's
/// tenant), else refused when `(org_id, hull_no)` names another id.
async fn vessel_row(
    tx: &mut Transaction<'_, Postgres>,
    s: &HullStatement,
    dry_run: bool,
) -> Result<RowOutcome, StoreError> {
    let owner: Option<Uuid> = sqlx::query_scalar("SELECT org_id FROM vessel WHERE vessel_id = $1")
        .bind(s.vessel.vessel_id)
        .fetch_optional(&mut **tx)
        .await?;
    if let Some(owner) = owner {
        return if owner == s.organization.org_id {
            Ok(RowOutcome::Existed)
        } else {
            Err(StoreError::Conflict(format!(
                "hull {}: vessel_id names a hull in another tenant",
                s.vessel.hull_no
            )))
        };
    }
    let clash: Option<Uuid> =
        sqlx::query_scalar("SELECT vessel_id FROM vessel WHERE org_id = $1 AND hull_no = $2")
            .bind(s.organization.org_id)
            .bind(&s.vessel.hull_no)
            .fetch_optional(&mut **tx)
            .await?;
    if clash.is_some() {
        return Err(StoreError::Conflict(format!(
            "hull {} already exists in this tenant under a different id — a second statement for the same hull number with a new id is a mistake, not an update",
            s.vessel.hull_no
        )));
    }
    if dry_run {
        return Ok(RowOutcome::WouldCreate);
    }
    sqlx::query(
        "INSERT INTO vessel (vessel_id, org_id, class_id, hull_no, name) VALUES ($1, $2, $3, $4, $5)",
    )
    .bind(s.vessel.vessel_id)
    .bind(s.organization.org_id)
    .bind(s.class.class_id)
    .bind(&s.vessel.hull_no)
    .bind(&s.vessel.name)
    .execute(&mut **tx)
    .await?;
    Ok(RowOutcome::Created)
}

/// The availability row: by `availability_id` (which must be on the
/// statement's hull), else refused when `(vessel_id, code)` names another id.
async fn availability_row(
    tx: &mut Transaction<'_, Postgres>,
    s: &HullStatement,
    dry_run: bool,
) -> Result<RowOutcome, StoreError> {
    let on_hull: Option<Uuid> =
        sqlx::query_scalar("SELECT vessel_id FROM availability WHERE availability_id = $1")
            .bind(s.availability.availability_id)
            .fetch_optional(&mut **tx)
            .await?;
    if let Some(on_hull) = on_hull {
        return if on_hull == s.vessel.vessel_id {
            Ok(RowOutcome::Existed)
        } else {
            Err(StoreError::Conflict(format!(
                "availability {}: availability_id names an availability on another hull",
                s.availability.code
            )))
        };
    }
    let clash: Option<Uuid> = sqlx::query_scalar(
        "SELECT availability_id FROM availability WHERE vessel_id = $1 AND code = $2",
    )
    .bind(s.vessel.vessel_id)
    .bind(&s.availability.code)
    .fetch_optional(&mut **tx)
    .await?;
    if clash.is_some() {
        return Err(StoreError::Conflict(format!(
            "availability {} already exists on hull {} under a different id",
            s.availability.code, s.vessel.hull_no
        )));
    }
    if dry_run {
        return Ok(RowOutcome::WouldCreate);
    }
    let start_on = civil_date(&s.availability.start_on)?;
    let end_on = civil_date(&s.availability.end_on)?;
    sqlx::query(
        "INSERT INTO availability (availability_id, vessel_id, code, kind, location, start_on, end_on)
         VALUES ($1, $2, $3, $4, $5, $6, $7)",
    )
    .bind(s.availability.availability_id)
    .bind(s.vessel.vessel_id)
    .bind(&s.availability.code)
    .bind(&s.availability.kind)
    .bind(&s.availability.location)
    .bind(start_on)
    .bind(end_on)
    .execute(&mut **tx)
    .await?;
    Ok(RowOutcome::Created)
}

/// `YYYY-MM-DD` as the date column type. Validated upstream; a failure here
/// is a statement that slipped past `validate`, reported as a conflict.
fn civil_date(text: &str) -> Result<chrono::NaiveDate, StoreError> {
    chrono::NaiveDate::parse_from_str(text.trim(), "%Y-%m-%d")
        .map_err(|e| StoreError::Conflict(format!("{text:?} is not a YYYY-MM-DD date: {e}")))
}
