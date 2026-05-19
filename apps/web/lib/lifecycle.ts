/**
 * Active-lifecycle helpers.
 *
 * Assets, drivers, and trailers carry `activeFrom` + `activeTo`
 * date strings ("YYYY-MM-DD"). When `activeTo` is null/undefined the
 * entity is currently active. The calendar grid and EventModal
 * pickers filter by the visible date so a truck retired in March
 * still appears on the March calendar but drops out of today's view,
 * and a driver picker for a load on July 1 only shows drivers active
 * on July 1.
 *
 * All comparisons are date-string-based (YYYY-MM-DD lexicographic
 * sort matches date sort) — no Date parsing required. That sidesteps
 * tz issues entirely.
 */

interface Lifecycle {
  activeFrom?: string;        // YYYY-MM-DD
  activeTo?: string | null;   // YYYY-MM-DD or null
}

/** True if the entity is active on `dateKey` (a YYYY-MM-DD string). */
export function isActiveOn(item: Lifecycle, dateKey: string): boolean {
  const from = item.activeFrom ?? "0000-01-01";
  const to   = item.activeTo   ?? "9999-12-31";
  return from <= dateKey && dateKey <= to;
}

/** True if the entity is active for ANY day in [rangeStart, rangeEnd]
 *  inclusive. Used by week/month calendar views — a truck retired
 *  mid-week still shows that week so its loads stay visible. */
export function isActiveInRange(item: Lifecycle, rangeStart: string, rangeEnd: string): boolean {
  const from = item.activeFrom ?? "0000-01-01";
  const to   = item.activeTo   ?? "9999-12-31";
  // Overlap test: [from,to] ∩ [rangeStart,rangeEnd] ≠ ∅
  return from <= rangeEnd && to >= rangeStart;
}

/** YYYY-MM-DD for a Date in its current local tz. Use when filtering
 *  by `currentDate` from the calendar store. */
export function dateKeyOf(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
