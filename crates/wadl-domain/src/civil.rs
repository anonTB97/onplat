//! Civil time: the yard's clock, evaluated without a tz database.
//!
//! Every instant in the platform is a UTC epoch-millisecond [`Timestamp`].
//! The yard, though, lives on a wall clock — the scheduler types `06:00`
//! into P6, the day shift starts at `07:00`, the watch turns over at `04:00`
//! — and the two must be converted honestly, in both directions, on both
//! sides of the wire. This module is the server's half of that conversion;
//! `shell-web/src/yardClock.ts` is the mirror, and
//! `reference/clock/yard-clock-vectors.json` pins the two to the same
//! instants (its numbers come from the IANA database, not from either
//! implementation).
//!
//! A [`YardClock`] is an *authored* document: an IANA zone name, a standard
//! offset, an optional daylight rule as two nth-weekday transitions, the
//! watch length and the yard's shifts by the yard's names. That is enough
//! for every rule a legislature has written in living memory, and it is the
//! yard's own signed claim about its clock rather than a compiled table that
//! has to be re-released whenever a clock law changes. Nothing here reads
//! the wall clock, allocates beyond `String`/`Vec`, or needs anything a wasm
//! build lacks.

use crate::time::{Timestamp, Window};

const MINUTE_MS: i64 = 60_000;
const DAY_MINUTES: i64 = 1440;
const DAY_MS: i64 = DAY_MINUTES * MINUTE_MS;

/// Days since 1970-01-01 for a proleptic Gregorian civil date.
///
/// Howard Hinnant's arithmetic: exact over the whole `i32` year range, no
/// table, no branch on leap years.
#[must_use]
pub fn days_from_civil(y: i32, m: u8, d: u8) -> i64 {
    let year = i64::from(y) - i64::from(m <= 2);
    let era = year.div_euclid(400);
    let year_of_era = year - era * 400;
    let month = i64::from(m);
    let shifted_month = if month > 2 { month - 3 } else { month + 9 };
    let day_of_year = (153 * shifted_month + 2) / 5 + i64::from(d) - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    era * 146_097 + day_of_era - 719_468
}

/// The civil date `(year, month, day)` of a day count since 1970-01-01 —
/// the inverse of [`days_from_civil`].
#[must_use]
pub fn civil_from_days(days: i64) -> (i32, u8, u8) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let day_of_era = z - era * 146_097;
    let year_of_era =
        (day_of_era - day_of_era / 1460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let shifted_month = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * shifted_month + 2) / 5 + 1;
    let month = if shifted_month < 10 {
        shifted_month + 3
    } else {
        shifted_month - 9
    };
    let year = year_of_era + era * 400 + i64::from(month <= 2);
    (
        i32::try_from(year).unwrap_or(i32::MAX),
        narrow_u8(month),
        narrow_u8(day),
    )
}

/// The weekday of a day count: `0` = Sunday … `6` = Saturday.
#[must_use]
pub fn weekday(days: i64) -> u8 {
    // 1970-01-01 was a Thursday.
    narrow_u8((days + 4).rem_euclid(7))
}

fn narrow_u8(v: i64) -> u8 {
    u8::try_from(v).unwrap_or(u8::MAX)
}

fn narrow_u16(v: i64) -> u16 {
    u16::try_from(v).unwrap_or(u16::MAX)
}

/// `2026-03-08` for a day count.
#[must_use]
pub fn date_label(days: i64) -> String {
    let (y, m, d) = civil_from_days(days);
    format!("{y:04}-{m:02}-{d:02}")
}

/// `02:30` for a minute of the day (`24:00` for minute 1440).
#[must_use]
pub fn wall_label(minute_of_day: u16) -> String {
    format!("{:02}:{:02}", minute_of_day / 60, minute_of_day % 60)
}

/// One clock change, as a law writes it: the nth weekday of a month, at a
/// wall-clock minute *as the clock reads at the moment it moves* (US: 02:00
/// both ways; EU: 02:00 going forward, 03:00 coming back).
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct Transition {
    /// 1–12.
    pub month: u8,
    /// 1–5; 5 means "the last such weekday of the month".
    pub week: u8,
    /// 0 = Sunday … 6 = Saturday.
    pub weekday: u8,
    /// The wall-clock minute the change happens at, 0–1439.
    pub minute_of_day: u16,
}

