//! The caller identity extractor — the one place identity enters the API.
//!
//! Identity arrives as headers either way; what changes between deployments is
//! **who is allowed to assert them**, and that trust boundary lives here:
//!
//! * **Dev shim** (default): `x-org-id` names the tenant and
//!   `x-assigned-vessels` carries the caller's per-hull assignments, trusted
//!   as given. Suitable only behind a loopback bind on a developer machine.
//!   A person header is optional (`dev:anonymous` without one) and no roles
//!   header means every capability — a demo, labelled as one on `whoami`.
//! * **Proxy-asserted** (`WADL_PROXY_KEY` set): the same identity headers are
//!   trusted only when the request also carries `x-wadl-proxy-key` matching
//!   the configured value, compared in constant time. This is the accredited
//!   pattern for yards: CAC/PIV authentication terminates at the reverse
//!   proxy, which asserts the mapped identity headers plus the shared key on
//!   its private hop to this process. A request that reaches the port without
//!   the key — anything that did not come through the proxy — is refused
//!   before any identity is read. A person (`x-wadl-person`) is required;
//!   roles come from `x-wadl-roles`, or `WADL_DEFAULT_ROLES`, or `reader`.
//!
//! The six headers and their formats are the contract the yard's proxy owner
//! implements (`docs/briefs/proxy-owner-contract.md` §2). Either way the
//! *shape* is the same — a [`Caller`] resolved before any handler runs — and
//! that shape is what the generated cross-tenant leak tests exercise.
//! Swapping in a different identity source (an OIDC broker, a session store)
//! means replacing the inside of [`resolve`] and nothing else.

use std::collections::BTreeSet;
use std::sync::OnceLock;

use axum::extract::FromRequestParts;
use axum::http::request::Parts;
use axum::http::HeaderMap;
use uuid::Uuid;

use wadl_domain::ids::{OrgId, VesselId};
use wadl_store::{Actor, ActorSource, TenantScope};

use crate::error::ApiError;
use crate::roles::{self, Capability, Role};

/// The proxy's stable subject for the person: EDIPI or badge.
pub const PERSON_HEADER: &str = "x-wadl-person";
/// The person's display name, percent-encoded UTF-8.
pub const PERSON_NAME_HEADER: &str = "x-wadl-person-name";
/// Comma-separated role codes from [`Role::ALL`].
pub const ROLES_HEADER: &str = "x-wadl-roles";

/// The longest person id the contract admits.
const PERSON_ID_MAX: usize = 128;
/// The longest name on the wire (percent-encoded bytes) and decoded (chars).
const NAME_WIRE_MAX: usize = 200;
const NAME_CHARS_MAX: usize = 120;

/// The resolved caller, injected into every scoped handler.
///
/// Handlers destructure `Caller { scope, .. }`; the roles and capabilities
/// are read by the gate and `whoami`, and the warnings are what `whoami`
/// tells the shell about the headers it was given.
#[derive(Debug)]
pub(crate) struct Caller {
    /// Tenant, assignment and the person — what every store call takes.
    pub(crate) scope: TenantScope,
    /// The recognised roles, sorted and deduplicated.
    pub(crate) roles: Vec<Role>,
    /// What those roles may do (`read` always).
    pub(crate) capabilities: BTreeSet<Capability>,
    /// What the resolution had to fall back on, in sentences.
    pub(crate) warnings: Vec<String>,
}

/// The process environment this module reads, gathered once so tests can
/// drive both modes without touching the real environment.
pub(crate) struct Env {
    /// The proxy key. `None` means dev-shim trust.
    pub(crate) proxy_key: Option<String>,
    /// Roles granted to a proxy-authenticated person who arrives with none.
    pub(crate) default_roles: Vec<Role>,
    /// The handling markings the shell's band wears.
    pub(crate) markings: Vec<String>,
}

/// The markings this build wears when the deployment sets none — the
/// prototype's own, a statement about the demo data (a public deck plan and
/// notional numbers), not a claim about any yard's information.
const DEFAULT_MARKINGS: [&str; 3] = [
    "BigBear.ai Proprietary",
    "Competition Sensitive",
    "All Represented Information is Open Sourced",
];

