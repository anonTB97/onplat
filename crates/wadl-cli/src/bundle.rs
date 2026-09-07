//! `wadl support-bundle` — what an operator would otherwise never get off a
//! production box, in one redacted file: the CLI's release stamp, the
//! served `/health` body, the migrations embedded in this binary against
//! those the database has applied, every hull's ledger verdict, what
//! documents each hull holds, which configuration variables are set (names
//! only), and the recent audit lines from the journal.
//!
//! Redaction is one function with a test ([`redact`]): every uuid in any
//! string becomes `<uuid>`, every connection URL `<url>`, and the identity
//! fields (`org`, `person`, `by_person`, `actor_id`, `actor_name`, the
//! `x-wadl-person*` headers) read `redacted`. Hull numbers are kept so a
//! finding can be acted on. No environment value is ever read into the
//! bundle, only whether the variable is set; the database URL is used to
//! connect and never written; the proxy key is never opened.

use std::io::{Read as _, Write as _};
use std::net::{TcpStream, ToSocketAddrs as _};
use std::path::PathBuf;
use std::process::ExitCode;
use std::time::Duration;

use anyhow::{Context, Result};
use serde_json::{json, Value};

use wadl_domain::civil::YardClock;
use wadl_domain::Clock;
use wadl_store::clock::SystemClock;
use wadl_store::pg::{PgStore, MIGRATOR};

use crate::verify;

/// The command's arguments.
pub(crate) struct BundleArgs {
    /// Where to write the bundle.
    pub(crate) out: PathBuf,
    /// PostgreSQL URL; falls back to `DATABASE_URL`. Without one, the
    /// database sections say so and the rest is still collected.
    pub(crate) database_url: Option<String>,
    /// The served API's base, e.g. `http://127.0.0.1:8080`, for `/health`.
    pub(crate) base: String,
    /// How many journal lines to collect.
    pub(crate) journal_lines: usize,
}

/// The configuration variables the binaries read; the bundle reports which
/// are set, never their values.
const ENVIRONMENT: [&str; 13] = [
    "WADL_PORT",
    "WADL_BIND",
    "WADL_STATIC_DIR",
    "DATABASE_URL",
    "WADL_PROXY_KEY",
    "WADL_ALLOW_DEV_SHIM_OFF_LOOPBACK",
    "WADL_DEMO_DOCS",
    "WADL_SCHEDULE_XER",
    "WADL_MAX_IN_FLIGHT",
    "WADL_REQUEST_TIMEOUT_SECS",
    "WADL_DEFAULT_ROLES",
    "WADL_MARKINGS",
    "WADL_GIT",
];

/// Keys whose string values name a tenant or a person.
const IDENTITY_KEYS: [&str; 7] = [
    "org",
    "person",
    "by_person",
    "actor_id",
    "actor_name",
    "x-wadl-person",
    "x-wadl-person-name",
];

/// Writes the bundle.
pub(crate) async fn run(args: BundleArgs) -> Result<ExitCode> {
    let now_ms = SystemClock.now().epoch_millis();
    let stamp = wadl_api::version::current();
    let url = args
        .database_url
        .clone()
        .or_else(|| std::env::var("DATABASE_URL").ok());
    let database = match &url {
        Some(url) => database_sections(url).await?,
        None => json!({
            "note": "no database named (--database-url or DATABASE_URL); migrations.applied, ledger and documents not collected",
            "migrations": { "embedded": embedded_migrations(), "applied": [], "pending": Value::Null },
            "ledger": [],
            "documents": [],
        }),
    };
    let (set, unset): (Vec<&str>, Vec<&str>) = ENVIRONMENT
        .iter()
        .partition(|name| std::env::var_os(name).is_some());
    let mut bundle = json!({
        "generated_by": "wadl support-bundle",
        "generated_at": format!("{} UTC", YardClock::utc().local(now_ms).stamp()),
        "generated_at_epoch_ms": now_ms,
        "cli_version": stamp,
        "health": health(&args.base),
        "migrations": database.get("migrations").cloned().unwrap_or(Value::Null),
        "ledger": database.get("ledger").cloned().unwrap_or(Value::Null),
        "documents": database.get("documents").cloned().unwrap_or(Value::Null),
        "database_note": database.get("note").cloned().unwrap_or(Value::Null),
        "environment": { "set": set, "unset": unset },
        "audit_recent": journal(args.journal_lines),
        "redaction": "no env values, no URLs, no uuids, no person ids, no header values; hull numbers kept so a finding can be acted on",
    });
    redact(&mut bundle);
    std::fs::write(&args.out, serde_json::to_string_pretty(&bundle)?)
        .with_context(|| format!("writing {}", args.out.display()))?;
    println!("wrote {}", args.out.display());
    Ok(ExitCode::SUCCESS)
}

