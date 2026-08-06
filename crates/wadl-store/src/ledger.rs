//! The append-only audit ledger's hash chain.
//!
//! The database enforces append-only by privilege (no UPDATE/DELETE); this
//! module is the *detection* half. Each entry's `entry_hash` is the SHA-256 of
//! the previous entry's hash concatenated with this entry's immutable fields, so
//! a silently altered or removed row breaks the chain and `wadl verify-ledger`
//! reports exactly where. The hashing is pure and deterministic, so the same
//! chain verifies identically on any machine years later.

use sha2::{Digest, Sha256};

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
    /// own fields were altered.
    HashMismatch,
    /// The stored `prev_hash` does not match the previous entry's `entry_hash`
    /// — an entry was inserted, removed, or reordered.
    ChainBroken,
}

/// Computes the canonical hash for an entry given the previous entry's hash.
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

/// Verifies a chain of entries, ordered by `seq` ascending.
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
        let expected = compute_hash(previous, &entry.action, &entry.detail, entry.occurred_at_ms);
        if expected != entry.entry_hash {
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

/// Builds a well-formed chain from `(action, detail, occurred_at_ms)` triples —
/// used by seeding and tests to produce a valid ledger.
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

    #[test]
    fn a_well_formed_chain_verifies() {
        let chain = build_chain(&[
            ("PERMIT_RAISED".to_owned(), "HW-1043".to_owned(), 1),
            ("PERMIT_APPROVED".to_owned(), "HW-1043 gf".to_owned(), 2),
            (
                "ACTIVITY_SUSPENDED".to_owned(),
                "R04 overhead".to_owned(),
                3,
            ),
        ]);
        assert_eq!(verify_chain(&chain), Ok(()));
    }

    #[test]
    fn tampering_with_a_field_is_detected() {
        let mut chain = build_chain(&[
            ("PERMIT_RAISED".to_owned(), "HW-1043".to_owned(), 1),
            ("PERMIT_APPROVED".to_owned(), "HW-1043 gf".to_owned(), 2),
        ]);
        chain[0].detail = "HW-9999".to_owned(); // altered after the fact
        assert_eq!(
            verify_chain(&chain).unwrap_err().reason,
            LedgerBreakKind::HashMismatch
        );
    }

    #[test]
    fn removing_an_entry_is_detected() {
        let chain = build_chain(&[
            ("A".to_owned(), "1".to_owned(), 1),
            ("B".to_owned(), "2".to_owned(), 2),
            ("C".to_owned(), "3".to_owned(), 3),
        ]);
        let spliced = vec![chain[0].clone(), chain[2].clone()];
        assert_eq!(
            verify_chain(&spliced).unwrap_err().reason,
            LedgerBreakKind::ChainBroken
        );
    }
}
