/**
 * Normalize a US phone number to E.164 format (+1XXXXXXXXXX).
 * Strips all non-digits, takes the last 10 digits, prepends +1.
 * Returns null for empty input or fewer than 10 digits.
 *
 * Used by both the dispatch web app (driver create/edit) and the driver
 * mobile app (login lookup) so phone-based matching is consistent.
 */
export function normalizePhone(input: string | null | undefined): string | null {
  if (!input) return null;
  const digits = input.replace(/\D/g, '');
  if (digits.length < 10) return null;
  return `+1${digits.slice(-10)}`;
}
