//! Schedule-expression grammar + cron parsing.
//!
//! [`parse`] turns a free-text expression into a [`Parsed`] carrying the FIRST
//! `next_run` (computed from "now") plus the [`Recurrence`] needed to recompute
//! later fires. Three distinct next-run semantics, per the Eng failure-paths
//! table:
//!
//! - **5-field cron** → `cron::Schedule` (wall-clock aligned via [`Recurrence::next_after`]).
//! - **`every Nm`/`Nh`** → `last_run + N*unit` (interval anchored to last fire; drifts intentionally).
//! - **named-time variants** ("daily at HH:MM", "every weekday at HH:MM", …) → converted to a
//!   cron expression, so also wall-clock aligned.
//!
//! **DOW translation gotcha.** The `cron` crate numbers days-of-week 1-7 with
//! `1 = Sunday`, NOT the standard-cron `0-6` (`0 = Sunday`). Both user 5-field
//! cron and the crons we synthesize are written in standard convention and
//! passed through [`translate_dow`] before handing to the crate.
//!
//! **Clock times are the HOST's wall clock.** "daily at 09:00" means 09:00 where
//! the server lives — the operator's own morning — not 09:00 UTC. Every cron
//! walk therefore runs in [`Clock::Host`] (`chrono::Local`, i.e. `TZ` /
//! `/etc/localtime`) and only the resulting instant is stored as UTC. Reading
//! the grid in UTC is what made "daily at 09:00" fire at 11:00 on a CEST host;
//! the [`Clock`] enum exists so that rule is a value a test can pin rather than
//! an ambient property of the machine running it.

use std::str::FromStr;
use std::time::Duration as StdDuration;

use chrono::{DateTime, Duration, FixedOffset, Local, Utc};
use cron::Schedule as CronSchedule;
use once_cell::sync::Lazy;
use regex::Regex;

/// The wall clock a cron grid is walked on.
///
/// Named rather than hard-coded to `Local` for one reason: the difference
/// between "09:00" meaning the operator's morning and it meaning 09:00 UTC is
/// invisible on a UTC host, which is exactly how the UTC reading survived. With
/// a [`Clock::Fixed`] variant a test can assert the CEST behaviour on any
/// machine, and a per-schedule IANA zone later has somewhere to live.
#[derive(Debug, Clone, Copy)]
pub enum Clock {
    /// The host's zone (`TZ` / `/etc/localtime`) — what an operator means by
    /// a clock time they typed. The default for every parsed expression.
    Host,
    /// A fixed UTC offset. Used by tests to pin a zone; DST is not modelled by
    /// an offset, so this is deliberately not what production uses.
    Fixed(FixedOffset),
}

impl Clock {
    /// The first fire strictly after `after`, read on this clock and handed
    /// back as an instant.
    fn next_cron(
        &self,
        schedule: &CronSchedule,
        after: DateTime<Utc>,
    ) -> Option<DateTime<Utc>> {
        match self {
            // `cron` skips a local time that does not exist (spring-forward
            // gap) and yields both readings of an ambiguous one, so the walk is
            // DST-correct without help from here.
            Clock::Host => schedule
                .after(&after.with_timezone(&Local))
                .next()
                .map(|d| d.with_timezone(&Utc)),
            Clock::Fixed(off) => schedule
                .after(&after.with_timezone(off))
                .next()
                .map(|d| d.with_timezone(&Utc)),
        }
    }
}

/// How a schedule recurs (used to recompute `next_run` after each fire).
#[derive(Debug, Clone)]
pub enum Recurrence {
    /// One-shot: no fire after the first.
    Once,
    /// Fixed interval anchored to the previous fire. Successive fires drift by
    /// dispatch lag (intentional, small); after a long gap or any lag that
    /// pushes `anchor + d` past `now`, the next fire is re-anchored to `now + d`
    /// rather than walking the cadence grid — see [`next_after`] for why.
    Interval(Duration),
    /// Wall-clock aligned via a cron schedule, read on the given [`Clock`].
    Cron(Box<CronSchedule>, Clock),
}

