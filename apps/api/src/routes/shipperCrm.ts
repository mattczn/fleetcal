/**
 * Shipper CRM routes — the carrier's own shipper/receiver/warehouse
 * outreach surface. Distinct from the internal `/v1/crm` sales tooling.
 *
 *   GET   /v1/shipper-crm/facilities              — every facility + stats + outreach
 *   GET   /v1/shipper-crm/facilities/:geoKey      — one facility + loads + activity
 *   PATCH /v1/shipper-crm/facilities/:geoKey      — merge-write outreach state
 *   POST  /v1/shipper-crm/facilities/:geoKey/activities — log a call/email/note
 *
 * Double-gated: the `shipper_crm` module flag (default-OFF, opt-in per org)
 * and the `shipperCrm.access` capability (admin-only by default). No
 * internal-org allowlist — this is a customer feature.
 *
 * Facilities are COMPUTED from stops (facilities_rollup / facility_loads
 * RPCs); only the outreach layer (facilities + facility_activities tables)
 * is stored, created lazily the first time someone acts on a facility.
 */

import { Hono } from "hono";
import {
  FACILITY_STATUSES,
  FACILITY_CALL_OUTCOMES,
  type Database,
  type CreateFacilityContactRequest,
  type Facility,
  type FacilityActivity,
  type FacilityActivityKind,
  type FacilityCallOutcome,
  type FacilityContact,
  type FacilityContactInput,
  type FacilityContactResponse,
  type FacilityDetailResponse,
  type FacilityLoad,
  type FacilityOutreach,
  type FacilityRole,
  type FacilityStats,
  type FacilityStatus,
  type Json,
  type ListFacilitiesResponse,
  type LogFacilityActivityRequest,
  type LogFacilityActivityResponse,
  type UpdateFacilityOutreachRequest,
  type UpdateFacilityOutreachResponse,
} from "@fleetcal/types";
import { supabase } from "../lib/supabase.js";
import { requireCapability, requireModule } from "../middleware/require.js";
import type { AuthVariables } from "../middleware/clerk.js";

const shipperCrm = new Hono<{ Variables: AuthVariables }>();

// Module first (clean "your plan doesn't include this" when off), then the
// admin-only capability.
shipperCrm.use(
  "*",
  requireModule("shipper_crm"),
  requireCapability("shipperCrm.access"),
);

// ── Row types ──────────────────────────────────────────────────────────

type FacilityDbRow        = Database["public"]["Tables"]["facilities"]["Row"];
type FacilityInsert       = Database["public"]["Tables"]["facilities"]["Insert"];
type FacilityUpdate       = Database["public"]["Tables"]["facilities"]["Update"];
type FacilityActivityRow  = Database["public"]["Tables"]["facility_activities"]["Row"];
type FacilityContactRow   = Database["public"]["Tables"]["facility_contacts"]["Row"];
type FacilityContactInsert = Database["public"]["Tables"]["facility_contacts"]["Insert"];
type FacilityContactUpdate = Database["public"]["Tables"]["facility_contacts"]["Update"];

/** One element of the facilities_rollup jsonb array. */
interface RollupRow {
  geoKey: string;
  name: string | null;
  address: string | null;
  city: string | null;
  state: string | null;
  lat: number | null;
  lng: number | null;
  visitCount: number;
  pickupCount: number;
  deliveryCount: number;
  loadCount: number;
  firstSeen: string | null;
  lastSeen: string | null;
  internalGuess: boolean;
}

// ── Mappers ────────────────────────────────────────────────────────────

function roleFromCounts(pickup: number, delivery: number): FacilityRole {
  if (pickup > 0 && delivery > 0) return "both";
  if (pickup > 0) return "shipper";
  if (delivery > 0) return "receiver";
  return "stop";
}

