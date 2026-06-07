/**
 * Payroll week helpers — shared between PayrollView, the load detail
 * page, and EventModal so every surface agrees on which week a load
 * belongs to.
 *
 * Convention: Saturday-anchored, Sat–Fri inclusive. Matches the rule
 * the payroll page already uses (see weekSaturdayOf in PayrollView).
 * A load's "payroll week" is the Saturday immediately on-or-before
 * its pickup date.
 */

/** Returns the Saturday that starts the week containing `date`. */
export function weekSaturdayOf(date: Date): Date {
  const d = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const dow = d.getDay(); // 0=Sun … 6=Sat
  d.setDate(d.getDate() - ((dow + 1) % 7));
  return d;
}

/** Returns the YYYY-MM-DD weekStart key for a naive ISO date string
 *  ("2026-06-08" or "2026-06-08T14:30"). Empty/invalid input → null. */
export function payrollWeekStartFor(iso: string | undefined | null): string | null {
  if (!iso) return null;
  // Parse the date portion only — payroll groups by calendar day,
  // not by UTC moment, so timezone math doesn't apply here. This
  // also keeps a "2026-06-08T08:00 PDT" load in the same week as a
  // "2026-06-08T20:00 EST" load even though the UTC dates differ.
  const datePart = iso.slice(0, 10);
  const parts = datePart.split('-').map(n => parseInt(n, 10));
  if (parts.length !== 3 || parts.some(n => Number.isNaN(n))) return null;
  const d = new Date(parts[0], parts[1] - 1, parts[2]);
  if (Number.isNaN(d.getTime())) return null;
  const sat = weekSaturdayOf(d);
  const y = sat.getFullYear();
  const m = String(sat.getMonth() + 1).padStart(2, '0');
  const day = String(sat.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** "Mar 1 – Mar 7" style label for the Sat→Fri week starting `weekStart`. */
export function payrollWeekLabel(weekStart: string): string {
  const parts = weekStart.split('-').map(n => parseInt(n, 10));
  if (parts.length !== 3) return weekStart;
  const sat = new Date(parts[0], parts[1] - 1, parts[2]);
  const fri = new Date(sat);
  fri.setDate(fri.getDate() + 6);
  const fmt: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric' };
  return `${sat.toLocaleDateString('en-US', fmt)} – ${fri.toLocaleDateString('en-US', fmt)}`;
}