impl Transition {
    /// The day count of this transition in `year`. Total: an out-of-range
    /// field yields *a* day rather than a panic, and [`YardClock::validate`]
    /// is where the field is refused.
    #[must_use]
    pub fn day_in(self, year: i32) -> i64 {
        let month = self.month.clamp(1, 12);
        let first = days_from_civil(year, month, 1);
        let wanted = i64::from(self.weekday % 7);
        if self.week >= 5 {
            let next_month = if month == 12 {
                days_from_civil(year.saturating_add(1), 1, 1)
            } else {
                days_from_civil(year, month + 1, 1)
            };
            let last = next_month - 1;
            last - (i64::from(weekday(last)) - wanted).rem_euclid(7)
        } else {
            let week = i64::from(self.week.max(1) - 1);
            first + (wanted - i64::from(weekday(first))).rem_euclid(7) + week * 7
        }
    }

    /// The UTC instant of this transition in `year`, given the offset the
    /// wall clock reads *before* it moves.
    fn utc_ms_in(self, year: i32, offset_before: i32) -> i64 {
        (self.day_in(year) * DAY_MINUTES + i64::from(self.minute_of_day) - i64::from(offset_before))
            * MINUTE_MS
    }

    fn problems(self, what: &str, out: &mut Vec<String>) {
        if !(1..=12).contains(&self.month) {
            out.push(format!("{what}: month {} is not 1–12", self.month));
        }
        if !(1..=5).contains(&self.week) {
            out.push(format!("{what}: week {} is not 1–5", self.week));
        }
        if self.weekday > 6 {
            out.push(format!("{what}: weekday {} is not 0–6", self.weekday));
        }
        if self.minute_of_day >= 1440 {
            out.push(format!(
                "{what}: minute {} is not inside the day",
                self.minute_of_day
            ));
        }
    }
}

/// A daylight-time rule: the offset in force between two transitions.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct DaylightRule {
    /// The offset while daylight time is in force, minutes east of UTC.
    pub offset_minutes: i32,
    /// When the clock goes forward (wall time read in standard time).
    pub start: Transition,
    /// When the clock goes back (wall time read in daylight time).
    pub end: Transition,
}

impl DaylightRule {
    /// Whether daylight time is in force at `utc_ms`, under `standard`.
    ///
    /// The year is the UTC civil year of the instant. Northern rules
    /// (start month before end month) are in force between the two; a
    /// southern rule (start month after end month) is in force *except*
    /// between end and start — daylight time across the new year.
    fn in_force(&self, standard: i32, utc_ms: i64) -> bool {
        let (year, _, _) = civil_from_days(utc_ms.div_euclid(DAY_MS));
        let start = self.start.utc_ms_in(year, standard);
        let end = self.end.utc_ms_in(year, self.offset_minutes);
        if self.start.month <= self.end.month {
            utc_ms >= start && utc_ms < end
        } else {
            !(utc_ms >= end && utc_ms < start)
        }
    }
}

/// One of the yard's shifts, by the yard's name.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct ShiftDef {
    /// `Days`, `Swing`, `Mids` — whatever the yard calls it.
    pub name: String,
    /// The wall-clock minute it starts, 0–1439.
    pub start_minute: u16,
    /// How long it runs, 1–1440; a shift may cross midnight.
    pub length_minutes: u16,
}

/// The yard's clock: the authored document evaluated here and in the shell.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct YardClock {
    /// The IANA zone name (`America/New_York`), or `UTC`.
    pub zone: String,
    /// The standard offset, minutes east of UTC.
    pub standard_offset_minutes: i32,
    /// The daylight rule, or `None` for a yard whose clock never moves.
    #[serde(default)]
    pub daylight: Option<DaylightRule>,
    /// The watch length in minutes; must divide the day.
    pub watch_minutes: u16,
    /// The shifts, in the order the yard lists them.
    pub shifts: Vec<ShiftDef>,
}

/// A wall-clock reading of a UTC instant.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LocalTime {
    /// The local calendar date as a day count (see [`civil_from_days`]).
    pub days: i64,
    /// Minute of the local day, 0–1439.
    pub minute_of_day: u16,
    /// Milliseconds into that minute.
    pub millis_of_minute: u32,
    /// The offset in force at the instant, minutes east of UTC.
    pub offset_minutes: i32,
}

