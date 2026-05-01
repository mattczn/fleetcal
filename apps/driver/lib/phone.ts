/**
 * Normalize a US phone number to E.164 format (+1XXXXXXXXXX).
 * Mirror of dispatch-next/lib/phone.ts — keep these in sync so phone-based
 * driver lookup matches whatever the web app stored.
 */
export function normalizePhone(input: string | null | undefined): string | null {
  if (!input) return null;
  const digits = input.replace(/\D/g, "");
  if (digits.length < 10) return null;
  return `+1${digits.slice(-10)}`;
}
