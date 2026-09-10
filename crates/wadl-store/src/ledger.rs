//! The append-only audit ledger's hash chain.
//!
//! The database enforces append-only by privilege (no UPDATE/DELETE); this
//! module is the *detection* half. Each entry's `entry_hash` is the SHA-256 of
//! the previous entry's hash concatenated with this entry's immutable fields, so
//! a silently altered or removed row breaks the chain and `wadl verify-ledger`
//! reports exactly where. The hashing is pure and deterministic, so the same
//! chain verifies identically on any machine years later.
//!
//! Two chain formats live in one chain. **Format 1** (every row written before
//! migration 0017) hashes the action, the detail and the instant. **Format 2**
//! (every row since) also hashes the person who acted — `actor_id` and
//! `actor_name` — under a `"v2"` domain tag, so the same fields under the old
//! format can never collide with the new. A chain may switch from 1 to 2 at
//! any row and keeps verifying; a row whose version this build cannot hash is
//! a hash mismatch, because a version we cannot hash is a hash we cannot trust.

use sha2::{Digest, Sha256};

/// The chain format rows written today carry.
pub const CHAIN_VERSION: u8 = 2;

/// One ledger entry's chain-relevant fields.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct LedgerEntry {
    /// Monotonic sequence (the table's `entry_id`).
    pub seq: i64,
    /// The action recorded, e.g. `PERMIT_APPROVED`.
    pub action: String,
    /// Free-text detail.
    pub detail: String,
    /// When it occurred (device time), epoch millis.
    pub occurred_at_ms: i64,
    /// The previous entry's hash (`None` for the first entry).
    #[serde(with = "hex_opt")]
    pub prev_hash: Option<Vec<u8>>,
    /// This entry's stored hash.
    #[serde(with = "hex_bytes")]
    pub entry_hash: Vec<u8>,
    /// Which chain format hashed this entry. Absent in exports written before
    /// people were asserted, which were all format 1.
    #[serde(default = "one")]
    pub chain_version: u8,
    /// The person who acted — hashed from format 2 on.
    #[serde(default)]
    pub actor_id: Option<String>,
    /// The person's display name at the time — hashed from format 2 on.
    #[serde(default)]
    pub actor_name: Option<String>,
}

const fn one() -> u8 {
    1
}

/// Where and why a chain failed to verify.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LedgerBreak {
    /// Index into the entry slice where the break was found.
    pub index: usize,
    /// The sequence number of the offending entry.
    pub seq: i64,
    /// What was wrong.
    pub reason: LedgerBreakKind,
}

/// The kind of chain break.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LedgerBreakKind {
    /// The stored `entry_hash` does not match the recomputed hash — the entry's
    /// own fields were altered, or its chain version is one this build cannot
    /// hash.
    HashMismatch,
    /// The stored `prev_hash` does not match the previous entry's `entry_hash`
    /// — an entry was inserted, removed, or reordered.
    ChainBroken,
}

/// Computes the format-1 hash for an entry given the previous entry's hash.
#[must_use]
pub fn compute_hash(
    prev_hash: Option<&[u8]>,
    action: &str,
    detail: &str,
    occurred_at_ms: i64,
) -> Vec<u8> {
    let mut hasher = Sha256::new();
    hasher.update(prev_hash.unwrap_or(&[]));
    hasher.update([0u8]); // domain separator between fields
    hasher.update(action.as_bytes());
    hasher.update([0u8]);
    hasher.update(detail.as_bytes());
    hasher.update([0u8]);
    hasher.update(occurred_at_ms.to_be_bytes());
    hasher.finalize().to_vec()
}

/// Computes the format-2 hash: the format-1 fields plus the person, under a
/// `"v2"` tag right after the previous hash so no format-1 input can produce
/// the same digest.
#[must_use]
pub fn compute_hash_v2(
    prev_hash: Option<&[u8]>,
    action: &str,
    detail: &str,
    occurred_at_ms: i64,
    actor_id: &str,
    actor_name: &str,
) -> Vec<u8> {
    let mut hasher = Sha256::new();
    hasher.update(prev_hash.unwrap_or(&[]));
    hasher.update([0u8]);
    hasher.update(b"v2");
    hasher.update([0u8]);
    hasher.update(action.as_bytes());
    hasher.update([0u8]);
    hasher.update(detail.as_bytes());
    hasher.update([0u8]);
    hasher.update(occurred_at_ms.to_be_bytes());
    hasher.update([0u8]);
    hasher.update(actor_id.as_bytes());
    hasher.update([0u8]);
    hasher.update(actor_name.as_bytes());
    hasher.finalize().to_vec()
}

