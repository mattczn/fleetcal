/**
 * /v1/drivers — driver CRUD.
 */

import { Hono } from "hono";
import {
  type Driver,
  type ListDriversResponse,
  type CreateDriverRequest,
  type CreateDriverResponse,
  type UpdateDriverRequest,
  type UpdateDriverResponse,
  type ApiErrorResponse,
} from "@fleetcal/types";

import { supabase } from "../lib/supabase.js";
import type { AuthVariables } from "../middleware/clerk.js";
import { requireCapability } from "../middleware/require.js";

const drivers = new Hono<{ Variables: AuthVariables }>();

interface DbDriverRow {
  id: number;
  name: string;
  first_name: string | null;
  last_name: string | null;
  phone: string | null;
  notes: string | null;
  email: string | null;
  address: string | null;
  license_number: string | null;
  license_state: string | null;
  license_exp: string | null;
  medical_card_exp: string | null;
  dob: string | null;
  active_from: string;
  active_to: string | null;
  last_seen_at: string | null;
}

export const DRIVER_COLS =
  "id,name,first_name,last_name,phone,notes," +
  "email,address,license_number,license_state,license_exp,medical_card_exp,dob," +
  "active_from,active_to,last_seen_at";

export function rowToDriver(r: DbDriverRow): Driver {
  return {
    id:             r.id,
    name:           r.name,
    firstName:      r.first_name ?? undefined,
    lastName:       r.last_name  ?? undefined,
    phone:          r.phone      ?? undefined,
    notes:          r.notes      ?? undefined,
    email:          r.email           ?? undefined,
    address:        r.address         ?? undefined,
    licenseNumber:  r.license_number  ?? undefined,
    licenseState:   r.license_state   ?? undefined,
    licenseExp:     r.license_exp     ?? undefined,
    medicalCardExp: r.medical_card_exp?? undefined,
    dob:            r.dob             ?? undefined,
    activeFrom:     r.active_from,
    activeTo:       r.active_to,
    lastSeenAt:     r.last_seen_at ?? null,
  };
}

