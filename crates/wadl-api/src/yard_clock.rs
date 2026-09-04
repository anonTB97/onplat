//! The yard-clock door: the hull's clock as an authored document.
//!
//! Every clock in the product is served as a UTC instant; the yard reads a
//! wall clock. The document that joins the two — zone, offsets, an optional
//! daylight rule, the watch length, the shifts by the yard's names — enters
//! here, through the same door discipline as every other document: refused
//! whole with every reason, previewed with `?dry_run=true`, committed with a
//! ledger line, reverted with another. `wadl_domain::civil` evaluates it;
//! this module only validates, previews and stores.
//!
//! Also here: the CSV form the boot loader and the shell's picker read
//! ([`parse_clock_csv`]), and [`clock_in_effect`], which every handler that
//! needs the hull's clock (the timeframe, the XER door) reads through — so
//! the answer to "which clock is this hull on" has exactly one source.

use axum::extract::{Path, Query, State};
use axum::Json;
use serde_json::{json, Value};
use uuid::Uuid;

use wadl_domain::civil::{self, DaylightRule, ShiftDef, Transition, YardClock};
use wadl_domain::ids::VesselId;
use wadl_store::memory::YardClockDoc;
use wadl_store::{Repositories, TenantScope};

use crate::auth::Caller;
use crate::error::ApiError;
use crate::handlers::{ledger_document, read_import_body, DryRun};
use crate::AppState;

/// The clock a hull is on right now: its document's, or the UTC default.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ClockInEffect {
    /// The document's label, or `None` for the default.
    pub label: Option<String>,
    /// `document` or `default_utc` — served so nothing presents the default
    /// as a yard's claim.
    pub source: &'static str,
    /// The clock.
    pub clock: YardClock,
}

impl ClockInEffect {
    /// `America/New_York · CVN73-clock.csv` — the name a schedule of record
    /// carries for the clock it was parsed in.
    #[must_use]
    pub fn parsed_in(&self) -> String {
        format!(
            "{} · {}",
            self.clock.zone,
            self.label.as_deref().unwrap_or("default_utc")
        )
    }

    /// The `{ label, source, clock }` object the timeframe and the GET serve.
    #[must_use]
    pub fn summary(&self) -> Value {
        json!({
            "label": self.label,
            "source": self.source,
            "clock": self.clock,
        })
    }
}

/// Reads the hull's clock in effect. The one place the default is applied.
///
/// # Errors
/// [`ApiError::NotFound`] when the hull is outside `scope`.
pub(crate) async fn clock_in_effect(
    store: &dyn Repositories,
    scope: &TenantScope,
    vessel: VesselId,
) -> Result<ClockInEffect, ApiError> {
    Ok(match store.yard_clock(scope, vessel).await? {
        Some(doc) => ClockInEffect {
            label: Some(doc.label),
            source: "document",
            clock: doc.clock,
        },
        None => ClockInEffect {
            label: None,
            source: "default_utc",
            clock: YardClock::utc(),
        },
    })
}

