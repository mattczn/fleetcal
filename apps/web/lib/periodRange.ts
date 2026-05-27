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
  { value: 'week',   label: 'This Week' },
  { value: 'month',  label: 'This Month' },
  { value: '30d',    label: '30 Days' },
  { value: '90d',    label: '90 Days' },
  { value: 'ytd',    label: 'YTD' },
  { value: 'custom', label: 'Custom' },
];

export function getPeriodRange(
  period: Period,
  custom?: { startISO: string; endISO: string },
): PeriodRange {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());

  switch (period) {
    case 'week': {
      // Week runs Saturday → Friday
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
