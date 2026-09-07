//! Owner-mode operations on PostgreSQL: the writes an operator's session
//! makes outside any tenant scope, because row-level security forbids the
//! application role from creating a tenant — the same reason `seed_demo`
//! runs as the connecting role.
//!
//! [`PgStore::audit_chains_all`], [`PgStore::migration_state`] and
//! [`PgStore::documents_inventory`] are the read-only owner-mode reads
//! `wadl verify-ledger --database-url` and `wadl support-bundle` make:
//! every hull's chain, the applied migrations, what documents each hull
//! holds — never a document's content.
//!
//! [`PgStore::bootstrap_hull`] is the hull-row statement
//! `docs/pilot-playbook.md` §1 files, applied as one transaction and
//! ledgered on the hull it creates — with the baseline reference data a
//! tenant needs before its first door opens (the coupling types the
//! coupling register names and the rule set the engine evaluates), which
//! until now only the demo seed installed. The seed installs the same rule
//! set through the same function. A tenant bootstrapped here is never
//! seeded afterwards: the seed is the demo world, and its fixed coupling-type
//! ids would clash with the baseline's by `(org_id, code)`.

use sqlx::Row as _;
use sqlx::{Postgres, Transaction};
use uuid::Uuid;

use wadl_domain::ids::{OrgId, VesselId};

use crate::error::StoreError;
use crate::model::{
    AppliedMigration, AuditRecord, BootstrapOutcome, DocumentInventoryRow, HullStatement,
    RowOutcome,
};
use crate::pg::PgStore;
use crate::pg_repo::{audit_record_from_row, AUDIT_COLUMNS};
use crate::scope::{Actor, TenantScope};

/// One hull's ledger, oldest first, as the connecting role read it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HullChain {
    /// The hull number, e.g. `CVN-73`.
    pub hull_no: String,
    /// The hull's id.
    pub vessel_id: Uuid,
    /// Its rows, oldest first — the order `ledger::verify_records` walks.
    pub records: Vec<AuditRecord>,
}

impl PgStore {
    /// Every hull's ledger chain, oldest row first, hulls by hull number —
    /// read as the connecting role outside row-level security (the
    /// operator's session, like `migrate`), read-only. Hulls with no rows
    /// are listed with an empty chain, so a hull the ledger never saw is
    /// visible as such.
    ///
    /// # Errors
    /// [`StoreError::Backend`] on any statement failure.
    pub async fn audit_chains_all(&self) -> Result<Vec<HullChain>, StoreError> {
        let hulls = sqlx::query("SELECT vessel_id, hull_no FROM vessel ORDER BY hull_no")
            .fetch_all(self.pool())
            .await?;
        let mut chains = Vec::with_capacity(hulls.len());
        for hull in &hulls {
            let vessel_id: Uuid = hull.get("vessel_id");
            let rows = sqlx::query(&format!(
                "SELECT {AUDIT_COLUMNS} FROM audit_entry a
                  WHERE a.vessel_id = $1 ORDER BY a.entry_id ASC"
            ))
            .bind(vessel_id)
            .fetch_all(self.pool())
            .await?;
            chains.push(HullChain {
                hull_no: hull.get("hull_no"),
                vessel_id,
                records: rows.iter().map(audit_record_from_row).collect(),
            });
        }
        Ok(chains)
    }

    /// The migrations the database records as applied, in order.
    ///
    /// # Errors
    /// [`StoreError::Backend`] on any statement failure (an unmigrated
    /// database has no `_sqlx_migrations` table and reads as such).
    pub async fn migration_state(&self) -> Result<Vec<AppliedMigration>, StoreError> {
        let rows = sqlx::query(
            "SELECT version, description, installed_on, success
               FROM _sqlx_migrations ORDER BY version",
        )
        .fetch_all(self.pool())
        .await?;
        Ok(rows
            .iter()
            .map(|r| AppliedMigration {
                version: r.get("version"),
                description: r.get("description"),
                installed_on: r
                    .get::<chrono::DateTime<chrono::Utc>, _>("installed_on")
                    .to_rfc3339(),
                success: r.get("success"),
            })
            .collect())
    }

