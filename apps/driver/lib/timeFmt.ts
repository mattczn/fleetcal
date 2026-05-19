/**
 * Driver-app time formatting helpers.
 *
 * Stops carry an IANA `timezone` populated when the stop is geocoded
 * (e.g. "America/Denver" for a Denver pickup). The driver's phone has
 * its own tz from Intl.DateTimeFormat. This module provides:
 *
 *   - parseNaiveIsoInTz: read a naive ISO "YYYY-MM-DDTHH:mm" string
 *     as if it were wall-clock in a target tz, return UTC ms.
 *   - formatTimeInTz: render a naive ISO in any display tz, e.g.
 *     "5:00 PM" or "7:00 PM".
 *   - tzAbbr: short label for a tz at "now" — "MT" / "ET" / "CT" /
 *     "PT" with DST flavor (MDT/EDT/etc.) when applicable. The
 *     helper strips the daylight suffix to keep the chip short.
 *   - getDeviceTz: the phone's IANA tz, falls back to "UTC".
 *   - tzOffsetHours: signed offset hours from UTC for a given tz.
 *     Used by the mismatch banner to phrase "2h ahead" / "3h behind".
 */

/** Phone's IANA tz, e.g. "America/New_York". Falls back to UTC if
 *  the Intl API doesn't report one. */
export function getDeviceTz(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

/** Signed UTC offset in hours for `tz` at `at`. Eastern Daylight
 *  returns -4, Mountain Daylight returns -6, etc. */
export function tzOffsetHours(tz: string, at: Date = new Date()): number {
  // Format the same instant in UTC and in `tz`, compute the wall-clock
  // gap. Using en-CA (ISO-ish) so parsing is deterministic.
  const fmt = (timeZone: string) => new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
  }).formatToParts(at);
  const toEpoch = (parts: Intl.DateTimeFormatPart[]): number => {
    const get = (t: string) => Number(parts.find(p => p.type === t)?.value ?? "0");
    const hh = get("hour") === 24 ? 0 : get("hour");
    return Date.UTC(get("year"), get("month") - 1, get("day"), hh, get("minute"), get("second"));
  };
  const utcEpoch = toEpoch(fmt("UTC"));
  const tzEpoch  = toEpoch(fmt(tz));
  return Math.round((tzEpoch - utcEpoch) / 3_600_000);
}

/** Parse a naive ISO "YYYY-MM-DDTHH:mm[:ss]" as wall-clock time in
 *  `tz`, return UTC milliseconds. */
export function parseNaiveIsoInTz(iso: string, tz: string | undefined | null): number {
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?/);
  if (!m) return Date.parse(iso); // fall back to native parsing
  const [, yStr, moStr, dStr, hStr, miStr, sStr] = m;
  const y  = Number(yStr);
  const mo = Number(moStr);
  const d  = Number(dStr);
  const h  = Number(hStr);
  const mi = Number(miStr);
  const s  = Number(sStr ?? "0");
  if (!tz) return Date.UTC(y, mo - 1, d, h, mi, s);
  // Initial guess: pretend it's UTC, then nudge by the tz offset
  // at that instant. One pass is enough for non-DST-boundary times;
  // a second pass handles the rare DST overlap edge.
  const guess = Date.UTC(y, mo - 1, d, h, mi, s);
  const offset1 = tzOffsetHours(tz, new Date(guess));
  const corrected = guess - offset1 * 3_600_000;
  // DST refinement: if the offset at the corrected moment differs,
  // apply that diff. Handles "spring forward / fall back" boundaries.
  const offset2 = tzOffsetHours(tz, new Date(corrected));
  if (offset2 === offset1) return corrected;
  return guess - offset2 * 3_600_000;
}

/** Render a naive ISO in any display tz. Returns e.g. "5:00 PM".
 *  `sourceTz` is how the naive ISO is currently meant to be read;
 *  `displayTz` is how to format it. */
export function formatTimeInTz(naiveIso: string, sourceTz: string, displayTz: string): string {
  if (!naiveIso) return "—";
  const utcMs = parseNaiveIsoInTz(naiveIso, sourceTz);
  return new Date(utcMs).toLocaleTimeString("en-US", {
    timeZone: displayTz,
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
}

/** Short tz label suitable for inline display (e.g. "MT", "ET", "CT",
 *  "PT", "AKT", "HST"). Strips daylight-saving variations so the chip
 *  stays compact. Falls back to the IANA name if the locale doesn't
 *  give us a short name. */
export function tzAbbr(tz: string, at: Date = new Date()): string {
  try {
    const parts = new Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName: "short" })
      .formatToParts(at);
    const raw = parts.find(p => p.type === "timeZoneName")?.value ?? tz;
    // Normalize MDT/MST → MT, EDT/EST → ET, CDT/CST → CT, PDT/PST → PT,
    // AKDT/AKST → AKT. Anything else passes through.
    return raw
      .replace(/^(M|E|C|P|AK)(D|S)T$/, "$1T")
      .replace(/^(H)(D|S)T$/, "$1ST"); // Hawaii uses HST year-round; pass through
  } catch {
    return tz;
  }
}

/** "2h ahead" / "3h behind" / "same time" — used by the banner to
 *  describe the offset between two zones. */
export function tzOffsetDescription(stopTz: string, deviceTz: string, at: Date = new Date()): string {
  const diff = tzOffsetHours(stopTz, at) - tzOffsetHours(deviceTz, at);
  if (diff === 0) return "same time";
  const h = Math.abs(diff);
  const unit = h === 1 ? "hour" : "hours";
  return diff > 0 ? `${h} ${unit} ahead of your phone` : `${h} ${unit} behind your phone`;
}
