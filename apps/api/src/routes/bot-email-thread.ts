/**
 * /v1/bot/email-thread — Gmail thread ↔ load links for the reconciliation
 * extension. Mounted under botAuth (org from the bot key; no Clerk).
 *
 *   GET    ?account=<email>&threadId=<id>   → { linked, load? }
 *   POST   { account, threadId, loadId, source?, linkedBy? } → { linked, load }
 *   DELETE ?account=<email>&threadId=<id>   → { ok }
 *
 * Thread ids are per-mailbox, so every lookup/write is keyed on
 * (org_id, gmail_account, thread_id) — see the migration.
 */
import { Hono } from "hono";
import { supabase } from "../lib/supabase.js";
import type { AuthVariables } from "../middleware/clerk.js";

const botEmailThread = new Hono<{ Variables: AuthVariables }>();

// email_thread_links isn't in the generated Database types yet — cast for
// queries against it. loads/events stay typed via `supabase`.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const sb = supabase as any;

interface CalendarRef {
  loadId:         string;
  internalLoadId: number | null;
  loadNum:        string | null;
  broker:         string | null;
  eventId:        string | null;   // pickup leg for relays
  start:          string | null;
}

// Resolve a load to the bits the extension needs to render status + build
// the calendar deep link (pickup-leg event for relays). Returns null if the
// load is missing or soft-deleted (a stale link to a removed load).
async function resolveCalendarRef(orgId: string, loadId: string): Promise<CalendarRef | null> {
  const { data: load } = await supabase
    .from("loads")
    .select("id,internal_load_id,load_num,broker,deleted_at")
    .eq("org_id", orgId)
    .eq("id", loadId)
    .maybeSingle();
  const l = load as { id: string; internal_load_id: number | null; load_num: string | null; broker: string | null; deleted_at: string | null } | null;
  if (!l || l.deleted_at) return null;

  const { data: evs } = await supabase
    .from("events")
    .select("id,start,relay_role")
    .eq("org_id", orgId)
    .eq("load_id", loadId)
    .is("deleted_at", null)
    .order("start", { ascending: true });
  const rows = (evs ?? []) as Array<{ id: string; start: string; relay_role: string | null }>;
  const ev = rows.find((e) => e.relay_role === "pickup") ?? rows[0] ?? null;

  return {
    loadId:         l.id,
    internalLoadId: l.internal_load_id,
    loadNum:        l.load_num,
    broker:         l.broker,
    eventId:        ev?.id ?? null,
    start:          ev?.start ?? null,
  };
}

// ── GET — is this thread already linked? ────────────────────────────────
botEmailThread.get("/", async (c) => {
  const orgId = c.get("orgId");
  const account = (c.req.query("account") ?? "").trim().toLowerCase();
  const threadId = (c.req.query("threadId") ?? "").trim();
  if (!account || !threadId) return c.json({ error: "account and threadId required" }, 400);

  const { data: link } = await sb.from("email_thread_links")
    .select("load_id")
    .eq("org_id", orgId)
    .eq("gmail_account", account)
    .eq("thread_id", threadId)
    .maybeSingle();
  const loadId = (link as { load_id: string } | null)?.load_id;
  if (!loadId) return c.json({ linked: false });

  const ref = await resolveCalendarRef(orgId, loadId);
  // Stale link (load deleted) — report unlinked so the extension can re-link.
  if (!ref) return c.json({ linked: false, stale: true });
  return c.json({ linked: true, load: ref });
});

// ── POST — link this thread to a load (upsert) ──────────────────────────
botEmailThread.post("/", async (c) => {
  const orgId = c.get("orgId");
  const body = await c.req.json<{ account?: string; threadId?: string; loadId?: string; source?: string; linkedBy?: string }>();
  const account = (body.account ?? "").trim().toLowerCase();
  const threadId = (body.threadId ?? "").trim();
  const loadId = (body.loadId ?? "").trim();
  if (!account || !threadId || !loadId) return c.json({ error: "account, threadId, loadId required" }, 400);

  // Validate the load belongs to this org before linking.
  const ref = await resolveCalendarRef(orgId, loadId);
  if (!ref) return c.json({ error: "load not found" }, 404);

  const { error } = await sb.from("email_thread_links")
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .upsert(
      {
        org_id:        orgId,
        gmail_account: account,
        thread_id:     threadId,
        load_id:       loadId,
        linked_by:     body.linkedBy ?? account,
        source:        body.source ?? "manual",
        updated_at:    new Date().toISOString(),
      } as any,
      { onConflict: "org_id,gmail_account,thread_id" },
    );
  if (error) {
    console.error("[POST /v1/bot/email-thread] upsert failed:", error);
    return c.json({ error: "link_failed", detail: error.message }, 500);
  }
  return c.json({ linked: true, load: ref });
});

// ── DELETE — unlink ─────────────────────────────────────────────────────
botEmailThread.delete("/", async (c) => {
  const orgId = c.get("orgId");
  const account = (c.req.query("account") ?? "").trim().toLowerCase();
  const threadId = (c.req.query("threadId") ?? "").trim();
  if (!account || !threadId) return c.json({ error: "account and threadId required" }, 400);

  const { error } = await sb.from("email_thread_links")
    .delete()
    .eq("org_id", orgId)
    .eq("gmail_account", account)
    .eq("thread_id", threadId);
  if (error) {
    console.error("[DELETE /v1/bot/email-thread] failed:", error);
    return c.json({ error: "unlink_failed", detail: error.message }, 500);
  }
  return c.json({ ok: true });
});

export default botEmailThread;