    /// What documents each hull holds — kind, label, when — and never their
    /// content. Read as the connecting role, read-only.
    ///
    /// # Errors
    /// [`StoreError::Backend`] on any statement failure.
    pub async fn documents_inventory(&self) -> Result<Vec<DocumentInventoryRow>, StoreError> {
        let rows = sqlx::query(
            "SELECT v.hull_no, d.kind, d.label,
                    (EXTRACT(EPOCH FROM d.ingested_at) * 1000)::bigint AS ingested_at_ms
               FROM ingested_document d JOIN vessel v ON v.vessel_id = d.vessel_id
              ORDER BY v.hull_no, d.kind",
        )
        .fetch_all(self.pool())
        .await?;
        Ok(rows
            .iter()
            .map(|r| DocumentInventoryRow {
                hull_no: r.get("hull_no"),
                kind: r.get("kind"),
                label: r.get("label"),
                ingested_at_ms: r.get("ingested_at_ms"),
            })
            .collect())
    }
}

/// The ledger action a hull-row statement writes on the hull it created.
pub const HULL_BOOTSTRAPPED: &str = "HULL_BOOTSTRAPPED";

/// The coupling types every tenant starts with — the memory store's
/// `seeded_coupling_types` and `pg_seed.sql`'s rows, one list: code, label,
/// directional, what it carries, default reach in hops. The reference hull's
/// coupling register names these codes, so a tenant without one of them
/// refuses that register at the door; a unit test pins this list to the
/// memory store's so the two backends cannot drift apart again.
pub const BASELINE_COUPLING_TYPES: [(&str, &str, bool, &[&str], i32); 4] = [
    (
        "deck_penetration",
        "Deck penetration",
        true,
        &["heat", "vapour"],
        1,
    ),
    (
        "shared_bulkhead",
        "Shared bulkhead",
        false,
        &["heat", "vapour"],
        2,
    ),
    ("exhaust_trunk", "Exhaust trunk", true, &["vapour"], 3),
    ("electrical_bus", "Electrical bus", false, &["energy"], 1),
];

/// A stable id for a tenant's baseline row: `sha256("wadl:" ‖ tag ‖ ":" ‖
/// org ‖ ":" ‖ key)`, first sixteen bytes, version nibble 8 (a name-derived
/// id that is not RFC 4122's v3 or v5), RFC 4122 variant. The same tenant
/// and key give the same id, so the installer is idempotent by primary key
/// as well as by natural key; two tenants never share a row.
fn derived_id(org: Uuid, tag: &str, key: &[u8]) -> Uuid {
    use sha2::Digest as _;
    let mut hasher = sha2::Sha256::new();
    hasher.update(b"wadl:");
    hasher.update(tag.as_bytes());
    hasher.update(b":");
    hasher.update(org.as_bytes());
    hasher.update(b":");
    hasher.update(key);
    let digest = hasher.finalize();
    let mut bytes = [0_u8; 16];
    for (dst, src) in bytes.iter_mut().zip(digest.iter()) {
        *dst = *src;
    }
    if let Some(b) = bytes.get_mut(6) {
        *b = (*b & 0x0F) | 0x80;
    }
    if let Some(b) = bytes.get_mut(8) {
        *b = (*b & 0x3F) | 0x80;
    }
    Uuid::from_bytes(bytes)
}