/// The hash an entry should carry under its own chain version, or `None` when
/// the version is unknown or a format-2 entry names nobody.
fn expected_hash(previous: Option<&[u8]>, entry: &LedgerEntry) -> Option<Vec<u8>> {
    match entry.chain_version {
        1 => Some(compute_hash(
            previous,
            &entry.action,
            &entry.detail,
            entry.occurred_at_ms,
        )),
        2 => {
            let actor_id = entry.actor_id.as_deref()?;
            let actor_name = entry.actor_name.as_deref()?;
            Some(compute_hash_v2(
                previous,
                &entry.action,
                &entry.detail,
                entry.occurred_at_ms,
                actor_id,
                actor_name,
            ))
        }
        _ => None,
    }
}

/// Verifies a chain of entries, ordered by `seq` ascending. Each entry is
/// hashed under its own `chain_version`, so a ledger that switched formats at
/// migration 0017 verifies end to end.
///
/// # Errors
/// Returns the first [`LedgerBreak`] encountered, or `Ok(())` if the whole chain
/// is intact.
pub fn verify_chain(entries: &[LedgerEntry]) -> Result<(), LedgerBreak> {
    let mut previous: Option<&[u8]> = None;
    for (index, entry) in entries.iter().enumerate() {
        if entry.prev_hash.as_deref() != previous {
            return Err(LedgerBreak {
                index,
                seq: entry.seq,
                reason: LedgerBreakKind::ChainBroken,
            });
        }
        if expected_hash(previous, entry).as_deref() != Some(entry.entry_hash.as_slice()) {
            return Err(LedgerBreak {
                index,
                seq: entry.seq,
                reason: LedgerBreakKind::HashMismatch,
            });
        }
        previous = Some(&entry.entry_hash);
    }
    Ok(())
}

/// Verifies a hull's audit records as a surface reads them — hex hashes and
/// all. `records` must be ordered oldest first (the chain's direction).
///
/// Hex that does not decode is reported as a [`LedgerBreakKind::HashMismatch`]
/// at that entry: a hash that cannot be read is a hash that cannot be trusted,
/// and inventing a third break kind for it would make every consumer handle a
/// case that means the same thing.
///
/// # Errors
/// Returns the first [`LedgerBreak`] encountered, or `Ok(())` if the whole
/// chain is intact.
pub fn verify_records(records: &[crate::model::AuditRecord]) -> Result<(), LedgerBreak> {
    let mut chain = Vec::with_capacity(records.len());
    for (index, r) in records.iter().enumerate() {
        let bad = |_| LedgerBreak {
            index,
            seq: r.seq,
            reason: LedgerBreakKind::HashMismatch,
        };
        chain.push(LedgerEntry {
            seq: r.seq,
            action: r.action.clone(),
            detail: r.detail.clone(),
            occurred_at_ms: r.occurred_at_ms,
            prev_hash: r
                .prev_hash
                .as_deref()
                .map(hex::decode)
                .transpose()
                .map_err(bad)?,
            entry_hash: hex::decode(&r.entry_hash).map_err(bad)?,
            chain_version: r.chain_version,
            actor_id: r.actor_id.clone(),
            actor_name: r.actor_name.clone(),
        });
    }
    verify_chain(&chain)
}

/// Builds a well-formed format-1 chain from `(action, detail, occurred_at_ms)`
/// triples — used by seeding and tests to produce a valid ledger as it was
/// written before people were asserted.
#[must_use]
pub fn build_chain(events: &[(String, String, i64)]) -> Vec<LedgerEntry> {
    let mut entries = Vec::with_capacity(events.len());
    let mut previous: Option<Vec<u8>> = None;
    for (offset, (action, detail, ts)) in events.iter().enumerate() {
        let hash = compute_hash(previous.as_deref(), action, detail, *ts);
        entries.push(LedgerEntry {
            seq: i64::try_from(offset).unwrap_or(i64::MAX),
            action: action.clone(),
            detail: detail.clone(),
            occurred_at_ms: *ts,
            prev_hash: previous.clone(),
            entry_hash: hash.clone(),
            chain_version: 1,
            actor_id: None,
            actor_name: None,
        });
        previous = Some(hash);
    }
    entries
}