impl LocalTime {
    /// `2026-09-04 09:15`.
    #[must_use]
    pub fn stamp(&self) -> String {
        format!(
            "{} {}",
            date_label(self.days),
            wall_label(self.minute_of_day)
        )
    }
}

/// What a wall-clock reading did not say plainly: the time never happened
/// on that date (spring forward) or happened twice (fall back).
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WallNote {
    /// The wall time falls in the hour the clock skipped.
    Gap,
    /// The wall time falls in the hour the clock repeated.
    Overlap,
}

/// The rejection, if any, of an offset: within ±14 h and on a quarter hour.
fn offset_problem(minutes: i32) -> Option<String> {
    if minutes.abs() > 14 * 60 {
        Some(format!("{minutes} min is outside ±14 h"))
    } else if minutes % 15 != 0 {
        Some(format!("{minutes} min is not a multiple of 15"))
    } else {
        None
    }
}

/// `UTC`, or `Area/City` in the IANA spelling — letters, digits, `_`, `-`,
/// `+`, with at least one `/`.
fn zone_is_well_formed(zone: &str) -> bool {
    if zone == "UTC" {
        return true;
    }
    let mut parts = zone.split('/');
    let mut count = 0;
    for part in parts.by_ref() {
        count += 1;
        if part.is_empty()
            || !part
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '+'))
        {
            return false;
        }
    }
    count >= 2
}

impl YardClock {
    /// The clock in effect when no document has been loaded: UTC, no
    /// daylight rule, four-hour watches, the three demo shifts. Served with
    /// `source: default_utc` so nothing presents it as a yard's claim.
    #[must_use]
    pub fn utc() -> Self {
        Self {
            zone: "UTC".to_owned(),
            standard_offset_minutes: 0,
            daylight: None,
            watch_minutes: 240,
            shifts: vec![
                ShiftDef {
                    name: "Days".to_owned(),
                    start_minute: 420,
                    length_minutes: 510,
                },
                ShiftDef {
                    name: "Swing".to_owned(),
                    start_minute: 930,
                    length_minutes: 510,
                },
                ShiftDef {
                    name: "Mids".to_owned(),
                    start_minute: 0,
                    length_minutes: 420,
                },
            ],
        }
    }

    /// Every reason this clock must be refused whole. Empty means valid.
    #[must_use]
    pub fn validate(&self) -> Vec<String> {
        let mut out = Vec::new();
        if !zone_is_well_formed(&self.zone) {
            out.push(format!(
                "zone {:?} is not an IANA Area/City name or UTC",
                self.zone
            ));
        }
        if let Some(reason) = offset_problem(self.standard_offset_minutes) {
            out.push(format!("standard offset {reason}"));
        }
        if let Some(rule) = &self.daylight {
            if let Some(reason) = offset_problem(rule.offset_minutes) {
                out.push(format!("daylight offset {reason}"));
            }
            if rule.offset_minutes == self.standard_offset_minutes {
                out.push(
                    "daylight offset equals the standard offset — drop the rule for a yard whose clock does not move"
                        .to_owned(),
                );
            }
            rule.start.problems("daylight start", &mut out);
            rule.end.problems("daylight end", &mut out);
        }
        if !(60..=720).contains(&self.watch_minutes) || 1440 % self.watch_minutes != 0 {
            out.push(format!(
                "a watch of {} min must be 60–720 and divide the day",
                self.watch_minutes
            ));
        }
        self.shift_problems(&mut out);
        out
    }

    fn shift_problems(&self, out: &mut Vec<String>) {
        if self.shifts.is_empty() {
            out.push("no shifts".to_owned());
        }
        if self.shifts.len() > 6 {
            out.push(format!("{} shifts is more than six", self.shifts.len()));
        }
        let mut seen: Vec<&str> = Vec::new();
        for shift in &self.shifts {
            let name = shift.name.trim();
            if name.is_empty() {
                out.push("a shift has no name".to_owned());
            } else if seen.contains(&name) {
                out.push(format!("shift {name} is listed twice"));
            } else {
                seen.push(name);
            }
            if shift.start_minute >= 1440 {
                out.push(format!(
                    "shift {name} starts at minute {}, outside the day",
                    shift.start_minute
                ));
            }
            if !(1..=1440).contains(&shift.length_minutes) {
                out.push(format!(
                    "shift {name} runs {} min, not 1–1440",
                    shift.length_minutes
                ));
            }
        }
    }