/// Installs the [`BASELINE_COUPLING_TYPES`] a tenant is missing, by natural
/// key `(org_id, code)`: a tenant with none gets them all, a tenant seeded
/// with a subset (the demo seed before it carried `electrical_bus`) is
/// topped up, a tenant with every code is left alone. A type the tenant
/// already has is never rewritten — its id and semantics are the tenant's.
/// `created` when any row was written, `existed` when none was missing.
///
/// # Errors
/// [`StoreError::Backend`] on any statement failure.
pub(crate) async fn install_baseline_coupling_types(
    tx: &mut Transaction<'_, Postgres>,
    org: Uuid,
    dry_run: bool,
) -> Result<RowOutcome, StoreError> {
    let present: Vec<String> =
        sqlx::query_scalar("SELECT code FROM coupling_type WHERE org_id = $1")
            .bind(org)
            .fetch_all(&mut **tx)
            .await?;
    let missing: Vec<_> = BASELINE_COUPLING_TYPES
        .iter()
        .filter(|(code, ..)| !present.iter().any(|p| p == code))
        .collect();
    if missing.is_empty() {
        return Ok(RowOutcome::Existed);
    }
    if dry_run {
        return Ok(RowOutcome::WouldCreate);
    }
    for (code, label, directional, propagates, hops) in missing {
        let carries: Vec<String> = propagates.iter().map(|p| (*p).to_owned()).collect();
        sqlx::query(
            "INSERT INTO coupling_type
                (coupling_type_id, org_id, code, label, directional, propagates, default_max_hops)
             VALUES ($1, $2, $3, $4, $5, $6, $7)
             ON CONFLICT (org_id, code) DO NOTHING",
        )
        .bind(derived_id(org, "coupling_type", code.as_bytes()))
        .bind(org)
        .bind(code)
        .bind(label)
        .bind(directional)
        .bind(&carries)
        .bind(*hops)
        .execute(&mut **tx)
        .await?;
    }
    Ok(RowOutcome::Created)
}

