/**
 * /v1/customers — broker/customer CRUD (used for auto-matching brokers
 * extracted from rate-cons).
 */

import { Hono } from "hono";
import {
  type Customer,
  type ListCustomersResponse,
  type CreateCustomerRequest,
  type CreateCustomerResponse,
  type UpdateCustomerRequest,
  type UpdateCustomerResponse,
  type ApiErrorResponse,
} from "@fleetcal/types";

import { supabase } from "../lib/supabase.js";
import type { AuthVariables } from "../middleware/clerk.js";

const customers = new Hono<{ Variables: AuthVariables }>();

interface DbCustomerRow {
  id: string;
  name: string;
  short_name: string | null;
  aliases: string[] | null;
  mc_num: string | null;
  contact_name: string | null;
  contact_email: string | null;
  contact_phone: string | null;
  contacts: unknown;
  notes: string | null;
  parse_hints: string | null;
  invoice_method: string | null;
  invoice_email: string | null;
  invoice_portal: string | null;
  invoice_instructions: string | null;
}

import type { CustomerContact } from "@fleetcal/types";

function parseContacts(raw: unknown): CustomerContact[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((x): x is Record<string, unknown> => !!x && typeof x === "object")
    .map((c) => ({
      id:    typeof c.id === "string" ? c.id : crypto.randomUUID(),
      name:  typeof c.name  === "string" ? c.name  : undefined,
      email: typeof c.email === "string" ? c.email : undefined,
      phone: typeof c.phone === "string" ? c.phone : undefined,
    }));
}

function rowToCustomer(r: DbCustomerRow): Customer {
  const method = r.invoice_method === "email" || r.invoice_method === "portal"
    ? r.invoice_method
    : undefined;
  return {
    id:                  r.id,
    name:                r.name,
    shortName:           r.short_name           ?? undefined,
    aliases:             r.aliases              ?? [],
    mcNum:               r.mc_num               ?? undefined,
    contacts:            parseContacts(r.contacts),
    contactName:         r.contact_name         ?? undefined,
    contactEmail:        r.contact_email        ?? undefined,
    contactPhone:        r.contact_phone        ?? undefined,
    notes:               r.notes                ?? undefined,
    parseHints:          r.parse_hints          ?? undefined,
    invoiceMethod:       method,
    invoiceEmail:        r.invoice_email        ?? undefined,
    invoicePortal:       r.invoice_portal       ?? undefined,
    invoiceInstructions: r.invoice_instructions ?? undefined,
  };
}

const COLS = "id,name,short_name,aliases,mc_num,contact_name,contact_email,contact_phone,contacts,notes,parse_hints,invoice_method,invoice_email,invoice_portal,invoice_instructions";

customers.get("/", async (c) => {
  const orgId = c.get("orgId");
  const { data, error } = await supabase
    .from("customers")
    .select(COLS)
    .eq("org_id", orgId)
    .order("name", { ascending: true });
  if (error) {
    console.error("[GET /v1/customers] failed:", error);
    return c.json({ error: "fetch_failed", detail: error.message } satisfies ApiErrorResponse, 500);
  }
  const res: ListCustomersResponse = { customers: ((data ?? []) as DbCustomerRow[]).map(rowToCustomer) };
  return c.json(res);
});

customers.post("/", async (c) => {
  const orgId = c.get("orgId");
  const body = await c.req.json<CreateCustomerRequest>();
  if (!body.name) {
    return c.json({ error: "validation_failed", errors: ["name required"] } satisfies ApiErrorResponse, 400);
  }
  const insert = {
    org_id:        orgId,
    name:          body.name,
    short_name:    body.shortName    ?? null,
    aliases:       body.aliases      ?? [],
    mc_num:        body.mcNum        ?? null,
    contact_name:  body.contactName  ?? null,
    contact_email: body.contactEmail ?? null,
    contact_phone: body.contactPhone ?? null,
    contacts:      body.contacts     ?? [],
    notes:                body.notes               ?? null,
    parse_hints:          body.parseHints          ?? null,
    // Default invoice_method to 'email' when the caller didn't pick
    // one. Most brokers are emailed; portal brokers are the
    // exception and the user can flip them in the broker profile.
    // Caller can still pass null explicitly to opt out.
    invoice_method:       body.invoiceMethod === undefined ? 'email' : body.invoiceMethod,
    invoice_email:        body.invoiceEmail        ?? null,
    invoice_portal:       body.invoicePortal       ?? null,
    invoice_instructions: body.invoiceInstructions ?? null,
  };
  const { data, error } = await supabase
    .from("customers")
    .insert(insert as never)
    .select(COLS)
    .single();
  if (error || !data) {
    console.error("[POST /v1/customers] failed:", error);
    return c.json({ error: "create_failed", detail: error?.message } satisfies ApiErrorResponse, 500);
  }
  const res: CreateCustomerResponse = { customer: rowToCustomer(data as DbCustomerRow) };
  return c.json(res, 201);
});

customers.patch("/:id", async (c) => {
  const orgId = c.get("orgId");
  const id = c.req.param("id");
  const body = await c.req.json<UpdateCustomerRequest>();

  const update: Record<string, unknown> = {};
  if ("name"         in body) update.name          = body.name;
  if ("shortName"    in body) update.short_name    = body.shortName    ?? null;
  if ("aliases"      in body) update.aliases       = body.aliases      ?? [];
  if ("mcNum"        in body) update.mc_num        = body.mcNum        ?? null;
  if ("contactName"  in body) update.contact_name  = body.contactName  ?? null;
  if ("contactEmail" in body) update.contact_email = body.contactEmail ?? null;
  if ("contactPhone" in body) update.contact_phone = body.contactPhone ?? null;
  if ("contacts"     in body) update.contacts      = body.contacts     ?? [];
  if ("notes"               in body) update.notes                = body.notes               ?? null;
  if ("parseHints"          in body) update.parse_hints          = body.parseHints          ?? null;
  if ("invoiceMethod"       in body) update.invoice_method       = body.invoiceMethod       ?? null;
  if ("invoiceEmail"        in body) update.invoice_email        = body.invoiceEmail        ?? null;
  if ("invoicePortal"       in body) update.invoice_portal       = body.invoicePortal       ?? null;
  if ("invoiceInstructions" in body) update.invoice_instructions = body.invoiceInstructions ?? null;
  if (Object.keys(update).length === 0) {
    return c.json({ error: "validation_failed", errors: ["no fields"] } satisfies ApiErrorResponse, 400);
  }

  const { data, error } = await supabase
    .from("customers")
    .update(update as never)
    .eq("id", id)
    .eq("org_id", orgId)
    .select(COLS)
    .single();
  if (error || !data) {
    console.error("[PATCH /v1/customers/:id] failed:", error);
    return c.json({ error: "update_failed", detail: error?.message } satisfies ApiErrorResponse, 500);
  }
  const res: UpdateCustomerResponse = { customer: rowToCustomer(data as DbCustomerRow) };
  return c.json(res);
});

customers.delete("/:id", async (c) => {
  const orgId = c.get("orgId");
  const id = c.req.param("id");
  const { error } = await supabase
    .from("customers")
    .delete()
    .eq("id", id)
    .eq("org_id", orgId);
  if (error) {
    console.error("[DELETE /v1/customers/:id] failed:", error);
    return c.json({ error: "delete_failed", detail: error.message } satisfies ApiErrorResponse, 500);
  }
  return c.body(null, 204);
});

export default customers;