impl Recurrence {
    /// The first occurrence strictly after `now`, anchored at `anchor` (the last
    /// fire-time, or — on a missed-window advance — the missed `next_run`).
    pub fn next_after(
        &self,
        anchor: DateTime<Utc>,
        now: DateTime<Utc>,
    ) -> Option<DateTime<Utc>> {
        match self {
            Recurrence::Once => None,
            Recurrence::Interval(d) => {
                let next = anchor + *d;
                if next > now {
                    Some(next)
                } else {
                    // `anchor + d` is in the past — either a long gap/restart or
                    // cumulative dispatch lag pushed the grid past `now`. Walking
                    // the cadence grid forward (`anchor + d * mult`) lands at the
                    // next slot which can be only seconds after `now`, triggering
                    // a near-immediate re-fire on the very next tick (SS-1: bursts
                    // of ~30s-apart fires on an "every 5m" schedule). Re-anchor on
                    // `now` so successive fires are always a full interval apart,
                    // regardless of lag or downtime.
                    Some(now + *d)
                }
            }
            Recurrence::Cron(s, clock) => clock.next_cron(s, now),
        }
    }
}

/// Result of parsing an expression.
#[derive(Debug, Clone)]
pub struct Parsed {
    /// First fire time (strictly in the future relative to the parse `now`).
    pub next_run: DateTime<Utc>,
    pub recurrence: Recurrence,
    /// `"once"` or `"recurring"` (the `schedules.sched_type` column).
    pub sched_type: &'static str,
}

/// Why an expression could not be parsed.
#[derive(Debug)]
pub enum ParseError {
    Empty,
    BadTime(String),
    BadDay(String),
    BadCron(String),
    Unknown(String),
}

impl std::fmt::Display for ParseError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ParseError::Empty => write!(f, "empty schedule expression"),
            ParseError::BadTime(s) => write!(f, "invalid time '{s}' (use HH:MM, 9am, 6pm)"),
            ParseError::BadDay(s) => write!(f, "invalid day '{s}'"),
            ParseError::BadCron(s) => write!(f, "invalid cron expression '{s}'"),
            ParseError::Unknown(s) => write!(f, "unrecognized schedule expression '{s}'"),
        }
    }
}

impl std::error::Error for ParseError {}

// ── regexes (compiled once) ───────────────────────────────────────────────────

static RE_IN: Lazy<Regex> = Lazy::new(|| Regex::new(r"^in\s+(\d+)\s*([a-z]+)$").unwrap());
static RE_EVERY_N: Lazy<Regex> = Lazy::new(|| Regex::new(r"^every\s+(\d+)\s*([a-z]+)$").unwrap());
static RE_EVERY_ALIAS: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"^every\s+(morning|evening|night)$").unwrap());
static RE_WEEKDAY: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"^every\s+weekday\s+at\s+(.+)$").unwrap());
static RE_DAILY: Lazy<Regex> = Lazy::new(|| Regex::new(r"^daily\s+at\s+(.+)$").unwrap());
static RE_WEEKLY: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"^weekly\s+on\s+([a-z]+)\s+at\s+(.+)$").unwrap());
static RE_EVERY_DAY: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"^every\s+([a-z]+)\s+at\s+(.+)$").unwrap());
static RE_MONTHLY: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"^monthly\s+on\s+(\d+)\s+at\s+(.+)$").unwrap());

// ── public entry ──────────────────────────────────────────────────────────────

/// Parse `expr` (case-insensitive) relative to `now`, reading clock times on
/// the HOST's wall clock — "daily at 09:00" is the operator's 09:00.
pub fn parse(expr: &str, now: DateTime<Utc>) -> Result<Parsed, ParseError> {
    parse_on(expr, now, Clock::Host)
}