function toOutreach(o: FacilityDbRow): FacilityOutreach {
  return {
    status:          o.status as FacilityStatus,
    nextActionAt:    o.next_action_at ?? undefined,
    ownerUserId:     o.owner_user_id ?? undefined,
    contactName:     o.contact_name ?? undefined,
    contactPhone:    o.contact_phone ?? undefined,
    contactEmail:    o.contact_email ?? undefined,
    notes:           o.notes ?? undefined,
    hidden:          !!o.hidden,
    callAttempts:    o.call_attempts ?? 0,
    lastContactedAt: o.last_contacted_at ?? undefined,
    lastCallOutcome: (o.last_call_outcome as FacilityCallOutcome | null) ?? undefined,
    updatedAt:       o.updated_at ?? undefined,
  };
}

function toFacility(r: RollupRow, o?: FacilityDbRow | null): Facility {
  const stats: FacilityStats = {
    visitCount:    r.visitCount ?? 0,
    pickupCount:   r.pickupCount ?? 0,
    deliveryCount: r.deliveryCount ?? 0,
    loadCount:     r.loadCount ?? 0,
    firstSeen:     r.firstSeen ?? null,
    lastSeen:      r.lastSeen ?? null,
  };
  const f: Facility = {
    geoKey:        r.geoKey,
    name:          r.name ?? undefined,
    address:       r.address ?? undefined,
    city:          r.city ?? undefined,
    state:         r.state ?? undefined,
    lat:           r.lat ?? 0,
    lng:           r.lng ?? 0,
    role:          roleFromCounts(stats.pickupCount, stats.deliveryCount),
    internalGuess: !!r.internalGuess,
    stats,
  };
  if (o) f.outreach = toOutreach(o);
  return f;
}

/** A facility that has an outreach row but has dropped out of the current
 *  lane history (e.g. its loads were deleted) — shown from its snapshot. */
function syntheticRow(o: FacilityDbRow): RollupRow {
  return {
    geoKey: o.geo_key,
    name: o.name, address: o.address, city: o.city, state: o.state,
    lat: o.lat, lng: o.lng,
    visitCount: 0, pickupCount: 0, deliveryCount: 0, loadCount: 0,
    firstSeen: null, lastSeen: null, internalGuess: false,
  };
}

function toActivity(r: FacilityActivityRow): FacilityActivity {
  return {
    id:          r.id,
    facilityId:  r.facility_id,
    kind:        r.kind as FacilityActivityKind,
    body:        r.body ?? undefined,
    outcome:     (r.outcome as FacilityCallOutcome | null) ?? undefined,
    meta:        (r.meta as Record<string, unknown> | null) ?? undefined,
    actorUserId: r.actor_user_id ?? undefined,
    createdAt:   r.created_at,
  };
}

function toContact(r: FacilityContactRow): FacilityContact {
  return {
    id:         r.id,
    facilityId: r.facility_id,
    firstName:  r.first_name ?? undefined,
    lastName:   r.last_name ?? undefined,
    title:      r.title ?? undefined,
    email:      r.email ?? undefined,
    phone:      r.phone ?? undefined,
    createdAt:  r.created_at,
  };
}

/** Contacts for a facility. Defensive: if the facility_contacts table is
 *  not there yet (migration lagging a deploy), return [] rather than 500
 *  the whole detail drawer. */
async function contactsForFacility(orgId: string, facilityId: string): Promise<FacilityContact[]> {
  try {
    const { data, error } = await supabase
      .from("facility_contacts").select("*")
      .eq("org_id", orgId).eq("facility_id", facilityId)
      .order("created_at", { ascending: true });
    if (error) throw error;
    return ((data ?? []) as FacilityContactRow[]).map(toContact);
  } catch (err) {
    console.warn("[shipper-crm] contacts read failed (missing table?):", err);
    return [];
  }
}

