/**
 * Org-timezone helpers for the dispatch app.
 *
 * Load times in the system are stored as naive `YYYY-MM-DDTHH:mm` strings
 * already expressed in the org's timezone, so DISPLAY of those times needs
 * no conversion. What does need fixing is anything derived from the device
 * clock — "now" indicators on the calendar, the "today" the calendar opens
 * on, the "Today / Tomorrow / Yesterday" labels. Those should reflect the
 * org's clock, not the dispatcher's phone.
 *
 * The org timezone is configured per-org under
 * `org_settings.rate_con_settings.promptVariables.timezone`, often stored
 * with a friendly prefix like "Mountain Time (America/Denver)". We
 * extract the IANA portion and validate it against `Intl.DateTimeFormat`
 * before using it; anything we can't parse falls back to device-local
 * (existing behavior) so the app always renders something.
 */
import { useQuery } from "@tanstack/react-query";
import { useOrganization } from "@clerk/clerk-expo";
import { railway } from "./railway";

/** Pull the IANA portion ("America/Denver") out of values like
 *  "Mountain Time (America/Denver)". Returns null if no parseable zone is
 *  found. Mirrors the same helper on the API side (driver.ts). */
export function sanitizeTz(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const m = raw.match(/[A-Za-z]+\/[A-Za-z_+\-]+(?:\/[A-Za-z_+\-]+)?/);
  const candidate = m ? m[0] : raw.trim();
  try {
    // Throws RangeError on an invalid timeZone option.
    new Intl.DateTimeFormat("en-US", { timeZone: candidate });
    return candidate;
  } catch {
    return null;
  }
}

function pad2(n: number) { return String(n).padStart(2, "0"); }

/** "Now" broken into calendar parts as observed in `tz`. Uses
 *  `Intl.DateTimeFormat.formatToParts` so we get a clean object instead
 *  of having to regex-parse a localized string. Hermes (the JS engine
 *  Expo SDK 55 runs) supports both `timeZone` and `formatToParts`. */
export function nowPartsInTz(tz: string, when: Date = new Date()): {
  year:    number;
  month:   number;
  day:     number;
  hours:   number;
  minutes: number;
} {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year:    "numeric",
    month:   "2-digit",
    day:     "2-digit",
    hour:    "2-digit",
    minute:  "2-digit",
    hour12:  false,
  }).formatToParts(when);

  const get = (type: string) =>
    Number(parts.find((p) => p.type === type)?.value ?? "0");

  // Intl returns "24" for midnight under `hour12:false` + `hour:'2-digit'`
  // on some engines — normalize that to 0.
  const hRaw = get("hour");
  return {
    year:    get("year"),
    month:   get("month"),
    day:     get("day"),
    hours:   hRaw === 24 ? 0 : hRaw,
    minutes: get("minute"),
  };
}

/** "Today" in the org's calendar as a YYYY-MM-DD key. */
export function todayKeyInTz(tz: string, when: Date = new Date()): string {
  const p = nowPartsInTz(tz, when);
  return `${p.year}-${pad2(p.month)}-${pad2(p.day)}`;
}

/** Device-local equivalent (existing behavior) — used as a fallback when
 *  the org TZ is missing or invalid. */
export function todayKeyDeviceLocal(when: Date = new Date()): string {
  return `${when.getFullYear()}-${pad2(when.getMonth() + 1)}-${pad2(when.getDate())}`;
}

/**
 * useOrgTimezone — resolves the org's IANA timezone (or null on fallback)
 * via the existing `/v1/org-settings` endpoint. Cached aggressively
 * because it changes maybe once in the lifetime of an org.
 *
 * Returns the raw query state too in case a caller wants to differentiate
 * "still loading" from "loaded and there's no TZ set". Most callers can
 * just read `tz` and treat null as "use device default."
 */
export function useOrgTimezone() {
  const { organization } = useOrganization();
  const orgId = organization?.id;

  const q = useQuery({
    queryKey: ["org-settings", "timezone", orgId],
    queryFn: async () => {
      const { settings } = await railway.getOrgSettings();
      return sanitizeTz(settings?.rateConSettings?.promptVariables?.timezone);
    },
    enabled:   !!orgId,
    staleTime: 60 * 60 * 1000, // 1 hour
  });

  return { tz: q.data ?? null, isLoading: q.isLoading };
}
