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

const drivers = new Hono<{ Variables: AuthVariables }>();

interface DbDriverRow {
  id: number;
  name: string;
  first_name: string | null;
  last_name: string | null;
  phone: string | null;
  notes: string | null;
}

function rowToDriver(r: DbDriverRow): Driver {
  return {
    id:        r.id,
    name:      r.name,
    firstName: r.first_name ?? undefined,
    lastName:  r.last_name  ?? undefined,
    phone:     r.phone      ?? undefined,
    notes:     r.notes      ?? undefined,
  };
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
    .select("id,name,first_name,last_name,phone,notes")
    .eq("org_id", orgId)
    .order("name", { ascending: true });
  if (error) {
    console.error("[GET /v1/drivers] failed:", error);
    return c.json({ error: "fetch_failed", detail: error.message } satisfies ApiErrorResponse, 500);
  }
  const res: ListDriversResponse = { drivers: ((data ?? []) as DbDriverRow[]).map(rowToDriver) };
  return c.json(res);
});

drivers.post("/", async (c) => {
  const orgId = c.get("orgId");
  const body = await c.req.json<CreateDriverRequest>();
  if (!body.name) {
    return c.json({ error: "validation_failed", errors: ["name required"] } satisfies ApiErrorResponse, 400);
  }
  const insert = {
    org_id:     orgId,
    name:       body.name,
    first_name: body.firstName ?? null,
    last_name:  body.lastName  ?? null,
    phone:      normalizePhone(body.phone),
    notes:      body.notes     ?? null,
  };
  const { data, error } = await supabase
    .from("drivers")
    .insert(insert as never)
    .select("id,name,first_name,last_name,phone,notes")
    .single();
  if (error || !data) {
    console.error("[POST /v1/drivers] failed:", error);
    return c.json({ error: "create_failed", detail: error?.message } satisfies ApiErrorResponse, 500);
  }
  const res: CreateDriverResponse = { driver: rowToDriver(data as DbDriverRow) };
  return c.json(res, 201);
});

drivers.patch("/:id", async (c) => {
  const orgId = c.get("orgId");
  const id = Number(c.req.param("id"));
  if (!Number.isFinite(id)) {
    return c.json({ error: "validation_failed", errors: ["id must be numeric"] } satisfies ApiErrorResponse, 400);
  }
  const body = await c.req.json<UpdateDriverRequest>();
  const update: Record<string, unknown> = {};
  if ("name"      in body) update.name       = body.name;
  if ("firstName" in body) update.first_name = body.firstName ?? null;
  if ("lastName"  in body) update.last_name  = body.lastName  ?? null;
  if ("phone"     in body) update.phone      = normalizePhone(body.phone);
  if ("notes"     in body) update.notes      = body.notes     ?? null;
  if (Object.keys(update).length === 0) {
    return c.json({ error: "validation_failed", errors: ["no fields"] } satisfies ApiErrorResponse, 400);
  }

  const { data, error } = await supabase
    .from("drivers")
    .update(update as never)
    .eq("id", id)
    .eq("org_id", orgId)
    .select("id,name,first_name,last_name,phone,notes")
    .single();
  if (error || !data) {
    console.error("[PATCH /v1/drivers/:id] failed:", error);
    return c.json({ error: "update_failed", detail: error?.message } satisfies ApiErrorResponse, 500);
  }
  const res: UpdateDriverResponse = { driver: rowToDriver(data as DbDriverRow) };
  return c.json(res);
});

drivers.delete("/:id", async (c) => {
  const orgId = c.get("orgId");
  const id = Number(c.req.param("id"));
  if (!Number.isFinite(id)) {
    return c.json({ error: "validation_failed", errors: ["id must be numeric"] } satisfies ApiErrorResponse, 400);
  }
  const { error } = await supabase
    .from("drivers")
    .delete()
    .eq("id", id)
    .eq("org_id", orgId);
  if (error) {
    console.error("[DELETE /v1/drivers/:id] failed:", error);
    return c.json({ error: "delete_failed", detail: error.message } satisfies ApiErrorResponse, 500);
  }
  return c.body(null, 204);
});

export default drivers;