/// [`parse`], with the wall clock named explicitly. Production always passes
/// [`Clock::Host`]; tests pin an offset so the timezone rule is asserted rather
/// than inherited from the machine running them.
pub fn parse_on(expr: &str, now: DateTime<Utc>, clock: Clock) -> Result<Parsed, ParseError> {
    let e = expr.trim().to_lowercase();
    if e.is_empty() {
        return Err(ParseError::Empty);
    }

    // "in <N><unit>" — one-shot relative.
    if let Some(c) = RE_IN.captures(&e) {
        let n: i64 = c[1].parse().map_err(|_| ParseError::Unknown(e.clone()))?;
        let dur = unit_duration(n, &c[2]).ok_or_else(|| ParseError::Unknown(e.clone()))?;
        return Ok(Parsed {
            next_run: now + dur,
            recurrence: Recurrence::Once,
            sched_type: "once",
        });
    }

    // "every <N><unit>" — interval-from-now (drifts from last fire thereafter).
    if let Some(c) = RE_EVERY_N.captures(&e) {
        let n: i64 = c[1].parse().map_err(|_| ParseError::Unknown(e.clone()))?;
        let dur = unit_duration(n, &c[2]).ok_or_else(|| ParseError::Unknown(e.clone()))?;
        return Ok(Parsed {
            next_run: now + dur,
            recurrence: Recurrence::Interval(dur),
            sched_type: "recurring",
        });
    }

    // "every morning|evening|night" — fixed daily aliases.
    if let Some(c) = RE_EVERY_ALIAS.captures(&e) {
        let (h, m) = match &c[1] {
            "morning" => (9, 0),
            _ => (18, 0), // evening / night
        };
        return cron_parsed(&format!("{m} {h} * * *"), now, clock);
    }

    // "every weekday at <time>" — Mon-Fri (std DOW 1-5).
    if let Some(c) = RE_WEEKDAY.captures(&e) {
        let (h, m) = parse_time(&c[1])?;
        return cron_parsed(&format!("{m} {h} * * 1-5"), now, clock);
    }

    // "daily at <time>".
    if let Some(c) = RE_DAILY.captures(&e) {
        let (h, m) = parse_time(&c[1])?;
        return cron_parsed(&format!("{m} {h} * * *"), now, clock);
    }

    // "weekly on <day> at <time>".
    if let Some(c) = RE_WEEKLY.captures(&e) {
        let dow = day_to_std(&c[1]).ok_or_else(|| ParseError::BadDay(c[1].to_string()))?;
        let (h, m) = parse_time(&c[2])?;
        return cron_parsed(&format!("{m} {h} * * {dow}"), now, clock);
    }

    // "monthly on <N> at <time>".
    if let Some(c) = RE_MONTHLY.captures(&e) {
        let dom: u32 = c[1].parse().map_err(|_| ParseError::Unknown(e.clone()))?;
        if !(1..=28).contains(&dom) {
            return Err(ParseError::Unknown(format!("day-of-month {dom} (use 1-28)")));
        }
        let (h, m) = parse_time(&c[2])?;
        return cron_parsed(&format!("{m} {h} {dom} * *"), now, clock);
    }

    // "every <dayname> at <time>" (checked after weekday/alias so they win).
    if let Some(c) = RE_EVERY_DAY.captures(&e) {
        if let Some(dow) = day_to_std(&c[1]) {
            let (h, m) = parse_time(&c[2])?;
            return cron_parsed(&format!("{m} {h} * * {dow}"), now, clock);
        }
    }

    // 5-field standard cron.
    if e.split_whitespace().count() == 5 {
        return cron_parsed(&e, now, clock);
    }

    Err(ParseError::Unknown(e))
}

// ── cron helpers ──────────────────────────────────────────────────────────────

/// Parse a STANDARD 5-field cron string (`MIN HOUR DOM MON DOW`) into a [`Parsed`].
fn cron_parsed(std5: &str, now: DateTime<Utc>, clock: Clock) -> Result<Parsed, ParseError> {
    let schedule = build_cron(std5)?;
    let next_run = clock
        .next_cron(&schedule, now)
        .ok_or_else(|| ParseError::BadCron(std5.to_string()))?;
    Ok(Parsed {
        next_run,
        recurrence: Recurrence::Cron(Box::new(schedule), clock),
        sched_type: "recurring",
    })
}

