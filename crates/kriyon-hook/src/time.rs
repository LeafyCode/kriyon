//! A UTC time as the Python hook stamped it: `datetime.isoformat()`.

/// `secs` and `micros` since 1970 in UTC, as Python's `isoformat()`:
/// `YYYY-MM-DDTHH:MM:SS[.ffffff]+00:00`, the fraction only when non-zero.
#[must_use]
pub fn iso_utc(secs: u64, micros: u32) -> String {
    let days = secs / 86_400;
    let rest = secs % 86_400;
    let (h, m, s) = (rest / 3600, rest % 3600 / 60, rest % 60);
    let (year, month, day) = civil_from_days(days);
    let fraction = if micros == 0 {
        String::new()
    } else {
        format!(".{micros:06}")
    };
    format!("{year:04}-{month:02}-{day:02}T{h:02}:{m:02}:{s:02}{fraction}+00:00")
}

/// The proleptic Gregorian date `days` after 1970-01-01 (Howard Hinnant's
/// `civil_from_days`, for days on or after the epoch).
fn civil_from_days(days: u64) -> (u64, u64, u64) {
    let z = days + 719_468;
    let era = z / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + u64::from(month <= 2);
    (year, month, day)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_time_reads_as_python_isoformat_writes_it() {
        assert_eq!(iso_utc(0, 0), "1970-01-01T00:00:00+00:00");
        // 2026-11-15 06:30:05.000123 UTC
        assert_eq!(
            iso_utc(1_794_724_205, 123),
            "2026-11-15T06:30:05.000123+00:00"
        );
        // A leap day.
        assert_eq!(
            iso_utc(951_782_400, 500_000),
            "2000-02-29T00:00:00.500000+00:00"
        );
    }
}
