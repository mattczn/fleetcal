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

/** YYYY-MM-DD for a Date in the browser's local tz. */
export function dateKeyOf(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** YYYY-MM-DD for a Date interpreted in the given IANA timezone.
 *  Use this for calendar-grid filtering so the boundary between days
 *  matches the org's clock, not the browser's. Around midnight (when
 *  browser-tz and org-tz disagree on the date), this picks the org's
 *  day so the asset/driver/trailer columns reflect what the dispatcher
 *  considers "today." */
export function dateKeyInTz(d: Date, tz: string | null | undefined): string {
  if (!tz) return dateKeyOf(d);
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: tz,
      year: "numeric", month: "2-digit", day: "2-digit",
    }).formatToParts(d);
    const get = (t: string) => parts.find(p => p.type === t)?.value ?? "00";
    return `${get("year")}-${get("month")}-${get("day")}`;
  } catch {
    return dateKeyOf(d);
  }
}

/** Shift a YYYY-MM-DD key by N days. Noon anchor avoids DST-edge drift. */
export function shiftDateKey(key: string, days: number): string {
  const d = new Date(`${key}T12:00:00`);
  d.setDate(d.getDate() + days);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