/// Build a `cron::Schedule` from a standard 5-field expression: prepend the
/// seconds field (`0`) the crate requires and translate the DOW field from
/// standard (`0=Sun`) to the crate's `1=Sun` convention.
fn build_cron(std5: &str) -> Result<CronSchedule, ParseError> {
    let fields: Vec<&str> = std5.split_whitespace().collect();
    if fields.len() != 5 {
        return Err(ParseError::BadCron(std5.to_string()));
    }
    let dow = translate_dow(fields[4]);
    // sec min hour dom mon dow  (year omitted → all)
    let expr = format!("0 {} {} {} {} {}", fields[0], fields[1], fields[2], fields[3], dow);
    CronSchedule::from_str(&expr).map_err(|_| ParseError::BadCron(std5.to_string()))
}

/// Translate a standard-cron day-of-week field to the `cron` crate convention.
/// Numeric tokens shift by `n → (n % 7) + 1` (so std `0/7`→Sun=1, `6`→Sat=7);
/// `*`, step (`/N`), and day NAMES pass through (the crate maps names natively).
fn translate_dow(field: &str) -> String {
    field
        .split(',')
        .map(|seg| {
            // Split off an optional step suffix ("base/step").
            let (base, step) = match seg.split_once('/') {
                Some((b, s)) => (b, Some(s)),
                None => (seg, None),
            };
            let mapped = if base == "*" {
                "*".to_string()
            } else if let Some((a, b)) = base.split_once('-') {
                format!("{}-{}", shift_dow(a), shift_dow(b))
            } else {
                shift_dow(base)
            };
            match step {
                Some(s) => format!("{mapped}/{s}"),
                None => mapped,
            }
        })
        .collect::<Vec<_>>()
        .join(",")
}

/// Shift one DOW token: numerics by +1 (mod 7); names/anything else unchanged.
fn shift_dow(tok: &str) -> String {
    match tok.parse::<u32>() {
        Ok(n) => ((n % 7) + 1).to_string(),
        Err(_) => tok.to_string(),
    }
}

// ── small parsers ─────────────────────────────────────────────────────────────

/// `N` of a time unit → a [`Duration`]. Recognizes s/m/h/d (and word forms).
fn unit_duration(n: i64, unit: &str) -> Option<Duration> {
    let secs = match unit {
        "s" | "sec" | "secs" | "second" | "seconds" => 1,
        "m" | "min" | "mins" | "minute" | "minutes" => 60,
        "h" | "hr" | "hrs" | "hour" | "hours" => 3600,
        "d" | "day" | "days" => 86400,
        _ => return None,
    };
    Duration::try_seconds(n.checked_mul(secs)?)
}

/// Parse a clock time: `HH:MM` (24h), `9am`/`6pm`, or `9:30pm`. Returns `(h, m)`.
fn parse_time(s: &str) -> Result<(u32, u32), ParseError> {
    let t = s.trim();
    let bad = || ParseError::BadTime(t.to_string());

    let (body, ampm) = if let Some(rest) = t.strip_suffix("am") {
        (rest.trim(), Some(false))
    } else if let Some(rest) = t.strip_suffix("pm") {
        (rest.trim(), Some(true))
    } else {
        (t, None)
    };

    let (h, m) = match body.split_once(':') {
        Some((h, m)) => (h.parse::<u32>().map_err(|_| bad())?, m.parse::<u32>().map_err(|_| bad())?),
        None => (body.parse::<u32>().map_err(|_| bad())?, 0),
    };
    if m > 59 {
        return Err(bad());
    }

    let h = match ampm {
        Some(true) => {
            // pm: 12pm stays 12; 1-11pm add 12.
            if h == 12 {
                12
            } else if h < 12 {
                h + 12
            } else {
                return Err(bad());
            }
        }
        Some(false) => {
            // am: 12am is 0; 1-11am unchanged.
            if h == 12 {
                0
            } else if h < 12 {
                h
            } else {
                return Err(bad());
            }
        }
        None => h,
    };
    if h > 23 {
        return Err(bad());
    }
    Ok((h, m))
}

/// Day name → standard-cron DOW ordinal (`0=Sun .. 6=Sat`).
fn day_to_std(name: &str) -> Option<u32> {
    Some(match name {
        "sun" | "sunday" => 0,
        "mon" | "monday" => 1,
        "tue" | "tues" | "tuesday" => 2,
        "wed" | "wednesday" => 3,
        "thu" | "thurs" | "thursday" => 4,
        "fri" | "friday" => 5,
        "sat" | "saturday" => 6,
        _ => return None,
    })
}

