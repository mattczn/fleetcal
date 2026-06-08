/**
 * POST /api/sms/opt-in
 *
 * Public endpoint backing the /sms-consent web form. Validates
 * the submitted phone, normalizes to E.164, and writes one row
 * to sms_consents with the full disclosure text the user agreed
 * to plus the user-agent + IP we can capture from the request.
 *
 * Returns 200 on success even if there's already a recent consent
 * for the same phone — re-opting in after a STOP is intentional
 * behavior, and we want a row per affirmative action.
 *
 * This route is PUBLIC (no Clerk auth). It's also added to
 * middleware.ts public-route allowlist. Rate-limited via a tiny
 * in-memory window so a script can't blast it.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseServer } from '@/lib/supabase-server';

export const dynamic = 'force-dynamic';

// Tiny per-IP burst guard. NOT a substitute for a real WAF — this
// just stops a casual script from inserting thousands of rows in
// seconds. Survives a serverless cold start only; that's fine for
// our scale.
const RATE_WINDOW_MS = 60_000;
const RATE_MAX       = 5; // 5 submissions per minute per IP
const recentByIp = new Map<string, number[]>();

interface OptInBody {
  phone?:        string;
  consent_text?: string;
}

export async function POST(req: NextRequest) {
  let body: OptInBody;
  try {
    body = await req.json() as OptInBody;
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }

  const phoneInput  = (body.phone ?? '').trim();
  const consentText = (body.consent_text ?? '').trim();
  if (!phoneInput || !consentText) {
    return NextResponse.json({ error: 'phone_and_consent_required' }, { status: 400 });
  }
  if (consentText.length > 4000) {
    return NextResponse.json({ error: 'consent_text_too_long' }, { status: 400 });
  }

  const phoneE164 = normalizeToE164(phoneInput);
  if (!phoneE164) {
    return NextResponse.json({ error: 'invalid_phone' }, { status: 400 });
  }

  // ── Rate limit ─────────────────────────────────────────────────
  const ip = req.headers.get('x-forwarded-for')?.split(',')[0].trim() || 'unknown';
  if (!checkRate(ip)) {
    return NextResponse.json({ error: 'rate_limited' }, { status: 429 });
  }

  // ── Persist ────────────────────────────────────────────────────
  const db = getSupabaseServer();
  const userAgent = req.headers.get('user-agent') ?? null;
  const insertRes = await db
    .from('sms_consents')
    .insert({
      phone:        phoneE164,
      consent_text: consentText,
      user_agent:   userAgent,
      ip_address:   ip === 'unknown' ? null : ip,
      source:       'web_form',
    })
    .select('id, consented_at')
    .single();

  if (insertRes.error) {
    console.error('[sms/opt-in] insert failed:', insertRes.error.message);
    return NextResponse.json({ error: 'persist_failed' }, { status: 500 });
  }

  return NextResponse.json({
    ok:           true,
    consentId:    insertRes.data.id,
    consentedAt:  insertRes.data.consented_at,
    phone:        phoneE164,
  });
}

// ── Helpers ──────────────────────────────────────────────────────

/**
 * Normalize a US/CA phone to E.164. Returns null if the input
 * can't be coerced. Twilio expects E.164 in the `To` field, and
 * STOP-keyword webhooks arrive in E.164 too, so storing this way
 * keeps the join trivial.
 *
 * Rules:
 *   - Strip everything except digits and a leading +.
 *   - If no `+`, assume US/CA: 10 digits → prefix +1; 11 digits
 *     starting with 1 → prefix +.
 *   - Anything else returns null.
 *
 * We intentionally avoid pulling in libphonenumber-js (massive
 * bundle for one endpoint). When/if international drivers exist,
 * swap in the library here.
 */
function normalizeToE164(input: string): string | null {
  const trimmed = input.trim();
  if (trimmed.startsWith('+')) {
    const digits = trimmed.slice(1).replace(/\D/g, '');
    if (digits.length < 8 || digits.length > 15) return null;
    return `+${digits}`;
  }
  const digits = trimmed.replace(/\D/g, '');
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  return null;
}

function checkRate(ip: string): boolean {
  const now = Date.now();
  const arr = recentByIp.get(ip) ?? [];
  const fresh = arr.filter(ts => ts > now - RATE_WINDOW_MS);
  if (fresh.length >= RATE_MAX) {
    recentByIp.set(ip, fresh);
    return false;
  }
  fresh.push(now);
  recentByIp.set(ip, fresh);
  // Occasional cleanup — when the map gets big, prune cold entries.
  if (recentByIp.size > 1000) {
    for (const [k, v] of recentByIp) {
      if (v.every(ts => ts <= now - RATE_WINDOW_MS)) recentByIp.delete(k);
    }
  }
  return true;
}