// ── Rollup cache ───────────────────────────────────────────────────────
// facilities_rollup scans the org's whole stop history, so a short-lived
// per-org cache keeps the list fast and lets detail/write handlers find a
// facility's stats without re-scanning on every click. Outreach writes
// don't change the rollup (only stored state), so a stale-by-30s rollup is
// fine; a genuinely new load showing up a few seconds late doesn't matter.
// Single API replica (see the scheduler note in index.ts), so one Map is
// the whole picture.
interface RollupEntry { rows: RollupRow[]; byKey: Map<string, RollupRow>; at: number }
const rollupCache = new Map<string, RollupEntry>();
const ROLLUP_TTL_MS = 30_000;

async function getRollup(orgId: string): Promise<RollupEntry> {
  const cached = rollupCache.get(orgId);
  if (cached && Date.now() - cached.at < ROLLUP_TTL_MS) return cached;
  const { data, error } = await supabase.rpc("facilities_rollup", { p_org_id: orgId });
  if (error) throw new Error(`facilities_rollup: ${error.message}`);
  const rows = (Array.isArray(data) ? data : []) as unknown as RollupRow[];
  const byKey = new Map(rows.map((r) => [r.geoKey, r]));
  const entry: RollupEntry = { rows, byKey, at: Date.now() };
  rollupCache.set(orgId, entry);
  return entry;
}

async function outreachByKey(orgId: string): Promise<Map<string, FacilityDbRow>> {
  const { data, error } = await supabase
    .from("facilities").select("*").eq("org_id", orgId);
  if (error) throw new Error(`facilities read: ${error.message}`);
  const m = new Map<string, FacilityDbRow>();
  for (const row of (data ?? []) as FacilityDbRow[]) m.set(row.geo_key, row);
  return m;
}

/** Get the stored outreach row for a facility, creating a `prospect` row
 *  from the client-sent snapshot on first touch. Race-safe via upsert. */
async function ensureFacility(
  orgId: string,
  geoKey: string,
  snap: { name?: string | null; address?: string | null; city?: string | null; state?: string | null; lat: number; lng: number },
  userId: string | undefined,
): Promise<FacilityDbRow> {
  const insert: FacilityInsert = {
    org_id:     orgId,
    geo_key:    geoKey,
    name:       snap.name ?? null,
    address:    snap.address ?? null,
    city:       snap.city ?? null,
    state:      snap.state ?? null,
    lat:        snap.lat ?? null,
    lng:        snap.lng ?? null,
    created_by: userId ?? null,
  };
  // ON CONFLICT DO NOTHING — never clobber an existing row's snapshot/state.
  const { error: upErr } = await supabase
    .from("facilities")
    .upsert(insert, { onConflict: "org_id,geo_key", ignoreDuplicates: true });
  if (upErr) throw new Error(`facilities ensure: ${upErr.message}`);
  const { data, error } = await supabase
    .from("facilities").select("*")
    .eq("org_id", orgId).eq("geo_key", geoKey).single();
  if (error) throw new Error(`facilities reselect: ${error.message}`);
  return data as FacilityDbRow;
}

/** Where a call/email/meeting leaves the pipeline. Never downgrades a won
 *  (`active`) or dead (`do_not_contact`) facility; `interested` /
 *  `not_interested` move it; any other contact at least marks `contacted`. */
function statusAfterContact(
  current: FacilityStatus,
  outcome: FacilityCallOutcome | undefined,
): FacilityStatus {
  if (current === "active" || current === "do_not_contact") return current;
  if (outcome === "interested") return "in_talks";
  if (outcome === "not_interested") return "not_now";
  if (current === "prospect") return "contacted";
  return current;
}

async function buildFacilityResponse(
  orgId: string, geoKey: string, row: FacilityDbRow,
): Promise<Facility> {
  const { byKey } = await getRollup(orgId);
  const r = byKey.get(geoKey) ?? syntheticRow(row);
  return toFacility(r, row);
}

// ── Routes ─────────────────────────────────────────────────────────────

