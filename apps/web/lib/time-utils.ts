export const HOUR_H  = 68;          // default px per hour (used as fallback)
export const GRID_H  = 24 * HOUR_H; // default total grid height
export const GUTTER_W = 64;         // hour label gutter width

/**
 * Anchor timezone for stored appointment times.
 *
 * Stops store `appt_start`/`appt_end` as naive "YYYY-MM-DDTHH:mm" strings
 * (see schema.sql). Those strings are interpreted as wall-clock in
 * HOME_TZ at render time and re-formatted into the user's current view
 * timezone (`calendarTimezone`). Same anchor is used in reverse on save
 * so a "08:00" typed while the view is ET stores as "06:00" (MT).
 *
 * Hardcoded for now — single-org SaaS. If/when multi-org with distinct
 * home zones lands, promote this to org_settings.
 */
export const HOME_TZ = 'America/Denver';

export function timeToPixels(timeStr: string, hourH: number = HOUR_H): number {
  const timePart = timeStr.includes('T') ? timeStr.split('T')[1] : timeStr;
  const [hours, minutes] = timePart.split(':').map(Number);
  return (hours + minutes / 60) * hourH;
}

export function timeHeightPixels(start: string, end: string, clampToDate?: string, hourH: number = HOUR_H): number {
  const gridH     = 24 * hourH;
  const startDate = start.split('T')[0];
  const endDate   = end.split('T')[0];
  const startPx   = clampToDate && startDate < clampToDate ? 0 : timeToPixels(start, hourH);
  const endPx     = clampToDate && endDate > clampToDate ? gridH : timeToPixels(end, hourH);
  if (!clampToDate && endDate > startDate) {
    const dayDiff = Math.round(
      (new Date(endDate).getTime() - new Date(startDate).getTime()) / 86_400_000
    );
    return Math.max(timeToPixels(end, hourH) - timeToPixels(start, hourH) + dayDiff * gridH, 22);
  }
  return Math.max(endPx - startPx, 22);
}

export function formatHour(hour: number): string {
  if (hour === 0) return '12a';
  if (hour < 12) return `${hour}a`;
  if (hour === 12) return '12p';
  return `${hour - 12}p`;
}

export function localDateStr(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * Coerce whatever's stored as the "timezone" setting into something
 * Intl.DateTimeFormat will accept, or undefined.
 *
 * Real-world store has shapes like:
 *   "America/Denver"                       — clean IANA, pass through
 *   "Mountain Time (America/Denver)"       — display label with paren
 *   "America/Denver (MDT)"                 — IANA with trailing abbr
 *   ""                                     — empty, treat as unset
 *   "Some Garbage"                         — invalid, treat as unset
 *
 * We strip a parenthesized substring matching an IANA pattern (one
 * or more `Word/Word` segments) and use that if found. Then we
 * validate the result by attempting an Intl.DateTimeFormat in a
 * try/catch — if it throws, return undefined so callers fall back
 * to the browser's local zone.
 */
export function sanitizeTimezone(raw: string | undefined | null): string | undefined {
  if (!raw) return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  // Pull "America/Denver"-ish substring from anywhere in the string.
  const ianaMatch = trimmed.match(/[A-Za-z]+\/[A-Za-z_+\-]+(?:\/[A-Za-z_+\-]+)?/);
  const candidate = ianaMatch ? ianaMatch[0] : trimmed;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: candidate });
    return candidate;
  } catch {
    return undefined;
  }
}

/**
 * Returns the UTC offset (in ms) of `tz` at `epochMs`. Accounts for
 * DST transitions because we ask Intl what the wall-clock would
 * literally read at that moment in that zone, then compare to the
 * same moment as if it were UTC.
 *
 *   offsetMs = (epochMs displayed as wall-time in tz, treated as UTC) − epochMs
 *
 * Example: epoch = 2026-05-14T20:00Z, tz = 'America/Denver' (MDT)
 *   - wall in MT: 2026-05-14 14:00:00
 *   - treat as UTC: 2026-05-14T14:00Z
 *   - difference: −6h (matches MDT's UTC-6)
 */