/// 600s ceiling for shell jobs (re-exported for the runner).
pub const SHELL_TIMEOUT: StdDuration = StdDuration::from_secs(600);

#[cfg(test)]
mod tests {
    use super::*;

    fn now() -> DateTime<Utc> {
        "2026-05-22T12:00:00Z".parse().unwrap()
    }

    /// A zero offset, for the tests whose expectations are written in UTC.
    fn utc_offset() -> FixedOffset {
        FixedOffset::east_opt(0).unwrap()
    }

    #[test]
    fn in_relative_is_once() {
        let p = parse("in 5s", now()).unwrap();
        assert_eq!(p.sched_type, "once");
        assert_eq!(p.next_run, now() + Duration::seconds(5));
        assert!(matches!(p.recurrence, Recurrence::Once));
        assert!(p.recurrence.next_after(p.next_run, p.next_run).is_none());
    }

    #[test]
    fn every_n_is_interval() {
        let p = parse("every 1m", now()).unwrap();
        assert_eq!(p.sched_type, "recurring");
        assert_eq!(p.next_run, now() + Duration::seconds(60));
        // Recompute after a fire advances by exactly one interval.
        let after = p.recurrence.next_after(p.next_run, p.next_run).unwrap();
        assert_eq!(after, p.next_run + Duration::seconds(60));
    }

    #[test]
    fn interval_skips_missed_windows() {
        let p = parse("every 1m", now()).unwrap();
        // Anchor 5 min in the past, "now" = base: must land strictly in the future.
        let anchor = now() - Duration::seconds(300);
        let next = p.recurrence.next_after(anchor, now()).unwrap();
        assert!(next > now());
        assert!(next <= now() + Duration::seconds(60));
    }

    /// SS-1: after a long gap (or a lagged fire that pushes `anchor + d` just
    /// past `now`), the next fire must be one FULL interval out — not a few
    /// seconds away. The old impl walked the cadence grid (`anchor + d * mult`)
    /// and landed e.g. 21 s after `now`, which the scheduler tick then re-fired
    /// immediately, producing bursts of ~30 s-apart fires on every-5-min jobs.
    #[test]
    fn interval_after_long_gap_does_not_double_fire() {
        let p = parse("every 5m", now()).unwrap();
        // Anchor far in the past (4.5 h ago) — server-restart / disabled-then-
        // re-enabled / long sleep. The next fire must be a full 5 min from now.
        let anchor = now() - Duration::seconds(16_779);
        let next = p.recurrence.next_after(anchor, now()).unwrap();
        assert_eq!(next, now() + Duration::seconds(300));
    }

    /// SS-1: dispatch lag (catch-up fire at `now > anchor + d`) must also
    /// re-anchor on `now`, not pick the next cadence-grid boundary which can
    /// land seconds ahead and cause the second fire of an observed pair.
    #[test]
    fn interval_lagged_fire_resets_to_now_plus_d() {
        let p = parse("every 5m", now()).unwrap();
        // Anchor ≈ 5 min ago + a 10 s lag — i.e. the previous fire happened a
        // little late, so `anchor + d` is now ~10 s in the past.
        let anchor = now() - Duration::seconds(310);
        let next = p.recurrence.next_after(anchor, now()).unwrap();
        assert_eq!(next, now() + Duration::seconds(300));
    }

    #[test]
    fn five_field_cron_every_minute() {
        let p = parse("*/1 * * * *", now()).unwrap();
        assert_eq!(p.sched_type, "recurring");
        assert!(p.next_run > now());
        assert!(p.next_run <= now() + Duration::seconds(60));
    }

    /// UTC host: the wall clock and the instant agree, so 09:30 is 09:30Z.
    #[test]
    fn daily_named_time_wall_clock() {
        let p = parse_on("daily at 09:30", now(), Clock::Fixed(utc_offset())).unwrap();
        // 09:30 already passed today → tomorrow 09:30.
        assert_eq!(p.next_run, "2026-05-23T09:30:00Z".parse::<DateTime<Utc>>().unwrap());
    }