/// The migrations this binary carries, `NNNN_description`.
fn embedded_migrations() -> Vec<String> {
    MIGRATOR
        .iter()
        .map(|m| format!("{:04}_{}", m.version, m.description))
        .collect()
}

/// The sections that need the database: migration state, ledger verdicts,
/// document inventory.
async fn database_sections(url: &str) -> Result<Value> {
    let store = PgStore::connect(url).await.context("connecting")?;
    let applied = store
        .migration_state()
        .await
        .context("reading _sqlx_migrations")?;
    let pending: Vec<String> = MIGRATOR
        .iter()
        .filter(|m| !applied.iter().any(|a| a.version == m.version))
        .map(|m| format!("{:04}_{}", m.version, m.description))
        .collect();
    let ledger = verify::verdicts(&store).await?;
    let documents = store
        .documents_inventory()
        .await
        .context("reading the document inventory")?;
    Ok(json!({
        "migrations": { "embedded": embedded_migrations(), "applied": applied, "pending": pending },
        "ledger": ledger,
        "documents": documents,
    }))
}

/// `GET {base}/health`, as JSON, or the reason it could not be read. A
/// hand-rolled HTTP/1.1 GET over `std::net` — the served API is on loopback
/// or behind the proxy on this host, and a client crate for one request is
/// not worth its admission.
fn health(base: &str) -> Value {
    match fetch_health(base) {
        Ok(body) => serde_json::from_str(&body)
            .unwrap_or_else(|e| json!(format!("unreadable: {e} — body {body:?}"))),
        Err(reason) => json!(format!("unreachable: {reason}")),
    }
}

fn fetch_health(base: &str) -> Result<String, String> {
    let rest = base.strip_prefix("http://").ok_or_else(|| {
        format!("{base}: only http:// bases are supported (the API on this host)")
    })?;
    let host_port = rest.trim_end_matches('/');
    let (host, _) = host_port
        .rsplit_once(':')
        .ok_or_else(|| format!("{base}: expected http://host:port"))?;
    let addr = host_port
        .to_socket_addrs()
        .map_err(|e| format!("{host_port}: {e}"))?
        .next()
        .ok_or_else(|| format!("{host_port}: no address"))?;
    let mut stream = TcpStream::connect_timeout(&addr, Duration::from_secs(3))
        .map_err(|e| format!("{host_port}: {e}"))?;
    stream
        .set_read_timeout(Some(Duration::from_secs(5)))
        .map_err(|e| e.to_string())?;
    stream
        .write_all(
            format!("GET /health HTTP/1.1\r\nHost: {host}\r\nConnection: close\r\n\r\n").as_bytes(),
        )
        .map_err(|e| e.to_string())?;
    let mut raw = Vec::new();
    stream.read_to_end(&mut raw).map_err(|e| e.to_string())?;
    let text = String::from_utf8_lossy(&raw);
    let (head, body) = text
        .split_once("\r\n\r\n")
        .ok_or_else(|| "no HTTP response".to_owned())?;
    let chunked = head
        .lines()
        .any(|l| l.to_ascii_lowercase().replace(' ', "") == "transfer-encoding:chunked");
    Ok(if chunked {
        dechunk(body)
    } else {
        body.to_owned()
    })
}

/// Joins the chunks of a `Transfer-Encoding: chunked` body.
fn dechunk(body: &str) -> String {
    let mut out = String::new();
    let mut rest = body;
    while let Some((size, after)) = rest.split_once("\r\n") {
        let Ok(n) = usize::from_str_radix(size.trim(), 16) else {
            break;
        };
        if n == 0 {
            break;
        }
        let chunk: String = after.chars().take(n).collect();
        out.push_str(&chunk);
        rest = after
            .get(chunk.len()..)
            .unwrap_or("")
            .trim_start_matches("\r\n");
    }
    out
}

/// The recent audit lines from `journalctl -u wadl`, each parsed as the JSON
/// line the binary writes (or kept as text), redacted with the rest. A host
/// without `journalctl`, or an operator it refuses, gets an empty list and
/// the note — the bundle never fails for want of a journal.
fn journal(lines: usize) -> Value {
    let source = format!("journalctl -u wadl -n {lines} -o cat");
    let output = std::process::Command::new("journalctl")
        .args(["-u", "wadl", "-n", &lines.to_string(), "-o", "cat"])
        .output();
    match output {
        Ok(out) if out.status.success() => {
            let parsed: Vec<Value> = String::from_utf8_lossy(&out.stdout)
                .lines()
                .filter(|l| !l.trim().is_empty())
                .map(|l| serde_json::from_str(l).unwrap_or_else(|_| json!({ "line": l })))
                .collect();
            json!({ "source": source, "lines": parsed })
        }
        Ok(out) => json!({
            "source": source,
            "lines": [],
            "note": format!("journalctl refused: {}", String::from_utf8_lossy(&out.stderr).trim()),
        }),
        Err(e) => {
            json!({ "source": source, "lines": [], "note": format!("journalctl unavailable: {e}") })
        }
    }
}

