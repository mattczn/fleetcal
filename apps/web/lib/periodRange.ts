/**
 * Period range helpers — shared between any surface that lets the
 * dispatcher scope data by a date range (dashboard, equipment fuel
 * tab, future report views).
 *
 * `Period` is a stable enum of the 6 quick presets we offer (week,
 * month, 30d, 90d, ytd, custom). `getPeriodRange` converts one of
 * those into a concrete { start: Date, end: Date } pair anchored to
 * the browser's local timezone — same convention the calendar grid
 * uses, so a "today" lookup in either place agrees on the day.
 *
 * Week is Saturday → Friday (matches Curzon's pay-week).
 * Month is calendar month, day 1 → last day.
 * 30d / 90d are rolling windows ending today.
 * YTD is Jan 1 of the current year → today.
 * Custom takes ISO YYYY-MM-DD strings; guards against inverted ranges.
 */

export type Period = 'week' | 'month' | '30d' | '90d' | 'ytd' | 'custom';

export interface PeriodRange { start: Date; end: Date }

export const PERIODS: { value: Period; label: string }[] = [
  { value: 'week',   label: 'Week' },
  { value: 'month',  label: 'This Month' },
  { value: '30d',    label: '30 Days' },
  { value: '90d',    label: '90 Days' },
  { value: 'ytd',    label: 'YTD' },
  { value: 'custom', label: 'Custom' },
];

/** Returns the most-recent Saturday on or before `today` as a YYYY-MM-DD
 *  string. Used to seed the "Week" period's default weekStartISO and to
 *  anchor the started-weeks dropdown. */
export function currentWeekStartISO(): string {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const dow = today.getDay();
  const sat = new Date(today);
  sat.setDate(today.getDate() - ((dow + 1) % 7));
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${sat.getFullYear()}-${pad(sat.getMonth() + 1)}-${pad(sat.getDate())}`;
}

/** Builds the list of started weeks (current week + N past weeks),
 *  labeled with their Sat → Fri range. Matches the timeline page's
 *  week dropdown shape. */
export function startedWeeksISO(count = 12): Array<{ weekStart: string; label: string }> {
  const items: Array<{ weekStart: string; label: string }> = [];
  const monthNames = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  let cur = currentWeekStartISO();
  for (let i = 0; i < count; i++) {
    const [y, m, d] = cur.split('-').map(Number);
    const sat = new Date(y, m - 1, d);
    const fri = new Date(sat);
    fri.setDate(sat.getDate() + 6);
    const sameMonth = sat.getMonth() === fri.getMonth();
    const left  = `${monthNames[sat.getMonth()]} ${sat.getDate()}`;
    const right = sameMonth ? `${fri.getDate()}` : `${monthNames[fri.getMonth()]} ${fri.getDate()}`;
    let label = `${left} – ${right}`;
    if (i === 0)      label = `This week (${label})`;
    else if (i === 1) label = `Last week (${label})`;
    items.push({ weekStart: cur, label });
    // Step back 7 days.
    const prev = new Date(sat);
    prev.setDate(sat.getDate() - 7);
    const pad = (n: number) => String(n).padStart(2, '0');
    cur = `${prev.getFullYear()}-${pad(prev.getMonth() + 1)}-${pad(prev.getDate())}`;
  }
  return items;
}

export function getPeriodRange(
  period: Period,
  custom?: { startISO: string; endISO: string; weekStartISO?: string },
): PeriodRange {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());

  switch (period) {
    case 'week': {
      // Week runs Saturday → Friday. Accept an explicit weekStartISO
      // so a "week picker" UI can select any past week without losing
      // the Sat→Fri shape.
      if (custom?.weekStartISO) {
        const [y, m, d] = custom.weekStartISO.split('-').map(Number);
        const sat = new Date(y, (m ?? 1) - 1, d ?? 1);
        const fri = new Date(sat);
        fri.setDate(sat.getDate() + 6);
        return { start: sat, end: fri };
      }
      // Default: the week containing today.
      const dow = today.getDay(); // 0=Sun … 6=Sat
      const sat = new Date(today);
      sat.setDate(today.getDate() - ((dow + 1) % 7)); // back to most-recent Saturday
      const fri = new Date(sat);
      fri.setDate(sat.getDate() + 6);
      return { start: sat, end: fri };
    }
    case 'month':
      return {
        start: new Date(today.getFullYear(), today.getMonth(), 1),
        end:   new Date(today.getFullYear(), today.getMonth() + 1, 0),
      };
    case '30d': {
      const s = new Date(today); s.setDate(today.getDate() - 29);
      return { start: s, end: today };
    }
    case '90d': {
      const s = new Date(today); s.setDate(today.getDate() - 89);
      return { start: s, end: today };
    }
    case 'ytd':
      return { start: new Date(today.getFullYear(), 0, 1), end: today };
    case 'custom': {
      // Local-date parsing avoids the UTC-shift trap on YYYY-MM-DD strings.
      const parse = (iso: string): Date => {
        const [y, m, d] = iso.split('-').map(Number);
        return new Date(y, (m ?? 1) - 1, d ?? 1);
      };
      const fallback = { start: today, end: today };
      if (!custom?.startISO || !custom?.endISO) return fallback;
      const start = parse(custom.startISO);
      const end   = parse(custom.endISO);
      // Guard against end < start from typos.
      return start <= end ? { start, end } : { start: end, end: start };
    }
  }
}

/** Default custom-range seed: the start + end of the current month
 *  as YYYY-MM-DD strings. Used as the initial value for the date
 *  pickers so toggling to "Custom" doesn't dump empty inputs. */
export function defaultCustomRangeISO(): { start: string; end: string } {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), 1);
  const end   = new Date(now.getFullYear(), now.getMonth() + 1, 0);
  const iso = (d: Date) => {
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  };
  return { start: iso(start), end: iso(end) };
}