    /// Findings, not refusals: the minutes of the day no shift covers and
    /// the minutes two shifts both claim. A two-shift yard leaves the night
    /// open on purpose; the door says so and lets a person confirm it.
    #[must_use]
    pub fn coverage_findings(&self) -> Vec<String> {
        let mut cover = vec![0_u8; 1440];
        for shift in &self.shifts {
            for k in 0..usize::from(shift.length_minutes.min(1440)) {
                let minute = (usize::from(shift.start_minute) + k) % 1440;
                if let Some(c) = cover.get_mut(minute) {
                    *c = c.saturating_add(1);
                }
            }
        }
        let mut out = Vec::new();
        for (lo, hi) in runs(&cover, |c| c == 0) {
            out.push(format!(
                "the shifts leave {}–{} uncovered",
                wall_label(lo),
                wall_label(hi)
            ));
        }
        for (lo, hi) in runs(&cover, |c| c >= 2) {
            out.push(format!(
                "the shifts overlap {}–{}",
                wall_label(lo),
                wall_label(hi)
            ));
        }
        out
    }

    /// The offset in force at a UTC instant, minutes east of UTC.
    #[must_use]
    pub fn offset_at(&self, utc_ms: i64) -> i32 {
        match &self.daylight {
            Some(rule) if rule.in_force(self.standard_offset_minutes, utc_ms) => {
                rule.offset_minutes
            }
            _ => self.standard_offset_minutes,
        }
    }

    /// The wall-clock reading of a UTC instant.
    #[must_use]
    pub fn local(&self, utc_ms: i64) -> LocalTime {
        let offset = self.offset_at(utc_ms);
        let shifted = utc_ms.saturating_add(i64::from(offset) * MINUTE_MS);
        let rem = shifted.rem_euclid(DAY_MS);
        LocalTime {
            days: shifted.div_euclid(DAY_MS),
            minute_of_day: narrow_u16(rem / MINUTE_MS),
            millis_of_minute: u32::try_from(rem % MINUTE_MS).unwrap_or(0),
            offset_minutes: offset,
        }
    }

    /// The UTC instant of a wall-clock reading on a local date, and what
    /// the reading did not say plainly.
    ///
    /// Two candidates: the reading taken in standard time and the reading
    /// taken in daylight time. Each is valid iff the rule agrees with it at
    /// the instant it names. Both valid is the repeated hour — the first
    /// occurrence (daylight) wins, with [`WallNote::Overlap`]. Neither is
    /// the skipped hour — read as standard, with [`WallNote::Gap`], which
    /// lands on the instant the clock reached when it jumped. `minute_of_day`
    /// may run past 1439; the date carries.
    #[must_use]
    pub fn to_utc(&self, days: i64, minute_of_day: u16) -> (i64, Option<WallNote>) {
        let wall = days * DAY_MINUTES + i64::from(minute_of_day);
        let standard = (wall - i64::from(self.standard_offset_minutes)) * MINUTE_MS;
        let Some(rule) = &self.daylight else {
            return (standard, None);
        };
        let daylight = (wall - i64::from(rule.offset_minutes)) * MINUTE_MS;
        let standard_valid = !rule.in_force(self.standard_offset_minutes, standard);
        let daylight_valid = rule.in_force(self.standard_offset_minutes, daylight);
        match (standard_valid, daylight_valid) {
            (true, true) => (daylight, Some(WallNote::Overlap)),
            (false, false) => (standard, Some(WallNote::Gap)),
            (true, false) => (standard, None),
            (false, true) => (daylight, None),
        }
    }

    /// The UTC instant the local calendar day containing `utc_ms` began.
    #[must_use]
    pub fn day_start(&self, utc_ms: i64) -> i64 {
        self.to_utc(self.local(utc_ms).days, 0).0
    }

    /// The UTC instant the next local calendar day begins.
    #[must_use]
    pub fn next_day_start(&self, utc_ms: i64) -> i64 {
        self.to_utc(self.local(utc_ms).days + 1, 0).0
    }

    fn watch_length(&self) -> i64 {
        i64::from(self.watch_minutes.max(1))
    }

