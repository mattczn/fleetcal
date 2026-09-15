/**
 * Active-lifecycle helpers — SHARED by web and the mobile apps.
 *
 * Assets, drivers, and trailers carry `activeFrom` + `activeTo` date
 * strings ("YYYY-MM-DD"). `activeTo` null/undefined means still active.
 *
 * These lived in apps/web/lib/lifecycle.ts and were web-only, which is
 * why FleetCal Go's calendar kept showing trucks that had been retired
 * months earlier: the data said so, nothing on the phone read it. The
 * rule belongs next to the types it operates on so both halves of the
 * product answer "is this truck ours?" the same way.
 *
 * All comparisons are date-string based — YYYY-MM-DD sorts
 * lexicographically in date order, so no Date parsing and no timezone
 * exposure.
 */

export interface Lifecycle {
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
 *  inclusive. Used by week/month views — a truck retired mid-week still
 *  shows that week so its loads stay visible rather than vanishing
 *  along with the column that explained them. */
export function isActiveInRange(item: Lifecycle, rangeStart: string, rangeEnd: string): boolean {
  const from = item.activeFrom ?? "0000-01-01";
  const to   = item.activeTo   ?? "9999-12-31";
  return from <= rangeEnd && to >= rangeStart;
}

/**
 * The visibility rule for a piece of equipment on a given day:
 * retired-before-this-day drops out, and `hidden` (an explicit manual
 * "don't show me this") drops out always.
 *
 * Deliberately day-scoped rather than "is it active today" — navigating
 * back to April must still show the truck that was retired in May, or
 * April's loads render under no column at all.
 */
export function isVisibleOn(
  item: Lifecycle & { hidden?: boolean },
  dateKey: string,
): boolean {
  if (item.hidden) return false;
  return isActiveOn(item, dateKey);
}

/**
 * The set of equipment a user should be offered when ASSIGNING work —
 * pickers on a new load, a work order, a trailer swap.
 *
 * Scoped to a single day (pass the org's today) rather than to the
 * viewed day, because the question is different from the calendar's:
 * a calendar asks "what was true then", a picker asks "what can I
 * choose now". Offering a truck that left the fleet in May is how a
 * load ends up assigned to equipment that no longer exists.
 */
export function pickableOn<T extends Lifecycle & { hidden?: boolean }>(
  items: T[],
  todayKey: string,
): T[] {
  return items.filter((i) => isVisibleOn(i, todayKey));
}
