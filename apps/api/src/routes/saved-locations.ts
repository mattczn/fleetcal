/**
 * /v1/saved-locations — saved address book (autocomplete + dispatch app).
 */

import { Hono } from "hono";
import {
  type SavedLocation,
  type ListSavedLocationsResponse,
  type CreateSavedLocationRequest,
  type CreateSavedLocationResponse,
  type UpdateSavedLocationRequest,
  type UpdateSavedLocationResponse,
  type ApiErrorResponse,
} from "@fleetcal/types";

import { supabase } from "../lib/supabase.js";
import type { AuthVariables } from "../middleware/clerk.js";
import { requireCapability } from "../middleware/require.js";

const savedLocations = new Hono<{ Variables: AuthVariables }>();

interface DbRow {
  id: string;
  name: string;
  address: string | null;
  lat: number | null;
  lng: number | null;
  timezone: string | null;
}

function rowToLocation(r: DbRow): SavedLocation {
  return {
    id:       r.id,
    name:     r.name,
    address:  r.address  ?? undefined,
    lat:      r.lat      ?? undefined,
    lng:      r.lng      ?? undefined,
    timezone: r.timezone ?? undefined,
  };
}

const COLS = "id,name,address,lat,lng,timezone";

savedLocations.get("/", async (c) => {
  const orgId = c.get("orgId");
  const { data, error } = await supabase
    .from("saved_locations")
    .select(COLS)
    .eq("org_id", orgId)
    .order("name", { ascending: true });
  if (error) {
    console.error("[GET /v1/saved-locations] failed:", error);
    return c.json({ error: "fetch_failed", detail: error.message } satisfies ApiErrorResponse, 500);
  }
  const res: ListSavedLocationsResponse = { locations: ((data ?? []) as DbRow[]).map(rowToLocation) };
  return c.json(res);
});

savedLocations.post("/", requireCapability("savedLocations.create"), async (c) => {
  const orgId = c.get("orgId");
  const body = await c.req.json<CreateSavedLocationRequest>();
  if (!body.name) {
    return c.json({ error: "validation_failed", errors: ["name required"] } satisfies ApiErrorResponse, 400);
  }
  const { data, error } = await supabase
    .from("saved_locations")
    .insert({
      org_id:   orgId,
      name:     body.name,
      address:  body.address  ?? null,
      lat:      body.lat      ?? null,
      lng:      body.lng      ?? null,
      timezone: body.timezone ?? null,
    } as never)
    .select(COLS)
    .single();
  if (error || !data) {
    console.error("[POST /v1/saved-locations] failed:", error);
    return c.json({ error: "create_failed", detail: error?.message } satisfies ApiErrorResponse, 500);
  }
  const res: CreateSavedLocationResponse = { location: rowToLocation(data as DbRow) };
  return c.json(res, 201);
});

savedLocations.patch("/:id", requireCapability("savedLocations.edit"), async (c) => {
  const orgId = c.get("orgId");
  const id = c.req.param("id");
  const body = await c.req.json<UpdateSavedLocationRequest>();
  const update: Record<string, unknown> = {};
  if ("name"     in body) update.name     = body.name;
  if ("address"  in body) update.address  = body.address  ?? null;
  if ("lat"      in body) update.lat      = body.lat      ?? null;
  if ("lng"      in body) update.lng      = body.lng      ?? null;
  if ("timezone" in body) update.timezone = body.timezone ?? null;
  if (Object.keys(update).length === 0) {
    return c.json({ error: "validation_failed", errors: ["no fields"] } satisfies ApiErrorResponse, 400);
  }
  const { data, error } = await supabase
    .from("saved_locations")
    .update(update as never)
    .eq("id", id)
    .eq("org_id", orgId)
    .select(COLS)
    .single();
  if (error || !data) {
    console.error("[PATCH /v1/saved-locations/:id] failed:", error);
    return c.json({ error: "update_failed", detail: error?.message } satisfies ApiErrorResponse, 500);
  }
  const res: UpdateSavedLocationResponse = { location: rowToLocation(data as DbRow) };
  return c.json(res);
});

savedLocations.delete("/:id", requireCapability("savedLocations.delete"), async (c) => {
  const orgId = c.get("orgId");
  const id = c.req.param("id");
  const { error } = await supabase
    .from("saved_locations")
    .delete()
    .eq("id", id)
    .eq("org_id", orgId);
  if (error) {
    console.error("[DELETE /v1/saved-locations/:id] failed:", error);
    return c.json({ error: "delete_failed", detail: error.message } satisfies ApiErrorResponse, 500);
  }
  return c.body(null, 204);
});

export default savedLocations;
