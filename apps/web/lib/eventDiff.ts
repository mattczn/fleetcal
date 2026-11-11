/**
 * Narrow a full-form save payload down to the fields that actually
 * changed.
 *
 * The load modal builds its payload from the WHOLE form — title, stops,
 * broker, price, times, every time. Saving one field therefore rewrote
 * all of them from whatever that browser had loaded, so a tab holding
 * an hours-old copy silently reverted other people's edits: change the
 * truck at 00:28, and the title someone set that afternoon goes back
 * with it. The audit log couldn't even show it, because the differ that
 * writes history compares against the same stale copy and sees nothing
 * changed.
 *
 * Sending only what moved makes most of those collisions stop existing
 * rather than needing to be detected: two dispatchers editing different
 * fields of one load no longer overwrite each other at all. It relies
 * on the API's key-presence semantics — every PATCH handler gates on
 * `"field" in body`, so an omitted key leaves that column untouched.
 */

/** Order-independent structural compare. Arrays stay order-SENSITIVE
 *  (stop order is meaningful); object key order is not. */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  // Treat the empty-ish values as interchangeable. The form produces ''
  // or undefined where the stored row has null, and a save must not
  // count that as an edit — otherwise every open-and-save rewrites
  // fields nobody touched, which is the behaviour being removed.
  const blank = (v: unknown) => v === undefined || v === null || v === '';
  if (blank(a) && blank(b)) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((x, i) => deepEqual(x, b[i]));
  }
  if (typeof a === 'object') {
    const ao = a as Record<string, unknown>;
    const bo = b as Record<string, unknown>;
    const keys = new Set([...Object.keys(ao), ...Object.keys(bo)]);
    for (const k of keys) {
      // Ignore keys that are absent-or-blank on BOTH sides so a row
      // round-tripped through the API (which drops nulls) compares
      // equal to the same row built by the form.
      if (blank(ao[k]) && blank(bo[k])) continue;
      if (!deepEqual(ao[k], bo[k])) return false;
    }
    return true;
  }
  return false;
}

/**
 * Keys that must ride along on every save regardless of whether they
 * "changed", because they are not a snapshot of a field:
 *
 *   auditLog — the appended history for THIS save. Dropping it would
 *              lose the entry the modal just built.
 *   stops    — only when genuinely different; see below. Listed here
 *              as a reminder that it is handled by the same compare,
 *              not exempted from it.
 */
const ALWAYS_SEND = new Set(['auditLog']);

/**
 * @param next     the full payload the form produced
 * @param previous the event as it was loaded (server truth at open)
 * @returns only the entries that differ, plus ALWAYS_SEND keys
 */
export function diffEventPayload<T extends Record<string, unknown>>(
  next: T,
  previous: Record<string, unknown> | null | undefined,
): Partial<T> {
  // No baseline (create, or an event the cache lost) — send everything.
  // Narrowing a payload we can't compare would silently drop fields.
  if (!previous) return next;

  const out: Partial<T> = {};
  for (const [key, value] of Object.entries(next) as Array<[keyof T & string, unknown]>) {
    if (ALWAYS_SEND.has(key)) { out[key] = value as T[keyof T & string]; continue; }
    if (deepEqual(value, previous[key])) continue;
    out[key] = value as T[keyof T & string];
  }
  return out;
}

/** True when the diff carries nothing but the bookkeeping keys — i.e.
 *  the user opened a load and saved without changing anything. */
export function isNoOpDiff(diff: Record<string, unknown>): boolean {
  return Object.keys(diff).every(k => ALWAYS_SEND.has(k));
}
