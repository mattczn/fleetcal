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

/** Returns a Date whose .getHours() / .getDate() etc. reflect the
 *  given IANA timezone. Round-trip trick: format current moment in
 *  `tz` as a locale string, then re-parse it (which the browser does
 *  in its own local tz) — the resulting Date's .getHours() reads the
 *  tz's wall-clock hour because the offset cancelled out twice. */
export function nowInTz(tz: string | null | undefined): Date {
  if (!tz) return new Date();
  try {
    return new Date(new Date().toLocaleString("en-US", { timeZone: tz }));
  } catch {
    return new Date();
  }
}

/** "YYYY-MM-DD" for the current calendar date in the given tz. */
export function todayKeyInTz(tz: string | null | undefined): string {
  const d = nowInTz(tz);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
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
