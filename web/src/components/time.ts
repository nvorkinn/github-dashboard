/** Times as the page words them. `now` is passed in, so everything drawn in one go agrees with itself. */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** How long ago `then` was, such as "12s ago". A time ahead of this clock counts as now. */
export function ago(then: string | number, now: number): string {
  const elapsed = now - (typeof then === "number" ? then : Date.parse(then));
  if (Number.isNaN(elapsed)) {
    return "";
  }
  if (elapsed < 5000) {
    return "just now";
  }
  if (elapsed < MINUTE) {
    return `${Math.floor(elapsed / 1000)}s ago`;
  }
  if (elapsed < HOUR) {
    return `${Math.floor(elapsed / MINUTE)}m ago`;
  }
  if (elapsed < DAY) {
    return `${Math.floor(elapsed / HOUR)}h ago`;
  }
  if (elapsed < 14 * DAY) {
    return `${Math.floor(elapsed / DAY)}d ago`;
  }
  if (elapsed < 60 * DAY) {
    return `${Math.floor(elapsed / (7 * DAY))}w ago`;
  }
  if (elapsed < 365 * DAY) {
    return `${Math.floor(elapsed / (30 * DAY))}mo ago`;
  }
  return `${Math.floor(elapsed / (365 * DAY))}y ago`;
}

/** A length of time in its two largest units, such as "4m 12s". */
export function duration(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) {
    return `${seconds}s`;
  }
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m ${seconds % 60}s`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${hours}h ${minutes % 60}m`;
  }
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

/** The whole date and time, for a tooltip on a relative time. */
export function exact(then: string | number): string {
  const date = new Date(then);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleString();
}
