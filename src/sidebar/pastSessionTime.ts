//! Time formatting for the sidebar's "Earlier sessions" list: a short
//! "time ago" label per row and a coarse recency bucket for grouping, à la
//! Claude Desktop's history list. Pure functions that take `now` explicitly so
//! they are deterministic and unit-testable.

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const relativeFormat = new Intl.RelativeTimeFormat(undefined, {
  numeric: "auto",
});

/**
 * A short, human "time ago" for a past session's last-active timestamp:
 * "just now", "5 minutes ago", "3 hours ago", "2 days ago", then an absolute
 * date once it is older than a week. `now` is the reference instant (epoch ms).
 */
export function relativeTime(ms: number, now: number): string {
  const diff = Math.max(0, now - ms);
  if (diff < MINUTE) {
    return "just now";
  }
  if (diff < HOUR) {
    return relativeFormat.format(-Math.round(diff / MINUTE), "minute");
  }
  if (diff < DAY) {
    return relativeFormat.format(-Math.round(diff / HOUR), "hour");
  }
  if (diff < 7 * DAY) {
    return relativeFormat.format(-Math.round(diff / DAY), "day");
  }
  return new Date(ms).toLocaleDateString();
}

/**
 * The compact right-column timestamp for a history row: "now", "5m", "3h",
 * "2d", then a short month-day date after a week. The bucket header already
 * carries the coarse recency, so the row label stays as small as possible.
 */
export function shortTime(ms: number, now: number): string {
  const diff = Math.max(0, now - ms);
  if (diff < MINUTE) {
    return "now";
  }
  // Floor, not round: rounding would render impossible labels at the bucket
  // edges ("60m", "24h") — flooring keeps every label inside its unit.
  if (diff < HOUR) {
    return `${Math.floor(diff / MINUTE)}m`;
  }
  if (diff < DAY) {
    return `${Math.floor(diff / HOUR)}h`;
  }
  if (diff < 7 * DAY) {
    return `${Math.floor(diff / DAY)}d`;
  }
  return new Date(ms).toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
  });
}

/**
 * The dormant-project age chip: like {@link shortTime} up to a week, but it
 * keeps counting in relative units afterwards ("11d", "1mo", "2y") instead of
 * falling back to a date. A date reads as *when*; this chip answers *how
 * stale*, which is what the collapsed row is for.
 */
export function compactAge(ms: number, now: number): string {
  const diff = Math.max(0, now - ms);
  if (diff < MINUTE) {
    return "now";
  }
  if (diff < HOUR) {
    return `${Math.floor(diff / MINUTE)}m`;
  }
  if (diff < DAY) {
    return `${Math.floor(diff / HOUR)}h`;
  }
  if (diff < 30 * DAY) {
    return `${Math.floor(diff / DAY)}d`;
  }
  if (diff < 365 * DAY) {
    return `${Math.floor(diff / (30 * DAY))}mo`;
  }
  return `${Math.floor(diff / (365 * DAY))}y`;
}

/** The recency buckets sessions are grouped under, newest first. */
export const BUCKET_ORDER = [
  "Today",
  "Yesterday",
  "Previous 7 days",
  "Previous 30 days",
  "Older",
] as const;

export type DateBucket = (typeof BUCKET_ORDER)[number];

/** Local midnight (epoch ms) of the day containing `ms`. */
function startOfDay(ms: number): number {
  const date = new Date(ms);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

/**
 * Coarse recency bucket for grouping a past session by its last-active time,
 * measured in whole calendar days (local time) from `now` — so an 11pm session
 * and a 1am one on the same date share a bucket.
 */
export function dateBucket(ms: number, now: number): DateBucket {
  const days = Math.floor((startOfDay(now) - startOfDay(ms)) / DAY);
  if (days <= 0) {
    return "Today";
  }
  if (days === 1) {
    return "Yesterday";
  }
  if (days < 7) {
    return "Previous 7 days";
  }
  if (days < 30) {
    return "Previous 30 days";
  }
  return "Older";
}