    /// The watch index (0-based) and local date of the watch containing `utc_ms`.
    fn watch_of(&self, utc_ms: i64) -> (i64, i64) {
        let local = self.local(utc_ms);
        (
            local.days,
            i64::from(local.minute_of_day) / self.watch_length(),
        )
    }

    /// The UTC instant the watch containing `utc_ms` began. Watches are
    /// bounded by wall-clock minutes that are multiples of the watch length
    /// on the local date, so the `00–04` watch is five hours on the fall-back
    /// night and three on the spring-forward night — and still reads `00–04`.
    #[must_use]
    pub fn watch_start(&self, utc_ms: i64) -> i64 {
        let (days, index) = self.watch_of(utc_ms);
        self.to_utc(days, narrow_u16(index * self.watch_length())).0
    }

    /// The UTC instant the watch containing `utc_ms` ends.
    #[must_use]
    pub fn watch_end(&self, utc_ms: i64) -> i64 {
        let (days, index) = self.watch_of(utc_ms);
        self.to_utc(days, narrow_u16((index + 1) * self.watch_length()))
            .0
    }

    /// Every watch of the local calendar day containing `utc_ms`, in order.
    #[must_use]
    pub fn watches_of(&self, utc_ms: i64) -> Vec<Window> {
        let days = self.local(utc_ms).days;
        let length = self.watch_length();
        (0..DAY_MINUTES / length)
            .map(|index| {
                Window::new(
                    Timestamp::from_epoch_millis(self.to_utc(days, narrow_u16(index * length)).0),
                    Timestamp::from_epoch_millis(
                        self.to_utc(days, narrow_u16((index + 1) * length)).0,
                    ),
                )
            })
            .collect()
    }

    /// The shifts that belong to the local calendar day containing `utc_ms`
    /// — each on the date its start falls on, running its full length even
    /// across midnight.
    #[must_use]
    pub fn shift_windows(&self, utc_ms: i64) -> Vec<(String, Window)> {
        let days = self.local(utc_ms).days;
        self.shifts
            .iter()
            .map(|shift| {
                let start = self.to_utc(days, shift.start_minute).0;
                let end = self
                    .to_utc(
                        days,
                        shift.start_minute.saturating_add(shift.length_minutes),
                    )
                    .0;
                (
                    shift.name.clone(),
                    Window::new(
                        Timestamp::from_epoch_millis(start),
                        Timestamp::from_epoch_millis(end),
                    ),
                )
            })
            .collect()
    }

    /// `UTC−04:00` — the offset as the time strip shows it, with a real
    /// minus sign.
    #[must_use]
    pub fn offset_label(minutes: i32) -> String {
        let sign = if minutes < 0 { '−' } else { '+' };
        let magnitude = minutes.abs();
        format!("UTC{sign}{:02}:{:02}", magnitude / 60, magnitude % 60)
    }
}

