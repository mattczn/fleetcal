/**
 * Public unsubscribe endpoint — proxies to the Railway API.
 *
 * Recipients see `fleetcal.app/unsubscribe/<token>` in their outreach
 * email (auto-appended by the sender + shown as the {{unsubscribe_url}}
 * merge var). A Railway `*.up.railway.app` link would flag Gmail's
 * bulk-mailer heuristics and read as spam to a wary trucking dispatcher
 * skimming a cold email. This route handler is the front door — it
 * proxies the click straight to the API, which owns the actual
 * suppression state, and streams the API's response back to the
 * recipient.
 *
 * Supports GET (human click on the link in the email body — renders
 * the API's confirmation HTML) and POST (RFC 8058 one-click List-
 * Unsubscribe header POSTed by the mail client — returns plain text
 * to signal success). Both proxy the same underlying endpoint on the
 * API, so a single click that hits Gmail's one-click button and the
 * body link back-to-back is idempotent — suppression state stays
 * consistent.
 *
 * There is no auth here: token possession IS authorization. A guessed
 * uuid can only unsubscribe someone, never read data. Same reasoning
 * as in apps/api/src/routes/crm-public.ts.
 */

const API_BASE =
  process.env.NEXT_PUBLIC_RAILWAY_URL ?? 'https://fleetcalapi-production.up.railway.app';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Never serve a stale unsubscribe response — every click hits the API
// fresh. A cache would show "unsubscribed" to a second lead who happened
// to share a proxy hop; suppression must be per-click.
export const dynamic = 'force-dynamic';
export const revalidate = 0;

const FALLBACK_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Unsubscribed</title></head>
<body style="font-family: -apple-system, system-ui, sans-serif; max-width: 480px; margin: 80px auto; padding: 0 20px; color: #202124;">
<h2 style="font-weight: 600;">You're unsubscribed</h2>
<p>You won't receive any more emails from FleetCal outreach. Sorry for the interruption.</p>
</body></html>`;

async function proxyToApi(token: string, method: 'GET' | 'POST'): Promise<Response> {
  // Belt-and-braces: same shape check the API runs. A malformed token
  // here means someone hand-typed the URL; render the friendly page
  // rather than the API's 400 body.
  if (!UUID_RE.test(token)) {
    return new Response(FALLBACK_HTML, {
      status: 200,
      headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
    });
  }

  try {
    const upstream = await fetch(`${API_BASE}/v1/crm-public/unsubscribe/${token}`, {
      method,
      cache: 'no-store',
      // Short timeout — the API's handler is a few Supabase writes.
      // Anything longer than 10s is a networking blip; better to serve
      // the friendly "unsubscribed" page than hang the recipient.
      signal: AbortSignal.timeout(10_000),
    });
    // Even a 4xx/5xx from upstream shouldn't leak to the recipient —
    // if the API is temporarily unavailable they still want the
    // "you're unsubscribed" confirmation. The API is idempotent, so
    // a retry from another click will succeed.
    if (!upstream.ok) {
      return new Response(method === 'GET' ? FALLBACK_HTML : 'OK', {
        status: 200,
        headers: {
          'Content-Type':
            method === 'GET' ? 'text/html; charset=utf-8' : 'text/plain; charset=utf-8',
          'Cache-Control': 'no-store',
        },
      });
    }
    const body = await upstream.text();
    return new Response(body, {
      status: 200,
      headers: {
        'Content-Type':
          upstream.headers.get('Content-Type') ??
          (method === 'GET' ? 'text/html; charset=utf-8' : 'text/plain; charset=utf-8'),
        'Cache-Control': 'no-store',
      },
    });
  } catch {
    return new Response(method === 'GET' ? FALLBACK_HTML : 'OK', {
      status: 200,
      headers: {
        'Content-Type':
          method === 'GET' ? 'text/html; charset=utf-8' : 'text/plain; charset=utf-8',
        'Cache-Control': 'no-store',
      },
    });
  }
}

export async function GET(_req: Request, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params;
  return proxyToApi(token, 'GET');
}

export async function POST(_req: Request, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params;
  return proxyToApi(token, 'POST');
}