function tzOffsetMsAt(epochMs: number, tz: string): number {
  const date = new Date(epochMs);
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year:   'numeric',
    month:  '2-digit',
    day:    '2-digit',
    hour:   '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(date);
  const o: Record<string, string> = {};
  for (const p of parts) o[p.type] = p.value;
  // Intl emits '24' for midnight in some locales — normalize.
  const hour = o.hour === '24' ? '0' : o.hour;
  const tzWallAsUtcMs = Date.UTC(
    Number(o.year), Number(o.month) - 1, Number(o.day),
    Number(hour),   Number(o.minute),    Number(o.second),
  );
  return tzWallAsUtcMs - epochMs;
}

/**
 * Parse a naive ISO string (`YYYY-MM-DDTHH:mm` or with seconds, no
 * timezone suffix) as a wall-clock time in `tz` and return the true
 * UTC milliseconds.
 *
 * Why this exists: event start/end are stored as naive ISO meant to
 * be read in the org's dispatch timezone (see CalendarEvent.start).
 * `new Date(iso)` interprets naive ISO as the browser's local zone,
 * so a dispatcher in ET viewing an MT-based org sees event boundaries
 * shifted by the offset difference — breaks "in progress" detection,
 * window filters, etc.
 *
 * If `tz` is undefined we fall back to native parsing (same as
 * `new Date(iso).getTime()`), which keeps behavior identical for
 * orgs that haven't picked a timezone.
 */
export function parseNaiveIsoInTz(iso: string, tz: string | undefined): number {
  if (!tz) return new Date(iso).getTime();
  const [datePart, timePartRaw = '0:0:0'] = iso.split('T');
  const [y, M, d] = datePart.split('-').map(Number);
  const [h, m, s] = timePartRaw.split(':').map(n => Number(n) || 0);
  // First-pass: treat the wall components as if they were UTC.
  const wallAsUtcMs = Date.UTC(y, (M ?? 1) - 1, d ?? 1, h ?? 0, m ?? 0, s ?? 0);
  // Then back out the offset at that approximate moment. One pass is
  // enough except on the literal DST transition hour, where a second
  // pass with the corrected moment lands on the right side of the
  // jump.
  let offset = tzOffsetMsAt(wallAsUtcMs, tz);
  let candidate = wallAsUtcMs - offset;
  const refinedOffset = tzOffsetMsAt(candidate, tz);
  if (refinedOffset !== offset) {
    offset = refinedOffset;
    candidate = wallAsUtcMs - offset;
  }
  return candidate;
}

/**
 * Format a UTC epoch as a naive "YYYY-MM-DDTHH:mm" string of wall-clock
 * in `tz`. Inverse of parseNaiveIsoInTz — round-trip a naive iso through
 * (parseNaiveIsoInTz → formatNaiveIsoInTz) and you get back the original
 * naive string (modulo seconds, which we drop).
 */
function formatNaiveIsoInTz(epochMs: number, tz: string): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year:   'numeric',
    month:  '2-digit',
    day:    '2-digit',
    hour:   '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(new Date(epochMs));
  const o: Record<string, string> = {};
  for (const p of parts) o[p.type] = p.value;
  const hour = o.hour === '24' ? '00' : o.hour;
  return `${o.year}-${o.month}-${o.day}T${hour}:${o.minute}`;
}

/**
 * Convert a naive ISO string (anchored in HOME_TZ) to the same instant
 * rendered as a naive ISO string in `viewTz`.
 *
 *   HOME=MT, view=ET, input "2026-05-19T08:00" → "2026-05-19T10:00"
 *
 * Used at every read site where stored appointment/event times need
 * to display in the user's current view timezone. When viewTz is
 * undefined or equals HOME_TZ, returns input unchanged.
 */
export function naiveHomeToView(iso: string, viewTz: string | undefined): string {
  if (!iso) return iso;
  const tz = sanitizeTimezone(viewTz);
  if (!tz || tz === HOME_TZ) return iso;
  const utcMs = parseNaiveIsoInTz(iso, HOME_TZ);
  return formatNaiveIsoInTz(utcMs, tz);
}

