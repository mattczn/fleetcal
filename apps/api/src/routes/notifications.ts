/**
 * /v1/notifications — org-scoped notification log.
 *
 * Backs the dispatcher-facing notifications bell in the calendar header.
 * Surfaces every load_notifications row from the last N hours (default
 * 48) across the whole org so dispatchers can see what's pending and
 * verify that scheduled pushes are actually firing.
 *
 * GET /v1/notifications?hours=48&limit=50
 *   - hours: window in hours (1-720, default 48)
 *   - limit: max rows (1-200, default 50)
 *
 * Per-event nudge history lives at /v1/events/:id/notifications and
 * stays unchanged — that one's load-detail-scoped.
 */
import { Hono } from "hono";
import {
  type LoadNotification,
  type LoadNotificationKind,
  type ApiErrorResponse,
} from "@fleetcal/types";

import { supabase } from "../lib/supabase.js";
import type { AuthVariables } from "../middleware/clerk.js";

const notifications = new Hono<{ Variables: AuthVariables }>();

interface NotificationRow {
  id:              string;
  org_id:          string;
  event_id:        string;
  load_id:         string | null;
  driver_id:       number;
  kind:            string;
  sent_at:         string;
  sent_by_name:    string;
  acknowledged_at: string | null;
}

function rowToNotification(r: NotificationRow): LoadNotification {
  return {
    id:             r.id,
    orgId:          r.org_id,
    eventId:        r.event_id,
    loadId:         r.load_id ?? undefined,
    driverId:       r.driver_id,
    kind:           r.kind as LoadNotificationKind,
    sentAt:         r.sent_at,
    sentByName:     r.sent_by_name,
    acknowledgedAt: r.acknowledged_at ?? undefined,
  };
}

notifications.get("/", async (c) => {
  const orgId = c.get("orgId");
  const url = new URL(c.req.url);
  // Window — defaults to 48h, clamped to a sensible range so a stray
  // ?hours=1000000 doesn't pull years of rows.
  const hoursRaw = Number(url.searchParams.get("hours"));
  const hours = Number.isFinite(hoursRaw) ? Math.max(1, Math.min(720, hoursRaw)) : 48;
  const limitRaw = Number(url.searchParams.get("limit"));
  const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(200, limitRaw)) : 50;

  const since = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();

  const { data, error } = await supabase
    .from("load_notifications")
    .select("id,org_id,event_id,load_id,driver_id,kind,sent_at,sent_by_name,acknowledged_at")
    .eq("org_id", orgId)
    .gte("sent_at", since)
    .order("sent_at", { ascending: false })
    .limit(limit);
  if (error) {
    console.error("[GET /v1/notifications] failed:", error);
    return c.json({ error: "fetch_failed", detail: error.message } satisfies ApiErrorResponse, 500);
  }
  const rows = ((data ?? []) as NotificationRow[]).map(rowToNotification);
  return c.json({ notifications: rows });
});

export default notifications;