/// One event for [`build_chain_v2`]: `(action, detail, occurred_at_ms,
/// actor_id, actor_name)`.
pub type EventV2 = (String, String, i64, String, String);

/// Builds a well-formed format-2 chain — every entry names its person.
#[must_use]
pub fn build_chain_v2(events: &[EventV2]) -> Vec<LedgerEntry> {
    let mut entries = Vec::with_capacity(events.len());
    let mut previous: Option<Vec<u8>> = None;
    for (offset, (action, detail, ts, actor_id, actor_name)) in events.iter().enumerate() {
        let hash = compute_hash_v2(
            previous.as_deref(),
            action,
            detail,
            *ts,
            actor_id,
            actor_name,
        );
        entries.push(LedgerEntry {
            seq: i64::try_from(offset).unwrap_or(i64::MAX),
            action: action.clone(),
            detail: detail.clone(),
            occurred_at_ms: *ts,
            prev_hash: previous.clone(),
            entry_hash: hash.clone(),
            chain_version: CHAIN_VERSION,
            actor_id: Some(actor_id.clone()),
            actor_name: Some(actor_name.clone()),
        });
        previous = Some(hash);
    }
    entries
}

// hex (de)serialisation so a ledger export is human-inspectable JSON.
mod hex_bytes {
    use serde::{Deserialize, Deserializer, Serializer};

    pub(super) fn serialize<S: Serializer>(bytes: &[u8], s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&hex::encode(bytes))
    }

    pub(super) fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<Vec<u8>, D::Error> {
        let s = String::deserialize(d)?;
        hex::decode(&s).map_err(serde::de::Error::custom)
    }
}

mod hex_opt {
    use serde::{Deserialize, Deserializer, Serializer};