/// `GET /api/vessels/:id/yard-clock` — the clock in effect, with the wall
/// clock and offset right now so a reader can check it against the window.
pub(crate) async fn get_yard_clock(
    State(state): State<AppState>,
    Caller(scope): Caller,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>, ApiError> {
    let vessel = VesselId::from_uuid(id);
    let effect = clock_in_effect(state.store.as_ref(), &scope, vessel).await?;
    let now = state.clock.now().epoch_millis();
    let mut body = effect.summary();
    if let Some(obj) = body.as_object_mut() {
        obj.insert(
            "now_local".to_owned(),
            json!(effect.clock.local(now).stamp()),
        );
        obj.insert(
            "offset_now".to_owned(),
            json!(YardClock::offset_label(effect.clock.offset_at(now))),
        );
    }
    Ok(Json(body))
}

/// The body of a yard-clock import.
#[derive(Debug, serde::Deserialize)]
pub(crate) struct ImportClock {
    /// Where the clock came from, e.g. `CVN73-clock.csv`.
    pub(crate) label: String,
    /// The clock itself.
    pub(crate) clock: YardClock,
}

/// `POST /api/vessels/:id/yard-clock[?dry_run=true]` — ingests the yard's
/// clock. Refused whole with every reason (422); findings warn without
/// refusing; the preview lists the year's transitions as local dates and
/// today's shifts as instants, so a mis-authored rule is visible before
/// Confirm.
pub(crate) async fn import_yard_clock(
    State(state): State<AppState>,
    Caller(scope): Caller,
    Path(id): Path<Uuid>,
    Query(dry): Query<DryRun>,
    req: axum::extract::Request,
) -> Result<Json<Value>, ApiError> {
    let vessel = VesselId::from_uuid(id);
    state.store.get_vessel(&scope, vessel).await?;
    let body: ImportClock = read_import_body(req).await?;

    let mut rejections = body.clock.validate();
    if body.label.trim().is_empty() {
        rejections.insert(0, "the clock carries no label".to_owned());
    }
    if !rejections.is_empty() {
        return Err(ApiError::OutOfRange(format!(
            "the clock was refused whole: {}",
            rejections.join("; ")
        )));
    }

    let now = state.clock.now().epoch_millis();
    let schedule = schedule_of_record_summary(state.store.as_ref(), &scope, vessel).await?;
    let findings = findings(&body.clock, schedule.as_ref());
    let preview = json!({
        "now_local": body.clock.local(now).stamp(),
        "offset_now": YardClock::offset_label(body.clock.offset_at(now)),
        "transitions": transitions(&body.clock, now),
        "shifts_today": shifts_today(&body.clock, now),
        "schedule_of_record": schedule.as_ref().map(|s| json!({
            "label": s.label,
            "parsed_in": s.parsed_in,
        })),
    });

    let doc = YardClockDoc {
        label: body.label,
        clock: body.clock,
    };
    if dry.dry_run.unwrap_or(false) {
        return Ok(Json(json!({
            "stored": false,
            "label": doc.label,
            "findings": findings,
            "preview": preview,
        })));
    }
    let label = doc.label.clone();
    let counts = json!({ "zone": doc.clock.zone, "shifts": doc.clock.shifts.len() });
    state.store.set_yard_clock(&scope, vessel, doc).await?;
    ledger_document(
        &state,
        &scope,
        vessel,
        "DOCUMENT_REPLACED",
        "yard_clock",
        Some(&label),
        counts,
    )
    .await?;
    Ok(Json(json!({
        "stored": true,
        "label": label,
        "findings": findings,
        "preview": preview,
    })))
}

/// `POST /api/vessels/:id/yard-clock/revert` — back to UTC, and every clock
/// on screen carries a `Z` again.
pub(crate) async fn revert_yard_clock(
    State(state): State<AppState>,
    Caller(scope): Caller,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>, ApiError> {
    let vessel = VesselId::from_uuid(id);
    state.store.clear_yard_clock(&scope, vessel).await?;
    ledger_document(
        &state,
        &scope,
        vessel,
        "DOCUMENT_REVERTED",
        "yard_clock",
        None,
        json!({}),
    )
    .await?;
    Ok(Json(json!({ "reverted": true })))
}

/// The served schedule of record, as the clock door needs it.
struct ScheduleSummary {
    label: String,
    parsed_in: Option<String>,
}

async fn schedule_of_record_summary(
    store: &dyn Repositories,
    scope: &TenantScope,
    vessel: VesselId,
) -> Result<Option<ScheduleSummary>, ApiError> {
    let Some(label) = store.schedule_source(scope, vessel).await? else {
        return Ok(None);
    };
    let parsed_in = store.schedule_parsed_in(scope, vessel).await?;
    Ok(Some(ScheduleSummary { label, parsed_in }))
}

fn warn(text: &str) -> Value {
    json!({ "severity": "warn", "text": text })
}

/// What the door says without refusing: shifts that leave the day open or
/// double-book part of it, and a schedule of record whose wall times were
/// read in a different clock than the one being loaded.
fn findings(clock: &YardClock, schedule: Option<&ScheduleSummary>) -> Vec<Value> {
    let mut out: Vec<Value> = clock.coverage_findings().iter().map(|t| warn(t)).collect();
    if let Some(s) = schedule {
        let parsed_zone = s
            .parsed_in
            .as_deref()
            .and_then(|p| p.split(" · ").next())
            .map(str::to_owned);
        match parsed_zone {
            Some(zone) if zone == clock.zone => {}
            Some(zone) => out.push(warn(&format!(
                "the schedule of record {} was parsed in {zone} — re-import {} to re-stamp its wall clock in {}",
                s.label, s.label, clock.zone
            ))),
            None => out.push(warn(&format!(
                "the schedule of record {} was parsed before the yard clock existed — re-import {} to re-stamp its wall clock in {}",
                s.label, s.label, clock.zone
            ))),
        }
    }
    out
}

/// This year's two clock changes as local dates and instants, in order —
/// what a reader checks a rule against. Empty for a yard whose clock does
/// not move.
fn transitions(clock: &YardClock, now_ms: i64) -> Vec<Value> {
    const MINUTE_MS: i64 = 60_000;
    let Some(rule) = &clock.daylight else {
        return Vec::new();
    };
    let (year, _, _) = civil::civil_from_days(now_ms.div_euclid(86_400_000));
    let standard = i64::from(clock.standard_offset_minutes);
    let daylight = i64::from(rule.offset_minutes);
    let describe = |t: &Transition, from: i64, to: i64| -> Value {
        let days = t.day_in(year);
        let minute = i64::from(t.minute_of_day);
        let at_ms = (days * 1440 + minute - from) * MINUTE_MS;
        let reads_after = (minute + to - from).rem_euclid(1440);
        json!({
            "at_ms": at_ms,
            "local": format!(
                "{} {} → {}",
                civil::date_label(days),
                civil::wall_label(t.minute_of_day),
                civil::wall_label(u16::try_from(reads_after).unwrap_or(0)),
            ),
            "to": YardClock::offset_label(i32::try_from(to).unwrap_or(0)),
        })
    };
    let mut out = vec![
        describe(&rule.start, standard, daylight),
        describe(&rule.end, daylight, standard),
    ];
    out.sort_by_key(|t| t.get("at_ms").and_then(Value::as_i64).unwrap_or(0));
    out
}

/// Today's shifts under this clock, as instants and as the yard reads them.
fn shifts_today(clock: &YardClock, now_ms: i64) -> Vec<Value> {
    let windows = clock.shift_windows(now_ms);
    clock
        .shifts
        .iter()
        .zip(windows)
        .map(|(def, (name, w))| {
            json!({
                "name": name,
                "start_ms": w.start.epoch_millis(),
                "end_ms": w.end.epoch_millis(),
                "local": shift_label(def),
            })
        })
        .collect()
}

/// `07:00–15:30`; a shift that ends at midnight reads `24:00`.
#[must_use]
pub fn shift_label(def: &ShiftDef) -> String {
    let end = u32::from(def.start_minute) + u32::from(def.length_minutes);
    let end_label = if end == 1440 {
        "24:00".to_owned()
    } else {
        civil::wall_label(u16::try_from(end % 1440).unwrap_or(0))
    };
    format!("{}–{end_label}", civil::wall_label(def.start_minute))
}

// ---------------------------------------------------------------------------
// The CSV form.
// ---------------------------------------------------------------------------

/// `±HH:MM` (or `HH:MM`) to minutes east of UTC.
fn parse_offset(line: usize, raw: &str) -> Result<i32, String> {
    let (sign, rest) = if let Some(rest) = raw.strip_prefix('-').or_else(|| raw.strip_prefix('−'))
    {
        (-1, rest)
    } else {
        (1, raw.strip_prefix('+').unwrap_or(raw))
    };
    let (h, m) =
        parse_hhmm(rest).ok_or_else(|| format!("line {line}: offset {raw:?} is not ±HH:MM"))?;
    Ok(sign * (i32::from(h) * 60 + i32::from(m)))
}

/// `HH:MM` to `(hours, minutes)`; `24:00` is allowed (a shift's end).
fn parse_hhmm(raw: &str) -> Option<(u16, u16)> {
    let (h, m) = raw.trim().split_once(':')?;
    let h: u16 = h.parse().ok()?;
    let m: u16 = m.parse().ok()?;
    ((h < 24 && m < 60) || (h == 24 && m == 0)).then_some((h, m))
}

fn parse_wall(line: usize, what: &str, raw: Option<&&str>) -> Result<u16, String> {
    raw.and_then(|s| parse_hhmm(s))
        .map(|(h, m)| h * 60 + m)
        .ok_or_else(|| {
            format!(
                "line {line}: {what} {:?} is not HH:MM",
                raw.copied().unwrap_or("")
            )
        })
}

const WEEKDAY_NAMES: [&str; 7] = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

fn parse_weekday(line: usize, raw: Option<&&str>) -> Result<u8, String> {
    let text = raw.copied().unwrap_or("").to_ascii_lowercase();
    if let Some(index) = WEEKDAY_NAMES.iter().position(|n| text.starts_with(n)) {
        return u8::try_from(index).map_err(|_| "weekday".to_owned());
    }
    text.parse::<u8>()
        .ok()
        .filter(|d| *d <= 6)
        .ok_or_else(|| format!("line {line}: weekday {text:?} is not sun..sat or 0–6"))
}

fn parse_small(line: usize, what: &str, raw: Option<&&str>) -> Result<u8, String> {
    raw.and_then(|s| s.parse::<u8>().ok()).ok_or_else(|| {
        format!(
            "line {line}: {what} {:?} is not a small whole number",
            raw.copied().unwrap_or("")
        )
    })
}

fn transition_from(line: usize, cols: &[&str]) -> Result<Transition, String> {
    Ok(Transition {
        month: parse_small(line, "month", cols.first())?,
        week: parse_small(line, "week", cols.get(1))?,
        weekday: parse_weekday(line, cols.get(2))?,
        minute_of_day: parse_wall(line, "transition time", cols.get(3))?,
    })
}

/// The yard clock's CSV form — the boot loader's and the shell picker's:
///
/// ```text
/// zone,America/New_York,-05:00
/// daylight,-04:00,3,2,sun,02:00,11,1,sun,02:00
/// watch,240
/// shift,Days,07:00,15:30
/// ```
///
/// Comments and blanks are skipped; a shift whose end is before its start
/// crosses midnight (`23:00,07:00` = 480 min); `24:00` ends a shift at
/// midnight. The result is parsed, not validated — the caller runs
/// [`YardClock::validate`] and refuses whole.
///
/// # Errors
/// The first row that cannot be carried, by line; or no `zone` row.
pub fn parse_clock_csv(text: &str) -> Result<YardClock, String> {
    let mut zone: Option<(String, i32)> = None;
    let mut daylight = None;
    let mut watch_minutes = 240_u16;
    let mut shifts = Vec::new();
    for (line, c) in crate::documents::rows(text) {
        match c.first().copied() {
            Some("zone") => {
                let name = c
                    .get(1)
                    .filter(|s| !s.is_empty())
                    .ok_or_else(|| format!("line {line}: no zone name"))?;
                let offset = c
                    .get(2)
                    .ok_or_else(|| format!("line {line}: no standard offset"))?;
                zone = Some(((*name).to_owned(), parse_offset(line, offset)?));
            }
            Some("daylight") => {
                let offset = c
                    .get(1)
                    .ok_or_else(|| format!("line {line}: no daylight offset"))?;
                daylight = Some(DaylightRule {
                    offset_minutes: parse_offset(line, offset)?,
                    start: transition_from(line, c.get(2..6).unwrap_or(&[]))?,
                    end: transition_from(line, c.get(6..10).unwrap_or(&[]))?,
                });
            }
            Some("watch") => {
                watch_minutes = c
                    .get(1)
                    .and_then(|s| s.parse::<u16>().ok())
                    .ok_or_else(|| format!("line {line}: watch length is not whole minutes"))?;
            }
            Some("shift") => {
                let name = c
                    .get(1)
                    .filter(|s| !s.is_empty())
                    .ok_or_else(|| format!("line {line}: a shift has no name"))?;
                let start = parse_wall(line, "shift start", c.get(2))?;
                let end = parse_wall(line, "shift end", c.get(3))?;
                let length = (i32::from(end) - i32::from(start)).rem_euclid(1440);
                if length == 0 {
                    return Err(format!("line {line}: shift {name} ends when it starts"));
                }
                shifts.push(ShiftDef {
                    name: (*name).to_owned(),
                    start_minute: start,
                    length_minutes: u16::try_from(length).unwrap_or(0),
                });
            }
            other => {
                return Err(format!(
                    "line {line}: unrecognised record kind {:?} — every line must start with zone, daylight, watch, or shift,",
                    other.unwrap_or("")
                ))
            }
        }
    }
    let (zone, standard_offset_minutes) =
        zone.ok_or("no zone row — the clock must name its zone")?;
    Ok(YardClock {
        zone,
        standard_offset_minutes,
        daylight,
        watch_minutes,
        shifts,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const NORFOLK: &str = "\
# CVN-73 yard clock — Norfolk.
zone,America/New_York,-05:00
daylight,-04:00,3,2,sun,02:00,11,1,sun,02:00
watch,240
shift,Days,07:00,15:30
shift,Swing,15:30,24:00
shift,Mids,00:00,07:00
";

    #[test]
    fn the_csv_form_parses_the_reference_clock() {
        let clock = parse_clock_csv(NORFOLK).unwrap();
        assert_eq!(clock.zone, "America/New_York");
        assert_eq!(clock.standard_offset_minutes, -300);
        let rule = clock.daylight.unwrap();
        assert_eq!(rule.offset_minutes, -240);
        assert_eq!(
            (rule.start.month, rule.start.week, rule.start.weekday),
            (3, 2, 0)
        );
        assert_eq!(rule.end.minute_of_day, 120);
        assert_eq!(clock.watch_minutes, 240);
        let lengths: Vec<u16> = clock.shifts.iter().map(|s| s.length_minutes).collect();
        assert_eq!(lengths, vec![510, 510, 420]);
        assert!(clock.validate().is_empty());
        assert_eq!(shift_label(&clock.shifts[1]), "15:30–24:00");
    }

    #[test]
    fn a_shift_ending_before_it_starts_crosses_midnight() {
        let clock =
            parse_clock_csv("zone,Pacific/Guam,+10:00\nshift,Nights,23:00,07:00\n").unwrap();
        assert!(clock.daylight.is_none());
        assert_eq!(clock.shifts[0].length_minutes, 480);
        assert_eq!(shift_label(&clock.shifts[0]), "23:00–07:00");
    }

    #[test]
    fn a_bad_row_refuses_the_file_by_line() {
        let err = parse_clock_csv("zone,UTC,+00:00\nwatch,lots\n").unwrap_err();
        assert!(err.contains("line 2"), "{err}");
        let err = parse_clock_csv("shift,Days,07:00,15:30\n").unwrap_err();
        assert!(err.contains("no zone row"), "{err}");
        let err = parse_clock_csv("zone,UTC,+00:00\nlunch,12:00\n").unwrap_err();
        assert!(err.contains("lunch"), "{err}");
    }

    #[test]
    fn the_preview_lists_this_years_transitions_in_order() {
        let clock = parse_clock_csv(NORFOLK).unwrap();
        // 2026-09-04 13:15Z.
        let list = transitions(&clock, 1_788_527_700_000);
        assert_eq!(list.len(), 2);
        assert_eq!(list[0]["local"], "2026-03-08 02:00 → 03:00");
        assert_eq!(list[0]["to"], "UTC−04:00");
        assert_eq!(list[0]["at_ms"], 1_772_953_200_000_i64);
        assert_eq!(list[1]["local"], "2026-11-01 02:00 → 01:00");
        assert_eq!(list[1]["to"], "UTC−05:00");
        assert_eq!(list[1]["at_ms"], 1_793_512_800_000_i64);
        assert!(transitions(&YardClock::utc(), 0).is_empty());
    }
}