impl Env {
    /// Reads `WADL_PROXY_KEY`, `WADL_DEFAULT_ROLES` and `WADL_MARKINGS`.
    ///
    /// An empty key is treated as unset here and refused at startup by the
    /// server binary: `WADL_PROXY_KEY=""` used to arm proxy mode with a key
    /// every request could match by presenting nothing, which is the opposite
    /// of a gate. Unknown default-role codes are dropped here and refused at
    /// boot the same way.
    fn from_process() -> Self {
        let proxy_key = std::env::var("WADL_PROXY_KEY")
            .ok()
            .filter(|k| !k.is_empty());
        let default_roles = std::env::var("WADL_DEFAULT_ROLES")
            .map(|raw| parse_role_codes(&raw).0)
            .unwrap_or_default();
        let markings = std::env::var("WADL_MARKINGS")
            .ok()
            .map(|raw| {
                raw.split('|')
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    .map(str::to_owned)
                    .collect::<Vec<_>>()
            })
            .filter(|m| !m.is_empty())
            .unwrap_or_else(|| DEFAULT_MARKINGS.iter().map(|s| (*s).to_owned()).collect());
        Self {
            proxy_key,
            default_roles,
            markings,
        }
    }

    /// The dev shim with no defaults — what tests drive.
    #[cfg(test)]
    pub(crate) fn dev() -> Self {
        Self {
            proxy_key: None,
            default_roles: Vec::new(),
            markings: DEFAULT_MARKINGS.iter().map(|s| (*s).to_owned()).collect(),
        }
    }

    /// Proxy mode under `key`, with the given default roles.
    #[cfg(test)]
    pub(crate) fn proxy(key: &str, default_roles: &[Role]) -> Self {
        Self {
            proxy_key: Some(key.to_owned()),
            default_roles: default_roles.to_vec(),
            ..Self::dev()
        }
    }
}

/// The process environment, read once.
pub(crate) fn env() -> &'static Env {
    static ENV: OnceLock<Env> = OnceLock::new();
    ENV.get_or_init(Env::from_process)
}

/// Whether `WADL_PROXY_KEY` is set to the empty string — the misconfiguration
/// the server refuses to start under. Exposed for the binary's boot check.
#[must_use]
pub fn proxy_key_is_empty() -> bool {
    std::env::var("WADL_PROXY_KEY").is_ok_and(|k| k.is_empty())
}

/// The codes in `WADL_DEFAULT_ROLES` that name no role — the binary refuses
/// to boot with any, like the empty key: a default that silently granted
/// nothing would read as "proxy users are planners" to an operator and make
/// every pilot user a reader.
#[must_use]
pub fn unknown_default_roles() -> Vec<String> {
    std::env::var("WADL_DEFAULT_ROLES")
        .map(|raw| parse_role_codes(&raw).1)
        .unwrap_or_default()
}

/// The human name of the active trust mode, served by `/api/whoami` and
/// printed at startup so an operator can see which boundary is armed.
pub(crate) fn identity_mode() -> &'static str {
    if env().proxy_key.is_some() {
        "proxy-asserted"
    } else {
        "dev-headers"
    }
}

/// Constant-time byte equality. The comparison must not leak how much of a
/// guessed key matched; folding every byte pair before deciding means the
/// work done is independent of where the first mismatch sits. (Length is
/// compared first — key length is not a secret.)
fn ct_eq(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

/// The trust gate: decides whether this request may assert identity headers
/// at all. Split from the extractor (and handed the key) so tests can drive
/// both modes without touching process environment.
fn trust_gate(headers: &HeaderMap, key: Option<&str>) -> Result<(), ApiError> {
    let Some(key) = key else {
        return Ok(()); // dev shim: headers trusted as given
    };
    // An empty key can never admit anyone: a missing header presents as the
    // empty string, and the two must not match.
    if key.is_empty() {
        return Err(ApiError::Unauthorized);
    }
    let presented = header(headers, "x-wadl-proxy-key").unwrap_or("");
    if ct_eq(presented.as_bytes(), key.as_bytes()) {
        Ok(())
    } else {
        Err(ApiError::Unauthorized)
    }
}

fn header<'a>(headers: &'a HeaderMap, name: &str) -> Option<&'a str> {
    headers.get(name).and_then(|v| v.to_str().ok())
}