shipperCrm.get("/facilities", async (c) => {
  const orgId = c.get("orgId");
  try {
    const [{ rows }, outreach] = await Promise.all([
      getRollup(orgId),
      outreachByKey(orgId),
    ]);
    const facilities = rows.map((r) => toFacility(r, outreach.get(r.geoKey)));
    const summary: ListFacilitiesResponse["summary"] = {
      facilityCount:     facilities.length,
      visitCount:        facilities.reduce((s, f) => s + f.stats.visitCount, 0),
      pickupFacilities:  facilities.filter((f) => f.role === "shipper" || f.role === "both").length,
      deliveryFacilities: facilities.filter((f) => f.role === "receiver" || f.role === "both").length,
    };
    return c.json({ facilities, summary } satisfies ListFacilitiesResponse);
  } catch (err) {
    console.error("[shipper-crm] list failed:", err);
    return c.json({ error: "internal", reason: err instanceof Error ? err.message : String(err) }, 500);
  }
});

shipperCrm.get("/facilities/:geoKey", async (c) => {
  const orgId  = c.get("orgId");
  const geoKey = c.req.param("geoKey");
  if (!geoKey) return c.json({ error: "bad_request", reason: "missing geoKey" }, 400);
  try {
    const { byKey } = await getRollup(orgId);
    const { data: oRow } = await supabase
      .from("facilities").select("*")
      .eq("org_id", orgId).eq("geo_key", geoKey).maybeSingle();
    const outreach = (oRow as FacilityDbRow | null) ?? null;

    const rollupRow = byKey.get(geoKey) ?? (outreach ? syntheticRow(outreach) : null);
    if (!rollupRow) return c.json({ error: "not_found" }, 404);

    const [loadsRes, actsRes, contacts] = await Promise.all([
      supabase.rpc("facility_loads", { p_org_id: orgId, p_geo_key: geoKey }),
      outreach
        ? supabase.from("facility_activities").select("*")
            .eq("org_id", orgId).eq("facility_id", outreach.id)
            .order("created_at", { ascending: false })
        : Promise.resolve({ data: [] as FacilityActivityRow[], error: null }),
      outreach ? contactsForFacility(orgId, outreach.id) : Promise.resolve([] as FacilityContact[]),
    ]);
    if (loadsRes.error) throw new Error(`facility_loads: ${loadsRes.error.message}`);

    const loads = (Array.isArray(loadsRes.data) ? loadsRes.data : []) as unknown as FacilityLoad[];
    const activities = ((actsRes.data ?? []) as FacilityActivityRow[]).map(toActivity);

    return c.json({
      facility: toFacility(rollupRow, outreach),
      loads,
      activities,
      contacts,
    } satisfies FacilityDetailResponse);
  } catch (err) {
    console.error("[shipper-crm] detail failed:", err);
    return c.json({ error: "internal", reason: err instanceof Error ? err.message : String(err) }, 500);
  }
});

