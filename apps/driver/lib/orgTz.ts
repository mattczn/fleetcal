/**
 * Org-timezone helpers for the driver app.
 *
 * The org's dispatch tz (e.g. "America/Denver" for Curzon) is the
 * canonical zone for all naive ISO date/time strings stored on loads,
 * events, and stops. The driver app must NEVER fall back to the
 * device's local tz for "now" or "today" math — that's how we end up
 * with the now-line at the wrong hour and "Today" pointing at the
 * wrong day when the driver's phone is in a different zone than the
 * org. Use `nowInTz()` and `todayKeyInTz()` instead of
 * `new Date().getHours()` / `dateKeyFromDate(new Date())`.
 *
 * The org tz is fetched once on app load by `useOrgTz()` (React Query
 * caches it for 5 min). Fallback is intentionally `null` so callers
 * can choose what to do if the org hasn't configured one.
 */
import { useQuery } from "@tanstack/react-query";
import { railway } from "@/lib/railway";

/** Subscribes to the org's dispatch tz. Returns the IANA string (e.g.
 *  "America/Denver") or null if the org hasn't configured one. */
export function useOrgTz(driverId: number | null | undefined, orgId: string | null | undefined): string | null {
  const { data } = useQuery({
    queryKey: ["org-tz", orgId],
    queryFn:  async () => {
      const res = await railway.getOrgSettings();
      return res.settings.timezone ?? null;
    },
    enabled:   !!driverId && !!orgId,
    staleTime: 5 * 60 * 1000,
  });
  return data ?? null;
}

/** Read current wall-clock parts in the given tz. We avoid the
 *  `new Date(toLocaleString(...))` round-trip because Hermes (React
 *  Native's iOS JS engine) returns Invalid Date for the en-US
 *  locale string output. formatToParts is reliable across engines. */
function partsInTz(tz: string | null | undefined): {
  year: number; month: number; day: number; hour: number; minute: number;
} {
  if (!tz) {
    const d = new Date();
    return { year: d.getFullYear(), month: d.getMonth() + 1, day: d.getDate(), hour: d.getHours(), minute: d.getMinutes() };
  }
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: tz,
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", hour12: false,
    }).formatToParts(new Date());
    const get = (t: string) => Number(parts.find(p => p.type === t)?.value ?? "0");
    const hh = get("hour") === 24 ? 0 : get("hour");
    return { year: get("year"), month: get("month"), day: get("day"), hour: hh, minute: get("minute") };
  } catch {
    const d = new Date();
    return { year: d.getFullYear(), month: d.getMonth() + 1, day: d.getDate(), hour: d.getHours(), minute: d.getMinutes() };
  }
}

/** A Date whose .getFullYear() / .getMonth() / .getDate() / .getHours() /
 *  .getMinutes() reflect the wall clock in `tz`. The Date's absolute
 *  UTC instant is meaningless — only the components matter. Built
 *  directly from formatToParts so it works on Hermes (iOS RN). */
export function nowInTz(tz: string | null | undefined): Date {
  const p = partsInTz(tz);
  return new Date(p.year, p.month - 1, p.day, p.hour, p.minute, 0);
}

/** "YYYY-MM-DD" for the current calendar date in the given tz. */
export function todayKeyInTz(tz: string | null | undefined): string {
  const p = partsInTz(tz);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
}

/** Short tz label suitable for inline display: "MT", "ET", "CT", "PT",
 *  "AKT". Strips MDT/MST/EDT/EST etc. variations so the chip stays
 *  compact. Falls back to the raw IANA name if Intl doesn't give us
 *  a short name. */
export function tzAbbr(tz: string | null | undefined, at: Date = new Date()): string {
  if (!tz) return "";
  try {
    const parts = new Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName: "short" })
      .formatToParts(at);
    const raw = parts.find(p => p.type === "timeZoneName")?.value ?? tz;
    return raw.replace(/^(M|E|C|P|AK)(D|S)T$/, "$1T");
  } catch {
    return tz;
  }
}

/** Human label for the driver-profile read-only row, e.g.
 *  "Mountain Time (America/Denver) · MT". */
export function describeTz(tz: string | null | undefined): string {
  if (!tz) return "—";
  const abbr = tzAbbr(tz);
  return abbr && abbr !== tz ? `${tz} · ${abbr}` : tz;
}