function todayUtcDateKey(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Match web's normalizePhone: keep '+' and digits, strip everything else. */
function normalizePhone(input: string | null | undefined): string | null {
  if (!input) return null;
  const t = input.trim();
  if (!t) return null;
  return t.replace(/[^\d+]/g, "") || null;
}

drivers.get("/", async (c) => {
  const orgId = c.get("orgId");
  const { data, error } = await supabase
    .from("drivers")
    .select(DRIVER_COLS)
    .eq("org_id", orgId)
    .order("name", { ascending: true });
  if (error) {
    console.error("[GET /v1/drivers] failed:", error);
    return c.json({ error: "fetch_failed", detail: error.message } satisfies ApiErrorResponse, 500);
  }
  const res: ListDriversResponse = { drivers: ((data ?? []) as unknown as DbDriverRow[]).map(rowToDriver) };
  return c.json(res);
});

drivers.post("/", requireCapability("drivers.create"), async (c) => {
  const orgId = c.get("orgId");
  const body = await c.req.json<CreateDriverRequest>();
  if (!body.name) {
    return c.json({ error: "validation_failed", errors: ["name required"] } satisfies ApiErrorResponse, 400);
  }
  const insert = {
    org_id:      orgId,
    name:        body.name,
    first_name:  body.firstName ?? null,
    last_name:   body.lastName  ?? null,
    phone:       normalizePhone(body.phone),
    notes:       body.notes     ?? null,
    active_from: body.activeFrom ?? todayUtcDateKey(),
    active_to:   body.activeTo   ?? null,
  };
  const { data, error } = await supabase
    .from("drivers")
    .insert(insert as never)
    .select(DRIVER_COLS)
    .single();
  if (error || !data) {
    console.error("[POST /v1/drivers] failed:", error);
    return c.json({ error: "create_failed", detail: error?.message } satisfies ApiErrorResponse, 500);
  }
  const res: CreateDriverResponse = { driver: rowToDriver(data as unknown as DbDriverRow) };
  return c.json(res, 201);
});

drivers.patch("/:id", requireCapability("drivers.edit"), async (c) => {
  const orgId = c.get("orgId");
  const id = Number(c.req.param("id"));
  if (!Number.isFinite(id)) {
    return c.json({ error: "validation_failed", errors: ["id must be numeric"] } satisfies ApiErrorResponse, 400);
  }
  const body = await c.req.json<UpdateDriverRequest>();
  const update: Record<string, unknown> = {};
  if ("name"           in body) update.name             = body.name;
  if ("firstName"      in body) update.first_name       = body.firstName ?? null;
  if ("lastName"       in body) update.last_name        = body.lastName  ?? null;
  if ("phone"          in body) update.phone            = normalizePhone(body.phone);
  if ("notes"          in body) update.notes            = body.notes     ?? null;
  if ("email"          in body) update.email            = body.email     ?? null;
  if ("address"        in body) update.address          = body.address   ?? null;
  if ("licenseNumber"  in body) update.license_number   = body.licenseNumber ?? null;
  if ("licenseState"   in body) update.license_state    = body.licenseState ? body.licenseState.toUpperCase() : null;
  if ("licenseExp"     in body) update.license_exp      = body.licenseExp ?? null;
  if ("medicalCardExp" in body) update.medical_card_exp = body.medicalCardExp ?? null;
  if ("dob"            in body) update.dob              = body.dob ?? null;
  if ("activeFrom"     in body) update.active_from      = body.activeFrom;
  if ("activeTo"       in body) update.active_to        = body.activeTo ?? null;
  if (Object.keys(update).length === 0) {
    return c.json({ error: "validation_failed", errors: ["no fields"] } satisfies ApiErrorResponse, 400);
  }

  const { data, error } = await supabase
    .from("drivers")
    .update(update as never)
    .eq("id", id)
    .eq("org_id", orgId)
    .select(DRIVER_COLS)
    .single();
  if (error || !data) {
    console.error("[PATCH /v1/drivers/:id] failed:", error);
    return c.json({ error: "update_failed", detail: error?.message } satisfies ApiErrorResponse, 500);
  }
  const res: UpdateDriverResponse = { driver: rowToDriver(data as unknown as DbDriverRow) };
  return c.json(res);
});

// DELETE now retires the driver (sets active_to = today). Historical
// loads keep their driver_id reference. The events.driver_id FK is
// ON DELETE RESTRICT after the lifecycle migration, so a true hard-
// delete would be blocked while any events reference this driver
// anyway. Idempotent — if already retired, returns current state.
drivers.delete("/:id", requireCapability("drivers.delete"), async (c) => {
  const orgId = c.get("orgId");
  const id = Number(c.req.param("id"));
  if (!Number.isFinite(id)) {
    return c.json({ error: "validation_failed", errors: ["id must be numeric"] } satisfies ApiErrorResponse, 400);
  }
  // Hard delete branch — strict pre-flight on every table that
  // references this driver. The FK on events.driver_id is RESTRICT,
  // but several other related tables (push tokens, notification prefs,
  // load notifications, documents, evening sweeps) are ON DELETE
  // CASCADE — those would silently wipe on a raw delete. Counting up
  // front makes cascade impossible: if anything references, we refuse.
  const hard = c.req.query("hard") === "true";
  if (hard) {
    const blockers = await countDriverBlockers(orgId, id);
    const total = Object.values(blockers).reduce((s, n) => s + n, 0);
    if (total > 0) {
      return c.json(
        {
          error: "has_references",
          detail: "This driver can't be permanently deleted because other records still reference them.",
          blockers,
        },
        409,
      );
    }
    const { error: delErr } = await supabase
      .from("drivers")
      .delete()
      .eq("id", id)
      .eq("org_id", orgId);
    if (delErr) {
      console.error("[DELETE /v1/drivers/:id?hard=true] failed:", delErr);
      return c.json({ error: "delete_failed", detail: delErr.message } satisfies ApiErrorResponse, 500);
    }
    return c.json({ deleted: true, id });
  }

  const today = todayUtcDateKey();
  const { data, error } = await supabase
    .from("drivers")
    .update({ active_to: today } as never)
    .eq("id", id)
    .eq("org_id", orgId)
    .is("active_to", null)
    .select(DRIVER_COLS)
    .maybeSingle();
  if (error) {
    console.error("[DELETE /v1/drivers/:id] retire failed:", error);
    return c.json({ error: "retire_failed", detail: error.message } satisfies ApiErrorResponse, 500);
  }
  if (!data) {
    const { data: existing } = await supabase
      .from("drivers")
      .select(DRIVER_COLS)
      .eq("id", id)
      .eq("org_id", orgId)
      .maybeSingle();
    if (!existing) return c.json({ error: "not_found" } satisfies ApiErrorResponse, 404);
    return c.json({ driver: rowToDriver(existing as unknown as DbDriverRow) });
  }
  return c.json({ driver: rowToDriver(data as unknown as DbDriverRow) });
});

// ─────────────────────────────────────────────────────────────────────────
// Driver documents — ops surface.
//   GET    /v1/drivers/:id/documents          — list
//   POST   /v1/drivers/:id/documents          — upload (multipart)
//   GET    /v1/driver-documents/:docId/url    — fresh signed URL
//   DELETE /v1/driver-documents/:docId        — remove (cascades storage)
// The driver-app surface mirrors these under /v1/driver/documents and
// forces driver_id from the auth context. Both paths read/write the
// same `driver_documents` table.
// ─────────────────────────────────────────────────────────────────────────

const DRIVER_DOC_BUCKET = "driver-documents";
const DRIVER_DOC_KINDS = ['license','medical_card','mvr','other'] as const;
type DriverDocKind = typeof DRIVER_DOC_KINDS[number];

interface DriverDocRow {
  id:           string;
  org_id:       string;
  driver_id:    number;
  kind:         string;
  storage_path: string;
  file_name:    string;
  mime_type:    string | null;
  size_bytes:   number | null;
  expires_on:   string | null;
  notes:        string | null;
  uploaded_at:  string;
  uploaded_by:  string;
}

const DRIVER_DOC_COLS =
  "id,org_id,driver_id,kind,storage_path,file_name,mime_type,size_bytes," +
  "expires_on,notes,uploaded_at,uploaded_by";

function rowToDriverDoc(r: DriverDocRow, signedUrl?: string) {
  return {
    id:         r.id,
    orgId:      r.org_id,
    driverId:   r.driver_id,
    kind:       r.kind as DriverDocKind,
    fileName:   r.file_name,
    mimeType:   r.mime_type ?? undefined,
    sizeBytes:  r.size_bytes ?? undefined,
    expiresOn:  r.expires_on ?? undefined,
    notes:      r.notes ?? undefined,
    uploadedAt: r.uploaded_at,
    uploadedBy: r.uploaded_by,
    signedUrl,
  };
}

async function listDocsForDriver(orgId: string, driverId: number) {
  const { data, error } = await supabase
    .from("driver_documents")
    .select(DRIVER_DOC_COLS)
    .eq("org_id", orgId)
    .eq("driver_id", driverId)
    .order("uploaded_at", { ascending: false });
  if (error) return { error, docs: [] as ReturnType<typeof rowToDriverDoc>[] };

  const rows = (data ?? []) as unknown as DriverDocRow[];
  if (rows.length === 0) return { error: null, docs: [] };

  const paths = rows.map(r => r.storage_path);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: signed } = await supabase.storage.from(DRIVER_DOC_BUCKET).createSignedUrls(paths, 3600);
  const urlByPath = new Map<string, string>();
  for (const s of (signed ?? []) as Array<{ path: string; signedUrl: string }>) {
    urlByPath.set(s.path, s.signedUrl);
  }
  return { error: null, docs: rows.map(r => rowToDriverDoc(r, urlByPath.get(r.storage_path))) };
}