/// Maximal runs of minutes satisfying `pred`, as `[lo, hi)` in minutes.
fn runs(cover: &[u8], pred: impl Fn(u8) -> bool) -> Vec<(u16, u16)> {
    let mut out = Vec::new();
    let mut open: Option<u16> = None;
    for (minute, &count) in cover.iter().enumerate() {
        let minute = narrow_u16(i64::try_from(minute).unwrap_or(i64::MAX));
        match (open, pred(count)) {
            (None, true) => open = Some(minute),
            (Some(lo), false) => {
                out.push((lo, minute));
                open = None;
            }
            _ => {}
        }
    }
    if let Some(lo) = open {
        out.push((lo, 1440));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    const VECTORS: &str = include_str!("../../../reference/clock/yard-clock-vectors.json");

    fn vectors() -> Value {
        serde_json::from_str(VECTORS).expect("the vector file parses")
    }

    fn clock(v: &Value, name: &str) -> YardClock {
        serde_json::from_value(v["clocks"][name].clone()).expect("a clock in the vector file")
    }

    fn norfolk() -> YardClock {
        clock(&vectors(), "norfolk")
    }

    fn days(date: &str) -> i64 {
        let mut parts = date.split('-').map(|p| p.parse::<i64>().unwrap());
        let (y, m, d) = (
            parts.next().unwrap(),
            parts.next().unwrap(),
            parts.next().unwrap(),
        );
        days_from_civil(
            i32::try_from(y).unwrap(),
            u8::try_from(m).unwrap(),
            u8::try_from(d).unwrap(),
        )
    }

    #[test]
    fn the_shared_vectors_hold() {
        let v = vectors();
        for case in v["offset_at"].as_array().unwrap() {
            let c = clock(&v, case["clock"].as_str().unwrap());
            assert_eq!(
                i64::from(c.offset_at(case["utc_ms"].as_i64().unwrap())),
                case["minutes"].as_i64().unwrap(),
                "offset_at {case}"
            );
        }
        for case in v["to_utc"].as_array().unwrap() {
            let c = clock(&v, case["clock"].as_str().unwrap());
            let (ms, note) = c.to_utc(
                days(case["date"].as_str().unwrap()),
                u16::try_from(case["minute_of_day"].as_u64().unwrap()).unwrap(),
            );
            assert_eq!(ms, case["utc_ms"].as_i64().unwrap(), "to_utc {case}");
            let expected = match case["note"].as_str() {
                Some("gap") => Some(WallNote::Gap),
                Some("overlap") => Some(WallNote::Overlap),
                _ => None,
            };
            assert_eq!(note, expected, "to_utc note {case}");
        }
        for case in v["day_start"].as_array().unwrap() {
            let c = clock(&v, case["clock"].as_str().unwrap());
            let at = case["utc_ms"].as_i64().unwrap();
            assert_eq!(
                c.day_start(at),
                case["start_ms"].as_i64().unwrap(),
                "{case}"
            );
            assert_eq!(
                c.next_day_start(at),
                case["next_ms"].as_i64().unwrap(),
                "{case}"
            );
        }
        for case in v["watch_start"].as_array().unwrap() {
            let c = clock(&v, case["clock"].as_str().unwrap());
            let at = case["utc_ms"].as_i64().unwrap();
            assert_eq!(
                c.watch_start(at),
                case["start_ms"].as_i64().unwrap(),
                "{case}"
            );
            assert_eq!(c.watch_end(at), case["end_ms"].as_i64().unwrap(), "{case}");
        }
        for case in v["watches_of"].as_array().unwrap() {
            let c = clock(&v, case["clock"].as_str().unwrap());
            let watches = c.watches_of(case["utc_ms"].as_i64().unwrap());
            let starts: Vec<i64> = watches.iter().map(|w| w.start.epoch_millis()).collect();
            let ends: Vec<i64> = watches.iter().map(|w| w.end.epoch_millis()).collect();
            assert_eq!(serde_json::json!(starts), case["starts"], "{case}");
            assert_eq!(serde_json::json!(ends), case["ends"], "{case}");
            let labels: Vec<String> = (0..watches.len())
                .map(|k| {
                    let lo = k * usize::from(c.watch_minutes);
                    format!(
                        "{:02}–{:02}",
                        lo / 60,
                        (lo + usize::from(c.watch_minutes)) / 60
                    )
                })
                .collect();
            assert_eq!(serde_json::json!(labels), case["labels"], "{case}");
        }
        for case in v["shift_windows"].as_array().unwrap() {
            let c = clock(&v, case["clock"].as_str().unwrap());
            let windows: Vec<Value> = c
                .shift_windows(case["utc_ms"].as_i64().unwrap())
                .into_iter()
                .map(|(name, w)| {
                    serde_json::json!({
                        "name": name,
                        "start_ms": w.start.epoch_millis(),
                        "end_ms": w.end.epoch_millis(),
                    })
                })
                .collect();
            assert_eq!(serde_json::json!(windows), case["windows"], "{case}");
        }
    }

    #[test]
    fn civil_days_round_trip_over_four_centuries() {
        let mut expected = days_from_civil(1900, 1, 1);
        for year in 1900..2300 {
            for month in 1..=12_u8 {
                let next = if month == 12 {
                    days_from_civil(year + 1, 1, 1)
                } else {
                    days_from_civil(year, month + 1, 1)
                };
                let length = next - days_from_civil(year, month, 1);
                for day in 1..=u8::try_from(length).unwrap() {
                    let d = days_from_civil(year, month, day);
                    assert_eq!(d, expected, "{year}-{month}-{day}");
                    assert_eq!(civil_from_days(d), (year, month, day));
                    expected += 1;
                }
            }
        }
        assert_eq!(days_from_civil(1970, 1, 1), 0);
        assert_eq!(weekday(0), 4, "1970-01-01 was a Thursday");
        assert_eq!(weekday(days("2026-09-04")), 5, "a Friday");
    }

    #[test]
    fn a_wall_time_in_the_spring_gap_resolves_standard_and_says_gap() {
        let c = norfolk();
        // 2026-03-08 02:30 never happened in Norfolk; read as 02:30 EST = 07:30Z.
        let (ms, note) = c.to_utc(days("2026-03-08"), 150);
        assert_eq!(note, Some(WallNote::Gap));
        assert_eq!(c.local(ms).stamp(), "2026-03-08 03:30");
        assert_eq!(YardClock::utc().local(ms).stamp(), "2026-03-08 07:30");
    }

    #[test]
    fn a_wall_time_in_the_autumn_overlap_takes_the_first_occurrence() {
        let c = norfolk();
        let (ms, note) = c.to_utc(days("2026-11-01"), 90);
        assert_eq!(note, Some(WallNote::Overlap));
        assert_eq!(
            c.offset_at(ms),
            -240,
            "the daylight reading, an hour earlier"
        );
        assert_eq!(YardClock::utc().local(ms).stamp(), "2026-11-01 05:30");
        // The 00–04 watch runs five hours that night, and still reads 00–04.
        let watches = c.watches_of(ms);
        let first = watches.first().unwrap();
        assert_eq!(
            first.end.epoch_millis() - first.start.epoch_millis(),
            5 * 3_600_000
        );
    }

    #[test]
    fn a_southern_rule_is_daylight_in_january() {
        let c = clock(&vectors(), "sydney");
        let january = days("2026-01-15") * DAY_MS;
        assert_eq!(c.offset_at(january), 660);
        let july = days("2026-07-01") * DAY_MS;
        assert_eq!(c.offset_at(july), 600);
        assert_eq!(YardClock::offset_label(660), "UTC+11:00");
        assert_eq!(YardClock::offset_label(-240), "UTC−04:00");
    }

    #[test]
    fn validate_refuses_a_watch_that_does_not_divide_the_day_and_a_duplicate_shift() {
        let mut c = norfolk();
        assert!(c.validate().is_empty(), "{:?}", c.validate());
        c.watch_minutes = 100;
        c.shifts.push(ShiftDef {
            name: "Days".to_owned(),
            start_minute: 0,
            length_minutes: 60,
        });
        let problems = c.validate();
        assert!(
            problems.iter().any(|p| p.contains("100 min")),
            "{problems:?}"
        );
        assert!(
            problems.iter().any(|p| p.contains("Days is listed twice")),
            "{problems:?}"
        );

        let mut wrong_zone = YardClock::utc();
        wrong_zone.zone = "Norfolk".to_owned();
        wrong_zone.standard_offset_minutes = 7;
        let problems = wrong_zone.validate();
        assert!(
            problems.iter().any(|p| p.contains("Area/City")),
            "{problems:?}"
        );
        assert!(
            problems.iter().any(|p| p.contains("multiple of 15")),
            "{problems:?}"
        );
        assert!(YardClock::utc().validate().is_empty());
        assert!(YardClock::utc().coverage_findings().is_empty());

        let mut two_shift = YardClock::utc();
        two_shift.shifts.truncate(2);
        let findings = two_shift.coverage_findings();
        assert_eq!(findings, vec!["the shifts leave 00:00–07:00 uncovered"]);
    }

    #[test]
    fn a_transition_finds_the_nth_and_the_last_weekday() {
        let second_sunday_march = Transition {
            month: 3,
            week: 2,
            weekday: 0,
            minute_of_day: 120,
        };
        assert_eq!(second_sunday_march.day_in(2026), days("2026-03-08"));
        let last_sunday_october = Transition {
            month: 10,
            week: 5,
            weekday: 0,
            minute_of_day: 60,
        };
        assert_eq!(last_sunday_october.day_in(2026), days("2026-10-25"));
        let last_sunday_december = Transition {
            month: 12,
            week: 5,
            weekday: 0,
            minute_of_day: 0,
        };
        assert_eq!(last_sunday_december.day_in(2026), days("2026-12-27"));
    }
}