shipperCrm.patch("/facilities/:geoKey", async (c) => {
  const orgId  = c.get("orgId");
  const userId = c.get("userId");
  const geoKey = c.req.param("geoKey");
  if (!geoKey) return c.json({ error: "bad_request", reason: "missing geoKey" }, 400);

  const body = await c.req.json<UpdateFacilityOutreachRequest>().catch(() => null);
  if (!body || !body.snapshot) {
    return c.json({ error: "bad_request", reason: "missing snapshot" }, 400);
  }
  if (body.status !== undefined && !FACILITY_STATUSES.includes(body.status)) {
    return c.json({ error: "bad_request", reason: "invalid status" }, 400);
  }

  try {
    const row = await ensureFacility(orgId, geoKey, body.snapshot, userId);

    const patch: FacilityUpdate = {};
    if (body.status !== undefined)        patch.status         = body.status;
    if ("nextActionAt" in body)           patch.next_action_at = body.nextActionAt ?? null;
    if ("ownerUserId"  in body)           patch.owner_user_id  = body.ownerUserId ?? null;
    if ("contactName"  in body)           patch.contact_name   = body.contactName ?? null;
    if ("contactPhone" in body)           patch.contact_phone  = body.contactPhone ?? null;
    if ("contactEmail" in body)           patch.contact_email  = body.contactEmail ?? null;
    if ("notes"        in body)           patch.notes          = body.notes ?? null;
    if (body.hidden !== undefined)        patch.hidden         = body.hidden;

    let updated = row;
    if (Object.keys(patch).length > 0) {
      const { data, error } = await supabase
        .from("facilities").update(patch)
        .eq("org_id", orgId).eq("geo_key", geoKey).select("*").single();
      if (error) throw new Error(`facilities update: ${error.message}`);
      updated = data as FacilityDbRow;
    }

    if (body.status !== undefined && body.status !== row.status) {
      await supabase.from("facility_activities").insert({
        org_id: orgId, facility_id: row.id, kind: "status_change",
        meta: { from: row.status, to: body.status } as Json,
        actor_user_id: userId ?? null,
      });
    }

    const facility = await buildFacilityResponse(orgId, geoKey, updated);
    return c.json({ facility } satisfies UpdateFacilityOutreachResponse);
  } catch (err) {
    console.error("[shipper-crm] patch failed:", err);
    return c.json({ error: "internal", reason: err instanceof Error ? err.message : String(err) }, 500);
  }
});

shipperCrm.post("/facilities/:geoKey/activities", async (c) => {
  const orgId  = c.get("orgId");
  const userId = c.get("userId");
  const geoKey = c.req.param("geoKey");
  if (!geoKey) return c.json({ error: "bad_request", reason: "missing geoKey" }, 400);

  const body = await c.req.json<LogFacilityActivityRequest>().catch(() => null);
  if (!body || !body.snapshot || !body.kind) {
    return c.json({ error: "bad_request", reason: "missing kind/snapshot" }, 400);
  }
  const KINDS: FacilityActivityKind[] = ["note", "status_change", "call", "email", "meeting", "system"];
  if (!KINDS.includes(body.kind)) {
    return c.json({ error: "bad_request", reason: "invalid kind" }, 400);
  }
  if (body.outcome !== undefined && !FACILITY_CALL_OUTCOMES.includes(body.outcome)) {
    return c.json({ error: "bad_request", reason: "invalid outcome" }, 400);
  }

  try {
    const row = await ensureFacility(orgId, geoKey, body.snapshot, userId);

    const { data: act, error: actErr } = await supabase
      .from("facility_activities").insert({
        org_id: orgId, facility_id: row.id, kind: body.kind,
        body: body.body ?? null, outcome: body.outcome ?? null,
        actor_user_id: userId ?? null,
      }).select("*").single();
    if (actErr) throw new Error(`activity insert: ${actErr.message}`);

    // Side effects: contact kinds bump the contact timeline + nudge status.
    const patch: FacilityUpdate = {};
    if (body.kind === "call" || body.kind === "email" || body.kind === "meeting") {
      patch.last_contacted_at = new Date().toISOString();
      if (body.kind === "call") {
        patch.call_attempts = (row.call_attempts ?? 0) + 1;
        if (body.outcome) patch.last_call_outcome = body.outcome;
      }
      const next = statusAfterContact(row.status as FacilityStatus, body.outcome);
      if (next !== row.status) patch.status = next;
    }

    let updated = row;
    if (Object.keys(patch).length > 0) {
      const { data, error } = await supabase
        .from("facilities").update(patch)
        .eq("org_id", orgId).eq("geo_key", geoKey).select("*").single();
      if (error) throw new Error(`facilities update: ${error.message}`);
      updated = data as FacilityDbRow;
      if (patch.status && patch.status !== row.status) {
        await supabase.from("facility_activities").insert({
          org_id: orgId, facility_id: row.id, kind: "status_change",
          meta: { from: row.status, to: patch.status, auto: true } as Json,
          actor_user_id: userId ?? null,
        });
      }
    }

    const facility = await buildFacilityResponse(orgId, geoKey, updated);
    return c.json({
      activity: toActivity(act as FacilityActivityRow),
      facility,
    } satisfies LogFacilityActivityResponse);
  } catch (err) {
    console.error("[shipper-crm] activity failed:", err);
    return c.json({ error: "internal", reason: err instanceof Error ? err.message : String(err) }, 500);
  }
});