    /// The finding: "daily at 09:00" on a UTC+2 host fired at 11:00 local,
    /// because the cron grid was walked in UTC. A clock time is the OPERATOR's
    /// clock — 09:00 CEST is 07:00Z — and the first fire must be the next one
    /// strictly ahead on THAT grid, not on UTC's.
    #[test]
    fn named_times_are_read_on_the_host_clock_not_utc() {
        let cest = Clock::Fixed(FixedOffset::east_opt(2 * 3600).unwrap());
        // now() is 12:00Z = 14:00 local, so today's 09:00 local has passed.
        let p = parse_on("daily at 09:00", now(), cest).unwrap();
        assert_eq!(p.next_run, "2026-05-23T07:00:00Z".parse::<DateTime<Utc>>().unwrap());
        assert_eq!(p.next_run.with_timezone(&FixedOffset::east_opt(2 * 3600).unwrap()).format("%H:%M").to_string(), "09:00");

        // …and every LATER fire too — `next_after` walks the same grid, so a
        // schedule cannot drift back to UTC on its second occurrence.
        let second = p.recurrence.next_after(p.next_run, p.next_run).unwrap();
        assert_eq!(second, "2026-05-24T07:00:00Z".parse::<DateTime<Utc>>().unwrap());

        // The documented agent example, same rule: 08:00 local = 06:00Z.
        let wd = parse_on("every weekday at 08:00", now(), cest).unwrap();
        assert_eq!(wd.next_run, "2026-05-25T06:00:00Z".parse::<DateTime<Utc>>().unwrap());
    }

    /// A time before the current local hour on a WEST-of-UTC host: the same
    /// rule read from the other side, so the fix is not an off-by-one that only
    /// happens to work for positive offsets.
    #[test]
    fn named_times_west_of_utc() {
        // UTC-7: now() 12:00Z = 05:00 local, so today's 09:00 local is still ahead.
        let pdt = Clock::Fixed(FixedOffset::west_opt(7 * 3600).unwrap());
        let p = parse_on("daily at 09:00", now(), pdt).unwrap();
        assert_eq!(p.next_run, "2026-05-22T16:00:00Z".parse::<DateTime<Utc>>().unwrap());
    }

    /// The host clock is what production uses, and it has to agree with the
    /// machine's own idea of the time — asserted without pinning a zone, so it
    /// passes on a UTC CI box and on the CEST host alike.
    #[test]
    fn host_clock_lands_on_the_local_hour() {
        let p = parse("daily at 09:00", now()).unwrap();
        let local = p.next_run.with_timezone(&Local);
        assert_eq!(local.format("%H:%M").to_string(), "09:00");
        assert!(p.next_run > now());
    }

    #[test]
    fn am_pm_time_parsing() {
        assert_eq!(parse_time("9am").unwrap(), (9, 0));
        assert_eq!(parse_time("12am").unwrap(), (0, 0));
        assert_eq!(parse_time("12pm").unwrap(), (12, 0));
        assert_eq!(parse_time("6pm").unwrap(), (18, 0));
        assert_eq!(parse_time("9:30pm").unwrap(), (21, 30));
        assert!(parse_time("25:00").is_err());
    }

    #[test]
    fn dow_translation_standard_to_crate() {
        // Std Mon-Fri (1-5) → crate 2-6.
        assert_eq!(translate_dow("1-5"), "2-6");
        // Std Sunday 0 → crate 1; std 7 also Sunday → 1.
        assert_eq!(translate_dow("0"), "1");
        assert_eq!(translate_dow("7"), "1");
        // List + step + names pass sensibly.
        assert_eq!(translate_dow("1,3,5"), "2,4,6");
        assert_eq!(translate_dow("*"), "*");
        assert_eq!(translate_dow("*/2"), "*/2");
        assert_eq!(translate_dow("mon"), "mon");
    }

    #[test]
    fn weekday_builds_monday() {
        // "every monday at 10:00" — std DOW 1 → crate 2 (Monday). Parse must succeed.
        let p = parse("every monday at 10:00", now()).unwrap();
        assert!(p.next_run > now());
    }

    #[test]
    fn unknown_expression_errors() {
        assert!(parse("whenever I feel like it", now()).is_err());
        assert!(parse("", now()).is_err());
    }
}