/// Installs the baseline rule set — [`wadl_engine::RuleSet::seed_usn_hot_work`]
/// — for a tenant that has no rules, per the 0011 payload contract:
/// `trigger_expr` is the serde form of the engine's `RuleEntry`, so what
/// `rules_in_force` deserializes is byte-identical to what the engine was
/// written against. SQL literals would be a hand-copied shadow of that
/// shape, and hand copies drift. The demo seed installs its rules through
/// this same function.
///
/// # Errors
/// [`StoreError::Backend`] on any statement failure or an unparseable code.
pub(crate) async fn install_baseline_rules(
    tx: &mut Transaction<'_, Postgres>,
    org: Uuid,
    dry_run: bool,
) -> Result<RowOutcome, StoreError> {
    use wadl_engine::rules::Applies;

    let present: i64 = sqlx::query_scalar("SELECT count(*) FROM rule WHERE org_id = $1")
        .bind(org)
        .fetch_one(&mut **tx)
        .await?;
    if present > 0 {
        return Ok(RowOutcome::Existed);
    }
    if dry_run {
        return Ok(RowOutcome::WouldCreate);
    }
    let entries = wadl_engine::RuleSet::seed_usn_hot_work();
    let mut version_no: std::collections::BTreeMap<String, i32> = std::collections::BTreeMap::new();
    for entry in entries.entries() {
        let rule_id = derived_id(org, "rule", entry.rule_code.as_bytes());
        sqlx::query(
            "INSERT INTO rule (rule_id, org_id, code, name, kind)
             VALUES ($1, $2, $3, $3, 'hazard_cascade')
             ON CONFLICT (rule_id) DO NOTHING",
        )
        .bind(rule_id)
        .bind(org)
        .bind(&entry.rule_code)
        .execute(&mut **tx)
        .await?;

        let version = version_no.entry(entry.rule_code.clone()).or_insert(0);
        *version += 1;
        let state = match entry.state {
            wadl_engine::DecisionState::Allow => "ALLOW",
            wadl_engine::DecisionState::Warn => "WARN",
            wadl_engine::DecisionState::Block => "BLOCK",
            wadl_engine::DecisionState::Suspend => "SUSPEND",
        };
        let max_hops: Option<i32> = match &entry.applies {
            Applies::SameSpace => None,
            Applies::Coupled { max_hops, .. } => Some(i32::from(max_hops.get())),
        };
        let trigger = serde_json::to_value(entry)
            .map_err(|e| StoreError::Backend(format!("rule payload: {e}")))?;
        let clearing = serde_json::json!({
            "clearing_authority": entry.clearing_authority,
            "hold_minutes": entry.hold.map(wadl_domain::units::Minutes::get),
        });
        let rule_version_id =
            derived_id(org, "rule_version", entry.rule_version.as_uuid().as_bytes());
        sqlx::query(
            "INSERT INTO rule_version
                (rule_version_id, rule_id, version_no, effective_from,
                 trigger_expr, max_hops, result_state, clearing_expr,
                 clearing_authority, waivable)
             VALUES ($1, $2, $3, timestamptz '2026-01-01 00:00Z',
                     $4, $5, $6::decision_state, $7, $8, $9)
             ON CONFLICT (rule_version_id) DO NOTHING",
        )
        .bind(rule_version_id)
        .bind(rule_id)
        .bind(*version)
        .bind(trigger)
        .bind(max_hops)
        .bind(state)
        .bind(clearing)
        .bind(&entry.clearing_authority)
        .bind(entry.waivable)
        .execute(&mut **tx)
        .await?;

        sqlx::query(
            "INSERT INTO rule_binding (rule_version_id, class_id, work_type, category)
             VALUES ($1, NULL, 'hot_work', NULL)
             ON CONFLICT DO NOTHING",
        )
        .bind(rule_version_id)
        .execute(&mut **tx)
        .await?;
    }
    Ok(RowOutcome::Created)
}

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
    /// Then the tenant's baseline reference data, when it has none: the three
    /// coupling types the coupling register names and the rule set the
    /// engine evaluates (`created | existed` as one row each).
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
        // One bootstrap of a tenant at a time: each row is "look, then
        // insert", and two first-time statements for the same organisation
        // racing each other would both look, both insert, and one would die
        // on the primary key instead of reading `existed`. A transaction-
        // scoped advisory lock on the tenant serialises them and releases
        // itself with the transaction — the device 0018 uses per hull for a
        // run's `seq`.
        sqlx::query("SELECT pg_advisory_xact_lock(hashtext('wadl:bootstrap'), hashtext($1))")
            .bind(statement.organization.org_id.to_string())
            .execute(&mut *tx)
            .await?;
        let organization = organization_row(&mut tx, statement, dry_run).await?;
        let class = class_row(&mut tx, statement, dry_run).await?;
        let vessel = vessel_row(&mut tx, statement, dry_run).await?;
        let availability = availability_row(&mut tx, statement, dry_run).await?;
        let org_uuid = statement.organization.org_id;
        let coupling_types = install_baseline_coupling_types(&mut tx, org_uuid, dry_run).await?;
        let rules = install_baseline_rules(&mut tx, org_uuid, dry_run).await?;
        let mut outcome = BootstrapOutcome {
            organization,
            class,
            vessel,
            availability,
            coupling_types,
            rules,
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
                "coupling_types": outcome.coupling_types,
                "rules": outcome.rules,
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

#[cfg(test)]
mod tests {
    use super::*;

    /// The baseline a bootstrapped tenant gets is the memory store's seeded
    /// list, code for code, carrying the same things the same distance — so
    /// a coupling register the demo accepts is one a pilot tenant accepts.
    #[test]
    fn the_baseline_coupling_types_are_the_memory_stores() {
        let memory = crate::memory::seeded_coupling_types();
        assert_eq!(memory.len(), BASELINE_COUPLING_TYPES.len());
        for (code, _label, _directional, propagates, hops) in BASELINE_COUPLING_TYPES {
            let seeded = memory
                .iter()
                .find(|t| t.code == code)
                .unwrap_or_else(|| panic!("the memory store does not seed {code}"));
            let carries: Vec<&str> = seeded.propagates.iter().map(String::as_str).collect();
            assert_eq!(carries, propagates, "{code}");
            assert_eq!(i32::from(seeded.max_reach), hops, "{code}");
        }
    }

    /// Two tenants never share a baseline row; the same tenant always gets
    /// the same id, which is what makes the installer idempotent by key.
    #[test]
    fn derived_ids_are_stable_per_tenant_and_distinct_across_tenants() {
        let a = Uuid::from_u128(0x01);
        let b = Uuid::from_u128(0x02);
        assert_eq!(
            derived_id(a, "coupling_type", b"exhaust_trunk"),
            derived_id(a, "coupling_type", b"exhaust_trunk")
        );
        assert_ne!(
            derived_id(a, "coupling_type", b"exhaust_trunk"),
            derived_id(b, "coupling_type", b"exhaust_trunk")
        );
        assert_ne!(
            derived_id(a, "coupling_type", b"exhaust_trunk"),
            derived_id(a, "rule", b"exhaust_trunk")
        );
    }
}