/**
 * Inverse of naiveHomeToView — convert a naive ISO entered/displayed in
 * `viewTz` back to HOME_TZ for storage.
 *
 *   HOME=MT, view=ET, input "2026-05-19T08:00" → "2026-05-19T06:00"
 *
 * Used at every write site that takes a user-entered time while the
 * view tz differs from HOME_TZ. When viewTz is undefined or equals
 * HOME_TZ, returns input unchanged.
 */
export function naiveViewToHome(iso: string, viewTz: string | undefined): string {
  if (!iso) return iso;
  const tz = sanitizeTimezone(viewTz);
  if (!tz || tz === HOME_TZ) return iso;
  const utcMs = parseNaiveIsoInTz(iso, tz);
  return formatNaiveIsoInTz(utcMs, HOME_TZ);
}

// Returns a Date whose .getHours()/.getDate() etc. reflect the given IANA timezone.
export function nowInTz(tz: string): Date {
  return new Date(new Date().toLocaleString('en-US', { timeZone: tz }));
}

// Today's date string in a given IANA timezone.
export function todayStrInTz(tz: string): string {
  return localDateStr(nowInTz(tz));
}

// Short timezone abbreviation, e.g. "MDT", "MST", "EST"
export function tzAbbr(tz: string): string {
  return new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'short' })
    .formatToParts(new Date())
    .find(p => p.type === 'timeZoneName')?.value ?? tz;
}

// Convert a fractional-hours value (e.g. 7.5) → "07:30"
export function hoursToTimeStr(hours: number): string {
  const h = Math.floor(hours);
  const m = Math.round((hours % 1) * 60);
  if (m === 60) return `${String(h + 1).padStart(2, '0')}:00`;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/**
 * Parses relaxed time strings into "HH:mm".
 * Examples: "8am"→"08:00", "800am"→"08:00", "130pm"→"13:30",
 *           "1130"→"11:30", "0800"→"08:00", "8:30pm"→"20:30"
 */
export function parseTimeInput(raw: string): string | null {
  const s = raw.trim().toLowerCase().replace(/\s/g, '');
  if (!s) return null;

  const isPm = /p(m)?$/.test(s);
  const isAm = /a(m)?$/.test(s);
  const stripped = s.replace(/(am|pm|a|p)$/, '');

  let h: number, m: number;

  if (stripped.includes(':')) {
    const [hp, mp] = stripped.split(':');
    h = parseInt(hp, 10);
    m = parseInt(mp || '0', 10);
  } else {
    const digits = stripped.replace(/\D/g, '');
    if (!digits) return null;
    if (digits.length <= 2) {
      h = parseInt(digits, 10); m = 0;
    } else if (digits.length === 3) {
      h = parseInt(digits[0], 10); m = parseInt(digits.slice(1), 10);
    } else if (digits.length === 4) {
      h = parseInt(digits.slice(0, 2), 10); m = parseInt(digits.slice(2), 10);
    } else {
      return null;
    }
  }

  if (isNaN(h) || isNaN(m) || m > 59 || m < 0) return null;
  if (isPm && h < 12) h += 12;
  if (isAm && h === 12) h = 0;
  if (h === 24) h = 0;
  if (h < 0 || h > 23) return null;

  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

export function addMsToNaiveDatetime(datetimeStr: string, ms: number): string {
  const [datePart, timePart] = datetimeStr.split('T');
  const [h, m] = timePart.split(':').map(Number);
  const totalMinutes = h * 60 + m + Math.round(ms / 60000);
  const extraDays = Math.floor(totalMinutes / (24 * 60));
  const minutesInDay = ((totalMinutes % (24 * 60)) + 24 * 60) % (24 * 60);
  const endH = Math.floor(minutesInDay / 60);
  const endM = minutesInDay % 60;
  const [y, mo, d] = datePart.split('-').map(Number);
  const endDate = new Date(y, mo - 1, d + extraDays);
  return `${localDateStr(endDate)}T${String(endH).padStart(2, '0')}:${String(endM).padStart(2, '0')}`;
}

export function formatDisplayDate(d: Date): string {
  return d.toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  });
}