    // serde's `with` adapter dictates the &Option<T> signature; we cannot take
    // Option<&T> here or serde will not call it.
    #[allow(
        clippy::ref_option,
        reason = "serde `with` serialize signature is fixed"
    )]
    pub(super) fn serialize<S: Serializer>(
        bytes: &Option<Vec<u8>>,
        s: S,
    ) -> Result<S::Ok, S::Error> {
        match bytes {
            Some(b) => s.serialize_some(&hex::encode(b)),
            None => s.serialize_none(),
        }
    }

    pub(super) fn deserialize<'de, D: Deserializer<'de>>(
        d: D,
    ) -> Result<Option<Vec<u8>>, D::Error> {
        let opt = Option::<String>::deserialize(d)?;
        opt.map(|s| hex::decode(&s).map_err(serde::de::Error::custom))
            .transpose()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn v1(action: &str, detail: &str, ts: i64) -> (String, String, i64) {
        (action.to_owned(), detail.to_owned(), ts)
    }

    fn v2(action: &str, detail: &str, ts: i64, id: &str, name: &str) -> EventV2 {
        (
            action.to_owned(),
            detail.to_owned(),
            ts,
            id.to_owned(),
            name.to_owned(),
        )
    }

    #[test]
    fn a_well_formed_chain_verifies() {
        let chain = build_chain(&[
            v1("PERMIT_RAISED", "HW-1043", 1),
            v1("PERMIT_APPROVED", "HW-1043 gf", 2),
            v1("ACTIVITY_SUSPENDED", "R04 overhead", 3),
        ]);
        assert_eq!(verify_chain(&chain), Ok(()));
    }

    #[test]
    fn tampering_with_a_field_is_detected() {
        let mut chain = build_chain(&[
            v1("PERMIT_RAISED", "HW-1043", 1),
            v1("PERMIT_APPROVED", "HW-1043 gf", 2),
        ]);
        chain[0].detail = "HW-9999".to_owned(); // altered after the fact
        assert_eq!(
            verify_chain(&chain).unwrap_err().reason,
            LedgerBreakKind::HashMismatch
        );
    }

    #[test]
    fn removing_an_entry_is_detected() {
        let chain = build_chain(&[v1("A", "1", 1), v1("B", "2", 2), v1("C", "3", 3)]);
        let spliced = vec![chain[0].clone(), chain[2].clone()];
        assert_eq!(
            verify_chain(&spliced).unwrap_err().reason,
            LedgerBreakKind::ChainBroken
        );
    }

    #[test]
    fn a_v2_entry_hashes_the_actor() {
        let chain = build_chain_v2(&[v2(
            "HAZARD_CLEARED",
            "3-148-2-E",
            1,
            "1234567890",
            "R. Alvarez",
        )]);
        assert_eq!(verify_chain(&chain), Ok(()));
        // The same fields under format 1 are a different digest: the person is
        // in the hash, and the version tag keeps the two formats apart.
        let without_person = compute_hash(None, "HAZARD_CLEARED", "3-148-2-E", 1);
        assert_ne!(chain[0].entry_hash, without_person);
        let other_person = compute_hash_v2(
            None,
            "HAZARD_CLEARED",
            "3-148-2-E",
            1,
            "0987654321",
            "R. Alvarez",
        );
        assert_ne!(chain[0].entry_hash, other_person);
    }

    #[test]
    fn a_chain_that_switches_from_v1_to_v2_verifies() {
        // Two rows from before migration 0017, then two written under a person.
        let mut chain = build_chain(&[v1("A", "1", 1), v1("B", "2", 2)]);
        let mut previous = chain.last().map(|e| e.entry_hash.clone());
        for (seq, (action, detail, ts, id, name)) in [
            v2("C", "3", 3, "1234567890", "R. Alvarez"),
            v2("D", "4", 4, "dev:planner", "Demo Planner"),
        ]
        .into_iter()
        .enumerate()
        {
            let hash = compute_hash_v2(previous.as_deref(), &action, &detail, ts, &id, &name);
            chain.push(LedgerEntry {
                seq: 2 + i64::try_from(seq).unwrap(),
                action,
                detail,
                occurred_at_ms: ts,
                prev_hash: previous.clone(),
                entry_hash: hash.clone(),
                chain_version: 2,
                actor_id: Some(id),
                actor_name: Some(name),
            });
            previous = Some(hash);
        }
        assert_eq!(verify_chain(&chain), Ok(()));
    }

    #[test]
    fn altering_the_actor_of_a_v2_entry_breaks_the_chain() {
        let mut chain = build_chain_v2(&[
            v2("A", "1", 1, "1234567890", "R. Alvarez"),
            v2("B", "2", 2, "1234567890", "R. Alvarez"),
        ]);
        chain[1].actor_id = Some("0000000000".to_owned());
        let brk = verify_chain(&chain).unwrap_err();
        assert_eq!(brk.reason, LedgerBreakKind::HashMismatch);
        assert_eq!(brk.index, 1);

        let mut renamed = build_chain_v2(&[v2("A", "1", 1, "1234567890", "R. Alvarez")]);
        renamed[0].actor_name = Some("Somebody Else".to_owned());
        assert_eq!(
            verify_chain(&renamed).unwrap_err().reason,
            LedgerBreakKind::HashMismatch
        );

        // A format-2 row that names nobody cannot be verified at all.
        let mut nameless = build_chain_v2(&[v2("A", "1", 1, "1234567890", "R. Alvarez")]);
        nameless[0].actor_id = None;
        assert_eq!(
            verify_chain(&nameless).unwrap_err().reason,
            LedgerBreakKind::HashMismatch
        );
    }

    #[test]
    fn a_v1_export_without_the_new_fields_still_parses_and_verifies() {
        // An export written by the build before this one: no chain_version, no
        // actor fields — exactly what `wadl verify-ledger` may be handed.
        let chain = build_chain(&[v1("A", "1", 1), v1("B", "2", 2)]);
        let mut exported = serde_json::to_value(&chain).unwrap();
        for entry in exported.as_array_mut().unwrap() {
            let obj = entry.as_object_mut().unwrap();
            obj.remove("chain_version");
            obj.remove("actor_id");
            obj.remove("actor_name");
        }
        let parsed: Vec<LedgerEntry> = serde_json::from_value(exported).unwrap();
        assert_eq!(parsed, chain);
        assert_eq!(verify_chain(&parsed), Ok(()));

        // And a fresh export round-trips with the fields present.
        let v2_chain = build_chain_v2(&[v2("A", "1", 1, "1234567890", "R. Alvarez")]);
        let text = serde_json::to_string(&v2_chain).unwrap();
        let back: Vec<LedgerEntry> = serde_json::from_str(&text).unwrap();
        assert_eq!(back, v2_chain);
        assert_eq!(verify_chain(&back), Ok(()));
    }

    #[test]
    fn an_unknown_chain_version_is_a_hash_mismatch() {
        let mut chain = build_chain_v2(&[v2("A", "1", 1, "1234567890", "R. Alvarez")]);
        chain[0].chain_version = 3;
        assert_eq!(
            verify_chain(&chain).unwrap_err().reason,
            LedgerBreakKind::HashMismatch
        );
    }
}