// GET /v1/drivers/:id/documents
drivers.get("/:id/documents", async (c) => {
  const orgId = c.get("orgId");
  const id    = Number(c.req.param("id"));
  if (!Number.isFinite(id)) {
    return c.json({ error: "validation_failed", errors: ["id must be numeric"] } satisfies ApiErrorResponse, 400);
  }
  const { error, docs } = await listDocsForDriver(orgId, id);
  if (error) {
    console.error("[GET /v1/drivers/:id/documents] failed:", error);
    return c.json({ error: "fetch_failed", detail: error.message } satisfies ApiErrorResponse, 500);
  }
  return c.json({ documents: docs });
});

// POST /v1/drivers/:id/documents — multipart upload
drivers.post("/:id/documents", requireCapability("drivers.edit"), async (c) => {
  const orgId  = c.get("orgId");
  const userId = c.get("userId");
  const id     = Number(c.req.param("id"));
  if (!Number.isFinite(id)) {
    return c.json({ error: "validation_failed", errors: ["id must be numeric"] } satisfies ApiErrorResponse, 400);
  }

  let body: { file?: File; kind?: string; expiresOn?: string; notes?: string };
  try { body = await c.req.parseBody() as typeof body; }
  catch { return c.json({ error: "validation_failed", errors: ["multipart parse failed"] } satisfies ApiErrorResponse, 400); }

  const file = body.file;
  if (!file || typeof file === 'string') {
    return c.json({ error: "validation_failed", errors: ["file required"] } satisfies ApiErrorResponse, 400);
  }
  const kind = (body.kind ?? "other").toString() as DriverDocKind;
  if (!(DRIVER_DOC_KINDS as readonly string[]).includes(kind)) {
    return c.json({ error: "validation_failed", errors: [`kind must be one of ${DRIVER_DOC_KINDS.join("|")}`] } satisfies ApiErrorResponse, 400);
  }

  // Confirm the driver belongs to this org.
  const { data: driverRow } = await supabase
    .from("drivers").select("id").eq("id", id).eq("org_id", orgId).maybeSingle();
  if (!driverRow) return c.json({ error: "not_found" } satisfies ApiErrorResponse, 404);

  const ext  = (file.name.split(".").pop() ?? "bin").toLowerCase();
  const rand = Math.random().toString(36).slice(2, 10);
  const storagePath = `${orgId}/${id}/${kind}_${Date.now()}_${rand}.${ext}`;
  const bytes = new Uint8Array(await file.arrayBuffer());

  const { error: upErr } = await supabase.storage
    .from(DRIVER_DOC_BUCKET)
    .upload(storagePath, bytes, {
      contentType: file.type || "application/octet-stream",
      upsert: false,
    });
  if (upErr) {
    console.error("[POST drivers/:id/documents] storage:", upErr);
    return c.json({ error: "upload_failed", detail: upErr.message } satisfies ApiErrorResponse, 500);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await supabase
    .from("driver_documents")
    .insert({
      org_id:       orgId,
      driver_id:    id,
      kind,
      storage_path: storagePath,
      file_name:    file.name,
      mime_type:    file.type || null,
      size_bytes:   bytes.length,
      expires_on:   body.expiresOn?.trim() || null,
      notes:        body.notes?.trim() || null,
      uploaded_by:  userId,
    } as any)
    .select(DRIVER_DOC_COLS)
    .single();
  if (error || !data) {
    void supabase.storage.from(DRIVER_DOC_BUCKET).remove([storagePath]);
    console.error("[POST drivers/:id/documents] insert:", error);
    return c.json({ error: "insert_failed", detail: error?.message } satisfies ApiErrorResponse, 500);
  }
  // Sign once so the client can show it immediately.
  const { data: signed } = await supabase.storage.from(DRIVER_DOC_BUCKET).createSignedUrl(storagePath, 3600);
  const doc = rowToDriverDoc(data as unknown as DriverDocRow, signed?.signedUrl);
  return c.json({ document: doc });
});

export { rowToDriverDoc, listDocsForDriver, DRIVER_DOC_KINDS, DRIVER_DOC_BUCKET, DRIVER_DOC_COLS };
export type { DriverDocRow, DriverDocKind };

/**
 * Count every table that references a driver. Returns { table → count }
 * with only non-zero entries. Used as a pre-flight before hard delete
 * so no cascade ever fires — if anything points at this driver, the
 * delete is refused with a per-table breakdown.
 */
async function countDriverBlockers(orgId: string, driverId: number): Promise<Record<string, number>> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sb = supabase as any;
  const count = async (table: string, col: string, scopeOrg = true) => {
    let q = sb.from(table).select("*", { count: "exact", head: true }).eq(col, driverId);
    if (scopeOrg) q = q.eq("org_id", orgId);
    const { count: n, error } = await q;
    if (error) {
      console.error(`[countDriverBlockers] ${table}.${col}:`, error);
      return 0;
    }
    return n ?? 0;
  };
  // Run in parallel — each is a cheap HEAD count.
  // Note: events.driver_id (primary) AND events.secondary_driver_id
  // both count as a reference. The "secondary" FK is SET NULL on
  // delete, but counting it means a delete that would silently null
  // out a co-driver slot gets refused. Safer.
  const [
    primaryLoads, secondaryLoads, fuel, maintenance,
    pushTokens, notifPrefs, loadNotifs, docs, eveningSweeps,
  ] = await Promise.all([
    count("events",                     "driver_id"),
    count("events",                     "secondary_driver_id"),
    count("fuel_reports",               "driver_id"),
    count("maintenance_reports",        "driver_id"),
    count("driver_push_tokens",         "driver_id"),
    count("driver_notification_prefs",  "driver_id"),
    count("load_notifications",         "driver_id"),
    count("driver_documents",           "driver_id"),
    count("driver_evening_sweeps",      "driver_id"),
  ]);
  const out: Record<string, number> = {};
  const loads = primaryLoads + secondaryLoads;
  if (loads          > 0) out.loads                = loads;
  if (fuel           > 0) out.fuel_reports         = fuel;
  if (maintenance    > 0) out.maintenance_reports  = maintenance;
  if (pushTokens     > 0) out.push_tokens          = pushTokens;
  if (notifPrefs     > 0) out.notification_prefs   = notifPrefs;
  if (loadNotifs     > 0) out.load_notifications   = loadNotifs;
  if (docs           > 0) out.documents            = docs;
  if (eveningSweeps  > 0) out.evening_sweeps       = eveningSweeps;
  return out;
}

export default drivers;