// ── Contacts (multiple per facility) ───────────────────────────────────

shipperCrm.post("/facilities/:geoKey/contacts", async (c) => {
  const orgId  = c.get("orgId");
  const userId = c.get("userId");
  const geoKey = c.req.param("geoKey");
  if (!geoKey) return c.json({ error: "bad_request", reason: "missing geoKey" }, 400);

  const body = await c.req.json<CreateFacilityContactRequest>().catch(() => null);
  if (!body || !body.snapshot) {
    return c.json({ error: "bad_request", reason: "missing snapshot" }, 400);
  }
  try {
    const row = await ensureFacility(orgId, geoKey, body.snapshot, userId);
    const insert: FacilityContactInsert = {
      org_id:     orgId,
      facility_id: row.id,
      first_name: body.firstName?.trim() || null,
      last_name:  body.lastName?.trim() || null,
      title:      body.title?.trim() || null,
      email:      body.email?.trim() || null,
      phone:      body.phone?.trim() || null,
      created_by: userId ?? null,
    };
    const { data, error } = await supabase
      .from("facility_contacts").insert(insert).select("*").single();
    if (error) throw new Error(`contact insert: ${error.message}`);
    return c.json({ contact: toContact(data as FacilityContactRow) } satisfies FacilityContactResponse);
  } catch (err) {
    console.error("[shipper-crm] contact create failed:", err);
    return c.json({ error: "internal", reason: err instanceof Error ? err.message : String(err) }, 500);
  }
});

shipperCrm.patch("/facilities/:geoKey/contacts/:contactId", async (c) => {
  const orgId     = c.get("orgId");
  const contactId = c.req.param("contactId");
  if (!contactId) return c.json({ error: "bad_request", reason: "missing contactId" }, 400);

  const body = await c.req.json<FacilityContactInput>().catch(() => null);
  if (!body) return c.json({ error: "bad_request", reason: "invalid body" }, 400);

  const patch: FacilityContactUpdate = {};
  if ("firstName" in body) patch.first_name = body.firstName?.trim() || null;
  if ("lastName"  in body) patch.last_name  = body.lastName?.trim() || null;
  if ("title"     in body) patch.title      = body.title?.trim() || null;
  if ("email"     in body) patch.email      = body.email?.trim() || null;
  if ("phone"     in body) patch.phone      = body.phone?.trim() || null;

  try {
    const { data, error } = await supabase
      .from("facility_contacts").update(patch)
      .eq("org_id", orgId).eq("id", contactId).select("*").single();
    if (error) throw new Error(`contact update: ${error.message}`);
    return c.json({ contact: toContact(data as FacilityContactRow) } satisfies FacilityContactResponse);
  } catch (err) {
    console.error("[shipper-crm] contact update failed:", err);
    return c.json({ error: "internal", reason: err instanceof Error ? err.message : String(err) }, 500);
  }
});

shipperCrm.delete("/facilities/:geoKey/contacts/:contactId", async (c) => {
  const orgId     = c.get("orgId");
  const contactId = c.req.param("contactId");
  if (!contactId) return c.json({ error: "bad_request", reason: "missing contactId" }, 400);
  try {
    const { error } = await supabase
      .from("facility_contacts").delete()
      .eq("org_id", orgId).eq("id", contactId);
    if (error) throw new Error(`contact delete: ${error.message}`);
    return c.json({ ok: true });
  } catch (err) {
    console.error("[shipper-crm] contact delete failed:", err);
    return c.json({ error: "internal", reason: err instanceof Error ? err.message : String(err) }, 500);
  }
});

export { shipperCrm as shipperCrmRoute };