/// Redacts in place: every uuid in any string → `<uuid>`, every connection
/// URL → `<url>`, identity fields → `redacted`.
pub(crate) fn redact(value: &mut Value) {
    match value {
        Value::Object(map) => {
            for (key, val) in map.iter_mut() {
                if IDENTITY_KEYS.contains(&key.as_str()) && val.is_string() {
                    *val = Value::String("redacted".to_owned());
                } else {
                    redact(val);
                }
            }
        }
        Value::Array(items) => items.iter_mut().for_each(redact),
        Value::String(s) => *s = redact_text(s),
        _ => {}
    }
}

/// Uuids and connection URLs out of one string.
fn redact_text(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let bytes = text.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if is_uuid_at(bytes, i) {
            out.push_str("<uuid>");
            i += 36;
        } else if let Some(len) = url_len_at(text, i) {
            out.push_str("<url>");
            i += len;
        } else {
            // Advance one character, not one byte, so multi-byte text is kept
            // whole.
            let ch_len = text
                .get(i..)
                .and_then(|s| s.chars().next())
                .map_or(1, char::len_utf8);
            out.push_str(text.get(i..i + ch_len).unwrap_or(""));
            i += ch_len;
        }
    }
    out
}

/// Whether the 36 bytes at `at` are `8-4-4-4-12` hex.
fn is_uuid_at(bytes: &[u8], at: usize) -> bool {
    let Some(window) = bytes.get(at..at + 36) else {
        return false;
    };
    window.iter().enumerate().all(|(pos, b)| match pos {
        8 | 13 | 18 | 23 => *b == b'-',
        _ => b.is_ascii_hexdigit(),
    })
}

/// The length of a `postgres://` / `postgresql://` URL starting at `at`
/// (to the next whitespace or quote), if one starts there.
fn url_len_at(text: &str, at: usize) -> Option<usize> {
    let rest = text.get(at..)?;
    if !(rest.starts_with("postgres://") || rest.starts_with("postgresql://")) {
        return None;
    }
    let end = rest
        .find(|c: char| c.is_whitespace() || c == '"' || c == '\'')
        .unwrap_or(rest.len());
    Some(end)
}

#[cfg(test)]
#[allow(clippy::indexing_slicing)]
mod tests {
    use super::*;

    #[test]
    fn redact_replaces_uuids_and_identity_fields() {
        let mut value = json!({
            "hull_no": "CVN-73",
            "path": "/api/vessels/00000000-0000-0000-0000-000000000073/ledger",
            "org": "00000000-0000-0000-0000-000000000001",
            "person": "Y-1001",
            "nested": [{ "by_person": "Y-1007", "detail": "seq 3 by 0198f2a0-7c1e-7b3a-9d1e-2b7e6f4a1c22 ok" }],
            "url": "cannot connect to postgres://wadl:secret@db.yard.local:5432/wadl — refused",
            "count": 14,
            "mixed": "héllo 00000000-0000-0000-0000-000000000073 wörld",
        });
        redact(&mut value);
        let text = value.to_string();
        assert_eq!(value["hull_no"], "CVN-73");
        assert_eq!(value["path"], "/api/vessels/<uuid>/ledger");
        assert_eq!(value["org"], "redacted");
        assert_eq!(value["person"], "redacted");
        assert_eq!(value["nested"][0]["by_person"], "redacted");
        assert_eq!(value["nested"][0]["detail"], "seq 3 by <uuid> ok");
        assert_eq!(value["url"], "cannot connect to <url> — refused");
        assert_eq!(value["mixed"], "héllo <uuid> wörld");
        assert_eq!(value["count"], 14);
        assert!(
            !text.contains("secret") && !text.contains("Y-1001"),
            "{text}"
        );
        assert!(!is_uuid_at(b"not-a-uuid-at-all-not-a-uuid-at-all-", 0));
    }

    #[test]
    fn chunked_bodies_are_joined() {
        assert_eq!(
            dechunk("5\r\nhello\r\n6\r\n world\r\n0\r\n\r\n"),
            "hello world"
        );
    }

    #[test]
    fn the_embedded_migration_set_is_the_stamps_schema() {
        let embedded = embedded_migrations();
        let last = embedded.last().and_then(|m| m.get(..4)).unwrap_or("0000");
        assert_eq!(last, wadl_api::version::current().schema);
    }
}
