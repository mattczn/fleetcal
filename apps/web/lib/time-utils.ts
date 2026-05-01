export const HOUR_H  = 68;          // default px per hour (used as fallback)
export const GRID_H  = 24 * HOUR_H; // default total grid height
export const GUTTER_W = 64;         // hour label gutter width

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