/// Resolves the caller from the identity headers under `env`. Shared by the
/// extractor and the capability gate so both judge the same person.
///
/// # Errors
/// [`ApiError::Unauthorized`] when the trust gate or the tenant header fails;
/// [`ApiError::IdentityRefused`] when proxy mode asserts no person, or a
/// person id is outside the contract's charset in either mode.
pub(crate) fn resolve(headers: &HeaderMap, env: &Env) -> Result<Caller, ApiError> {
    trust_gate(headers, env.proxy_key.as_deref())?;
    let proxy_mode = env.proxy_key.is_some();

    let org = header(headers, "x-org-id")
        .and_then(|s| s.parse::<Uuid>().ok())
        .map(OrgId::from_uuid)
        .ok_or(ApiError::Unauthorized)?;
    let assigned = header(headers, "x-assigned-vessels")
        .unwrap_or_default()
        .split(',')
        .filter(|s| !s.trim().is_empty())
        .filter_map(|s| s.trim().parse::<Uuid>().ok())
        .map(VesselId::from_uuid);

    let mut warnings = Vec::new();
    let actor = resolve_person(headers, proxy_mode, &mut warnings)?;
    let (roles, capabilities) = resolve_roles(headers, env, &mut warnings);

    Ok(Caller {
        scope: TenantScope::new(org, assigned).with_actor(actor),
        roles,
        capabilities,
        warnings,
    })
}

/// A person id is `[A-Za-z0-9._:@/-]{1,128}` — the charset every proxy can
/// emit and every ledger export can carry unescaped.
fn is_person_id(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= PERSON_ID_MAX
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"._:@/-".contains(&b))
}

/// The person: required in proxy mode, `dev:anonymous` on the shim without
/// one, refused in both modes when the id is outside the charset.
fn resolve_person(
    headers: &HeaderMap,
    proxy_mode: bool,
    warnings: &mut Vec<String>,
) -> Result<Actor, ApiError> {
    let Some(raw) = headers.get(PERSON_HEADER) else {
        if proxy_mode {
            return Err(ApiError::IdentityRefused(format!(
                "the proxy asserted no person ({PERSON_HEADER})"
            )));
        }
        return Ok(Actor::new(
            "dev:anonymous",
            "dev:anonymous",
            ActorSource::DevShimAnonymous,
        ));
    };
    let id = raw
        .to_str()
        .ok()
        .filter(|s| is_person_id(s))
        .ok_or_else(|| {
            ApiError::IdentityRefused(format!(
                "{PERSON_HEADER} is not a person id — expected [A-Za-z0-9._:@/-]{{1,{PERSON_ID_MAX}}}"
            ))
        })?;
    let name = resolve_name(headers, id, warnings);
    let source = if proxy_mode {
        ActorSource::Proxy
    } else {
        ActorSource::DevShim
    };
    Ok(Actor::new(id, name, source))
}

/// Why a display name fell back to the id, if it did.
fn name_fault(value: &axum::http::HeaderValue) -> Result<String, &'static str> {
    if value.len() > NAME_WIRE_MAX {
        return Err("is over 200 bytes on the wire");
    }
    let wire = value.to_str().map_err(|_| "is not percent-encoded ASCII")?;
    let decoded = percent_decode(wire).ok_or("did not decode as percent-encoded UTF-8")?;
    let decoded = decoded.trim();
    if decoded.is_empty() {
        return Err("is empty");
    }
    if decoded.chars().count() > NAME_CHARS_MAX {
        return Err("is over 120 characters");
    }
    if decoded.chars().any(char::is_control) {
        return Err("carries control characters");
    }
    Ok(decoded.to_owned())
}

/// The display name, or the id with a warning — a name bug never locks a
/// person out.
fn resolve_name(headers: &HeaderMap, id: &str, warnings: &mut Vec<String>) -> String {
    let Some(value) = headers.get(PERSON_NAME_HEADER) else {
        return id.to_owned();
    };
    match name_fault(value) {
        Ok(name) => name,
        Err(why) => {
            warnings.push(format!(
                "{PERSON_NAME_HEADER} {why} — showing the id instead"
            ));
            id.to_owned()
        }
    }
}

/// Percent-decoding as RFC 3986 spells it: `%XX` → byte, everything else
/// literal (`+` stays `+`; this is not a form body), the result UTF-8.
fn percent_decode(wire: &str) -> Option<String> {
    let bytes = wire.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        let b = *bytes.get(i)?;
        if b == b'%' {
            let hi = hex_digit(*bytes.get(i + 1)?)?;
            let lo = hex_digit(*bytes.get(i + 2)?)?;
            out.push(hi << 4 | lo);
            i += 3;
        } else {
            out.push(b);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

fn hex_digit(b: u8) -> Option<u8> {
    char::from(b)
        .to_digit(16)
        .and_then(|d| u8::try_from(d).ok())
}

/// Splits a comma-separated role list into the roles it names (sorted,
/// deduplicated) and the codes it did not — shared by the header and by
/// `WADL_DEFAULT_ROLES`.
fn parse_role_codes(raw: &str) -> (Vec<Role>, Vec<String>) {
    let mut roles = BTreeSet::new();
    let mut unknown = Vec::new();
    for code in raw.split(',').map(str::trim).filter(|s| !s.is_empty()) {
        match Role::parse(code) {
            Some(role) => {
                roles.insert(role);
            }
            None => unknown.push(printable(code)),
        }
    }
    (roles.into_iter().collect(), unknown)
}

/// A header token made safe to echo in a warning: word characters only,
/// bounded, so an unknown code never carries markup or a novel into `whoami`.
fn printable(code: &str) -> String {
    code.chars()
        .filter(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '.'))
        .take(32)
        .collect()
}

/// The roles and capabilities: from the header when present; from the
/// deployment's defaults (or `reader`) in proxy mode without one; every
/// capability on the shim without one, said out loud.
fn resolve_roles(
    headers: &HeaderMap,
    env: &Env,
    warnings: &mut Vec<String>,
) -> (Vec<Role>, BTreeSet<Capability>) {
    let asserted = header(headers, ROLES_HEADER).filter(|s| !s.trim().is_empty());
    match (asserted, env.proxy_key.is_some()) {
        (Some(raw), _) => {
            let (roles, unknown) = parse_role_codes(raw);
            for code in unknown {
                warnings.push(format!(
                    "{ROLES_HEADER} named an unknown role \"{code}\" — ignored"
                ));
            }
            let caps = roles::capabilities_of(&roles);
            (roles, caps)
        }
        (None, true) => {
            let roles = if env.default_roles.is_empty() {
                vec![Role::Reader]
            } else {
                let codes: Vec<&str> = env.default_roles.iter().map(|r| r.code()).collect();
                warnings.push(format!(
                    "no {ROLES_HEADER} asserted — WADL_DEFAULT_ROLES grants {}",
                    codes.join(", ")
                ));
                env.default_roles.clone()
            };
            let caps = roles::capabilities_of(&roles);
            (roles, caps)
        }
        (None, false) => {
            warnings.push(format!("demo mode: no {ROLES_HEADER} — every door is open"));
            (Vec::new(), roles::every_capability())
        }
    }
}

#[axum::async_trait]
impl<S: Send + Sync> FromRequestParts<S> for Caller {
    type Rejection = ApiError;

    async fn from_request_parts(parts: &mut Parts, _state: &S) -> Result<Self, Self::Rejection> {
        resolve(&parts.headers, env())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const ORG: &str = "00000000-0000-0000-0000-000000000001";
    const HULL: &str = "00000000-0000-0000-0000-000000000073";

    fn headers(pairs: &[(&str, &str)]) -> HeaderMap {
        let mut h = HeaderMap::new();
        for (k, v) in pairs {
            h.insert(
                axum::http::HeaderName::from_bytes(k.as_bytes()).unwrap(),
                axum::http::HeaderValue::from_str(v).unwrap(),
            );
        }
        h
    }

    fn identified(extra: &[(&str, &str)]) -> HeaderMap {
        let mut pairs = vec![("x-org-id", ORG), ("x-assigned-vessels", HULL)];
        pairs.extend_from_slice(extra);
        headers(&pairs)
    }

    fn detail(err: ApiError) -> String {
        match err {
            ApiError::IdentityRefused(d) => d,
            other => panic!("expected IdentityRefused, got {other:?}"),
        }
    }

    #[test]
    fn dev_mode_trusts_headers_as_given() {
        assert!(trust_gate(&headers(&[]), None).is_ok());
    }

    #[test]
    fn proxy_mode_refuses_without_the_key() {
        assert!(trust_gate(&headers(&[("x-org-id", ORG)]), Some("sekrit")).is_err());
    }

    #[test]
    fn proxy_mode_refuses_a_wrong_key() {
        let h = headers(&[("x-wadl-proxy-key", "wrong")]);
        assert!(trust_gate(&h, Some("sekrit")).is_err());
    }

    #[test]
    fn an_empty_key_admits_nobody() {
        // The empty-key hole: no header presents as "", and "" == "".
        assert!(trust_gate(&headers(&[]), Some("")).is_err());
        assert!(trust_gate(&headers(&[("x-wadl-proxy-key", "")]), Some("")).is_err());
    }

    #[test]
    fn proxy_mode_admits_the_right_key() {
        let h = headers(&[("x-wadl-proxy-key", "sekrit")]);
        assert!(trust_gate(&h, Some("sekrit")).is_ok());
    }

    #[test]
    fn ct_eq_agrees_with_ordinary_equality() {
        assert!(ct_eq(b"abc", b"abc"));
        assert!(!ct_eq(b"abc", b"abd"));
        assert!(!ct_eq(b"abc", b"ab"));
        assert!(ct_eq(b"", b""));
    }

    #[test]
    fn proxy_mode_refuses_a_request_with_no_person() {
        let env = Env::proxy("k", &[]);
        let err = resolve(&identified(&[("x-wadl-proxy-key", "k")]), &env).unwrap_err();
        assert_eq!(detail(err), "the proxy asserted no person (x-wadl-person)");

        // With one, the person is the proxy's.
        let caller = resolve(
            &identified(&[
                ("x-wadl-proxy-key", "k"),
                ("x-wadl-person", "1234567890"),
                ("x-wadl-person-name", "R.%20Alvarez"),
                ("x-wadl-roles", "safety"),
            ]),
            &env,
        )
        .unwrap();
        assert_eq!(caller.scope.actor.id, "1234567890");
        assert_eq!(caller.scope.actor.name, "R. Alvarez");
        assert_eq!(caller.scope.actor.source, ActorSource::Proxy);
        assert_eq!(caller.roles, vec![Role::Safety]);
        assert!(caller.warnings.is_empty());
    }

    #[test]
    fn dev_mode_synthesises_an_anonymous_person_and_says_so() {
        let caller = resolve(&identified(&[]), &Env::dev()).unwrap();
        assert_eq!(caller.scope.actor.id, "dev:anonymous");
        assert_eq!(caller.scope.actor.source, ActorSource::DevShimAnonymous);
        assert!(caller.roles.is_empty());
        assert_eq!(caller.capabilities, roles::every_capability());
        assert_eq!(
            caller.warnings,
            vec!["demo mode: no x-wadl-roles — every door is open"]
        );

        // A shim person is labelled as the shim's, not the proxy's.
        let named = resolve(
            &identified(&[
                ("x-wadl-person", "dev:planner"),
                ("x-wadl-person-name", "Demo%20Planner%20(Y-1001)"),
            ]),
            &Env::dev(),
        )
        .unwrap();
        assert_eq!(named.scope.actor.source, ActorSource::DevShim);
        assert_eq!(named.scope.actor.name, "Demo Planner (Y-1001)");
    }

    #[test]
    fn a_person_id_outside_the_charset_is_refused_in_both_modes() {
        for bad in ["R Alvarez", "", "x;drop", &"a".repeat(129), "ünïcode"] {
            let dev = resolve(&identified(&[("x-wadl-person", bad)]), &Env::dev());
            assert!(
                matches!(dev, Err(ApiError::IdentityRefused(_))),
                "dev mode admitted {bad:?}"
            );
            let proxy = resolve(
                &identified(&[("x-wadl-proxy-key", "k"), ("x-wadl-person", bad)]),
                &Env::proxy("k", &[]),
            );
            assert!(
                matches!(proxy, Err(ApiError::IdentityRefused(_))),
                "proxy mode admitted {bad:?}"
            );
        }
        for good in ["1234567890", "a.b-c_d:e@f/g", "Y-1001"] {
            assert!(is_person_id(good), "{good}");
        }
    }

    #[test]
    fn a_percent_encoded_name_decodes_and_a_bad_one_falls_back_to_the_id_with_a_warning() {
        assert_eq!(
            percent_decode("R.%20Alvarez%2C%20Jr.").as_deref(),
            Some("R. Alvarez, Jr.")
        );
        assert_eq!(percent_decode("Jos%C3%A9").as_deref(), Some("José"));
        assert_eq!(percent_decode("a+b").as_deref(), Some("a+b"));
        assert_eq!(percent_decode("bad%2"), None);
        assert_eq!(percent_decode("bad%ZZ"), None);
        assert_eq!(percent_decode("%FF"), None); // not UTF-8

        let cases = [
            ("bad%ZZ", "did not decode"),
            ("with%0Acontrol", "control characters"),
            (&"x".repeat(201), "over 200 bytes"),
            (&"x".repeat(121), "over 120 characters"),
            ("%20%20", "is empty"),
        ];
        for (wire, why) in cases {
            let caller = resolve(
                &identified(&[
                    ("x-wadl-person", "1234567890"),
                    ("x-wadl-person-name", wire),
                ]),
                &Env::dev(),
            )
            .unwrap();
            assert_eq!(caller.scope.actor.name, "1234567890", "{why}");
            assert!(
                caller
                    .warnings
                    .iter()
                    .any(|w| w.starts_with("x-wadl-person-name") && w.contains(why)),
                "{why}: {:?}",
                caller.warnings
            );
        }

        // No name header at all: the id, with nothing to warn about.
        let caller = resolve(&identified(&[("x-wadl-person", "1234567890")]), &Env::dev()).unwrap();
        assert_eq!(caller.scope.actor.name, "1234567890");
        assert!(caller
            .warnings
            .iter()
            .all(|w| !w.starts_with("x-wadl-person-name")));
    }

    #[test]
    fn roles_parse_and_unknown_codes_are_reported_not_granted() {
        let caller = resolve(
            &identified(&[("x-wadl-roles", "foreman, welder ,foreman,<b>x</b>")]),
            &Env::dev(),
        )
        .unwrap();
        assert_eq!(caller.roles, vec![Role::Foreman]);
        assert_eq!(
            caller.capabilities,
            BTreeSet::from([Capability::Read, Capability::RaiseHazard])
        );
        assert_eq!(
            caller.warnings,
            vec![
                "x-wadl-roles named an unknown role \"welder\" — ignored",
                "x-wadl-roles named an unknown role \"bxb\" — ignored",
            ]
        );

        // All unknown in proxy mode: read only, and the sentence says why.
        let caller = resolve(
            &identified(&[
                ("x-wadl-proxy-key", "k"),
                ("x-wadl-person", "1234567890"),
                ("x-wadl-roles", "welder"),
            ]),
            &Env::proxy("k", &[Role::Planner]),
        )
        .unwrap();
        assert!(caller.roles.is_empty());
        assert_eq!(caller.capabilities, BTreeSet::from([Capability::Read]));
    }

    #[test]
    fn default_roles_apply_only_in_proxy_mode_and_only_when_none_are_asserted() {
        let proxied = |env: &Env, extra: &[(&str, &str)]| {
            let mut pairs = vec![("x-wadl-proxy-key", "k"), ("x-wadl-person", "1234567890")];
            pairs.extend_from_slice(extra);
            resolve(&identified(&pairs), env).unwrap()
        };

        // Proxy, no roles, no defaults: reader.
        let caller = proxied(&Env::proxy("k", &[]), &[]);
        assert_eq!(caller.roles, vec![Role::Reader]);
        assert_eq!(caller.capabilities, BTreeSet::from([Capability::Read]));

        // Proxy, no roles, defaults: the defaults, said out loud.
        let caller = proxied(&Env::proxy("k", &[Role::Planner]), &[]);
        assert_eq!(caller.roles, vec![Role::Planner]);
        assert!(caller.capabilities.contains(&Capability::CommitDocument));
        assert_eq!(
            caller.warnings,
            vec!["no x-wadl-roles asserted — WADL_DEFAULT_ROLES grants planner"]
        );

        // Proxy, roles asserted: the defaults do not widen them.
        let caller = proxied(
            &Env::proxy("k", &[Role::Planner]),
            &[("x-wadl-roles", "foreman")],
        );
        assert_eq!(caller.roles, vec![Role::Foreman]);
        assert!(!caller.capabilities.contains(&Capability::CommitDocument));

        // Dev mode ignores defaults entirely: no roles means every door.
        let dev = Env {
            proxy_key: None,
            default_roles: vec![Role::Reader],
            markings: Vec::new(),
        };
        let caller = resolve(&identified(&[]), &dev).unwrap();
        assert!(caller.roles.is_empty());
        assert_eq!(caller.capabilities, roles::every_capability());

        assert_eq!(
            parse_role_codes("planner,nobody").1,
            vec!["nobody".to_owned()]
        );
    }
}
