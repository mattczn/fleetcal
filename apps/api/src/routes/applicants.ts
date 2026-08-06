/**
 * /v1/applicants — the hiring pipeline.
 *
 * Gated on the `hiring` module, which is default-off for every org.
 *
 * Hiring is the one interesting operation: it creates the driver record,
 * issues the contractor agreement against it, and hands back a signing link —
 * one action instead of three, because doing them separately is how you end up
 * with a driver who exists but never got sent an agreement.
 */

import { Hono } from "hono";
import { supabase } from "../lib/supabase.js";
import { TEMPLATE_VERSION } from "../lib/contracts/ica.js";
import { sendSms, toE164US, isSmsConfigured } from "../lib/twilio.js";
import type { AuthVariables } from "../middleware/clerk.js";
import { requireModule, requireCapability } from "../middleware/require.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const sb = supabase as any;

const applicants = new Hono<{ Variables: AuthVariables }>();
applicants.use("*", requireModule("hiring"), requireCapability("hiring.access"));

const COLS =
  "id, first_name, last_name, phone, email, address, " +
  "address_line1, address_line2, city, state, postal_code, " +
  "cdl_class, position, start_date, status, source, notes, driver_id, hired_at, created_at";

const BUCKET = "driver-documents";

/** Applicants hold address parts; the driver record and the agreement print
 *  one line. Compose rather than asking anyone to retype it. */
function composeAddress(parts: {
  address_line1?: string | null; address_line2?: string | null;
  city?: string | null; state?: string | null; postal_code?: string | null;
}): string | null {
  const street = [parts.address_line1, parts.address_line2].filter(Boolean).join(" ");
  const region = [parts.city, parts.state].filter(Boolean).join(", ");
  const tail = [region, parts.postal_code].filter(Boolean).join(" ");
  const full = [street, tail].filter(Boolean).join(", ").trim();
  return full || null;
}

const ADDRESS_FIELDS: Record<string, string> = {
  addressLine1: "address_line1",
  addressLine2: "address_line2",
  city: "city",
  state: "state",
  postalCode: "postal_code",
};

function signingBase(): string {
  return process.env.CONTRACT_SIGNING_BASE_URL || "https://curzontrucking.com";
}

// ── GET /v1/applicants ─────────────────────────────────────────────────────
applicants.get("/", async (c) => {
  const orgId = c.get("orgId");

  const { data: rows } = await sb
    .from("driver_applications")
    .select(COLS)
    .eq("org_id", orgId)
    .order("created_at", { ascending: false });

  const list = rows ?? [];

  // Attach contract state so the pipeline can show "sent" vs "signed" without
  // a second round trip per row.
  const driverIds = list.map((a: { driver_id: number | null }) => a.driver_id).filter(Boolean);
  let contractsByDriver = new Map<number, unknown>();

  if (driverIds.length) {
    const { data: contracts } = await sb
      .from("driver_contracts")
      .select("id, driver_id, public_token, status, signed_at, document_path")
      .eq("org_id", orgId)
      .in("driver_id", driverIds)
      .order("sent_at", { ascending: false });

    contractsByDriver = new Map(
      (contracts ?? []).map((row: { driver_id: number }) => [row.driver_id, row])
    );
  }

  return c.json({
    applicants: list.map((a: { driver_id: number | null }) => {
      const contract = a.driver_id ? contractsByDriver.get(a.driver_id) : null;
      return {
        ...a,
        contract: contract
          ? {
              ...(contract as Record<string, unknown>),
              signingUrl: `${signingBase()}/contract/${(contract as { public_token: string }).public_token}`,
            }
          : null,
      };
    }),
  });
});

// ── POST /v1/applicants ────────────────────────────────────────────────────
applicants.post("/", async (c) => {
  const orgId = c.get("orgId");
  const body = await c.req.json().catch(() => ({}));

  const firstName = String(body.firstName ?? "").trim();
  const lastName = String(body.lastName ?? "").trim();
  if (!firstName || !lastName) {
    return c.json({ error: "First and last name are required." }, 400);
  }

  const { data, error } = await sb
    .from("driver_applications")
    .insert({
      org_id: orgId,
      first_name: firstName,
      last_name: lastName,
      phone: String(body.phone ?? "").trim() || null,
      email: String(body.email ?? "").trim() || null,
      address_line1: String(body.addressLine1 ?? "").trim() || null,
      address_line2: String(body.addressLine2 ?? "").trim() || null,
      city: String(body.city ?? "").trim() || null,
      state: String(body.state ?? "").trim().toUpperCase() || null,
      postal_code: String(body.postalCode ?? "").trim() || null,
      address: composeAddress({
        address_line1: body.addressLine1, address_line2: body.addressLine2,
        city: body.city, state: body.state, postal_code: body.postalCode,
      }),
      cdl_class: String(body.cdlClass ?? "").trim() || null,
      position: String(body.position ?? "").trim() || null,
      start_date: body.startDate || null,
      notes: String(body.notes ?? "").trim() || null,
      source: body.source === "website" ? "website" : "manual",
    })
    .select(COLS)
    .single();

  if (error) {
    console.error("[applicants] create failed:", error);
    return c.json({ error: "Could not save that applicant." }, 500);
  }
  return c.json({ applicant: data });
});

// ── PATCH /v1/applicants/:id ───────────────────────────────────────────────
applicants.patch("/:id", async (c) => {
  const orgId = c.get("orgId");
  const body = await c.req.json().catch(() => ({}));

  const patch: Record<string, unknown> = {};
  const map: Record<string, string> = {
    firstName: "first_name", lastName: "last_name", phone: "phone", email: "email",
    cdlClass: "cdl_class", position: "position",
    startDate: "start_date", status: "status", notes: "notes",
    ...ADDRESS_FIELDS,
  };
  for (const [key, column] of Object.entries(map)) {
    if (key in body) {
      let value = body[key] === "" ? null : body[key];
      if (column === "state" && typeof value === "string") value = value.toUpperCase();
      patch[column] = value;
    }
  }
  if (!Object.keys(patch).length) return c.json({ error: "Nothing to update." }, 400);

  // Any address part changing means the composed line is stale.
  if (Object.values(ADDRESS_FIELDS).some((col) => col in patch)) {
    const { data: current } = await sb
      .from("driver_applications")
      .select("address_line1, address_line2, city, state, postal_code")
      .eq("id", c.req.param("id"))
      .eq("org_id", orgId)
      .maybeSingle();
    patch.address = composeAddress({ ...(current ?? {}), ...patch } as never);
  }

  const { data, error } = await sb
    .from("driver_applications")
    .update(patch)
    .eq("id", c.req.param("id"))
    .eq("org_id", orgId)
    .select(COLS)
    .single();

  if (error) {
    console.error("[applicants] update failed:", error);
    return c.json({ error: "Could not update that applicant." }, 500);
  }
  return c.json({ applicant: data });
});

// ── POST /v1/applicants/:id/hire ───────────────────────────────────────────
// Creates the driver, issues the agreement, returns the signing link.
applicants.post("/:id/hire", async (c) => {
  const orgId = c.get("orgId");
  const body = await c.req.json().catch(() => ({}));

  const { data: applicant } = await sb
    .from("driver_applications")
    .select(COLS)
    .eq("id", c.req.param("id"))
    .eq("org_id", orgId)
    .maybeSingle();

  if (!applicant) return c.json({ error: "Applicant not found." }, 404);

  const startDate = body.startDate || applicant.start_date;
  if (!startDate) {
    return c.json(
      { error: "Set a start date first — it becomes the agreement's effective date." },
      400
    );
  }

  const name = `${applicant.first_name} ${applicant.last_name}`.trim();

  // Reuse the driver record if this applicant was already converted, so a
  // double-click doesn't create a second driver.
  let driverId: number | null = applicant.driver_id;

  if (!driverId) {
    const { data: driver, error: driverError } = await sb
      .from("drivers")
      .insert({
        org_id: orgId,
        name,
        first_name: applicant.first_name,
        last_name: applicant.last_name,
        phone: applicant.phone ?? null,
        email: applicant.email ?? null,
        address: applicant.address ?? null,
        active_from: startDate,
      })
      .select("id")
      .single();

    if (driverError) {
      console.error("[applicants] driver create failed:", driverError);
      return c.json({ error: "Could not create the driver record." }, 500);
    }
    driverId = driver.id;
  }

  // One live agreement per driver — reuse an unsigned one rather than issuing
  // a second link that competes with the first.
  const { data: existing } = await sb
    .from("driver_contracts")
    .select("id, public_token, status")
    .eq("org_id", orgId)
    .eq("driver_id", driverId)
    .is("voided_at", null)
    .order("sent_at", { ascending: false })
    .limit(1);

  let contract = existing?.[0] ?? null;

  if (!contract) {
    const { data: created, error: contractError } = await sb
      .from("driver_contracts")
      .insert({
        org_id: orgId,
        driver_id: driverId,
        template_key: "ica",
        template_version: TEMPLATE_VERSION,
        effective_date: startDate,
        contractor_name: name,
        contractor_address: applicant.address ?? null,
      })
      .select("id, public_token, status")
      .single();

    if (contractError) {
      console.error("[applicants] contract create failed:", contractError);
      return c.json({ error: "Driver created, but the agreement could not be issued." }, 500);
    }
    contract = created;
  }

  await sb
    .from("driver_applications")
    .update({ status: "hired", driver_id: driverId, hired_at: new Date().toISOString(), start_date: startDate })
    .eq("id", applicant.id)
    .eq("org_id", orgId);

  return c.json({
    driverId,
    contract,
    signingUrl: `${signingBase()}/contract/${contract.public_token}`,
  });
});

// ── GET /v1/applicants/:id/agreement ───────────────────────────────────────
// A short-lived signed URL for the filed PDF. Minted on demand rather than
// baked into the list response, where it would be stale by the time anyone
// clicked it.
applicants.get("/:id/agreement", async (c) => {
  const orgId = c.get("orgId");

  const { data: applicant } = await sb
    .from("driver_applications")
    .select("driver_id")
    .eq("id", c.req.param("id"))
    .eq("org_id", orgId)
    .maybeSingle();

  if (!applicant?.driver_id) return c.json({ error: "No agreement yet." }, 404);

  const { data: contract } = await sb
    .from("driver_contracts")
    .select("document_path, status, signed_at, signed_name")
    .eq("org_id", orgId)
    .eq("driver_id", applicant.driver_id)
    .is("voided_at", null)
    .order("sent_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!contract?.document_path) {
    return c.json({ error: "That agreement hasn't been signed yet." }, 404);
  }

  const { data: signed, error } = await sb.storage
    .from(BUCKET)
    .createSignedUrl(contract.document_path, 60 * 10);

  if (error || !signed?.signedUrl) {
    console.error("[applicants] signed URL failed:", error);
    return c.json({ error: "Could not open that document." }, 502);
  }

  return c.json({
    url: signed.signedUrl,
    signedAt: contract.signed_at,
    signedName: contract.signed_name,
  });
});

// ── POST /v1/applicants/:id/send-contract ──────────────────────────────────
applicants.post("/:id/send-contract", async (c) => {
  const orgId = c.get("orgId");

  const { data: applicant } = await sb
    .from("driver_applications")
    .select("id, first_name, phone, driver_id")
    .eq("id", c.req.param("id"))
    .eq("org_id", orgId)
    .maybeSingle();

  if (!applicant?.driver_id) {
    return c.json({ error: "Hire this applicant first — there's no agreement to send yet." }, 400);
  }
  if (!isSmsConfigured()) {
    return c.json({ error: "SMS isn't configured. Copy the link and send it yourself." }, 400);
  }

  const to = toE164US(applicant.phone);
  if (!to) return c.json({ error: "This applicant has no valid mobile number." }, 400);

  const { data: contract } = await sb
    .from("driver_contracts")
    .select("public_token, status")
    .eq("org_id", orgId)
    .eq("driver_id", applicant.driver_id)
    .is("voided_at", null)
    .order("sent_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!contract) return c.json({ error: "No agreement has been issued yet." }, 400);

  const url = `${signingBase()}/contract/${contract.public_token}`;
  const result = await sendSms({
    to,
    body:
      `${applicant.first_name}, here's your Curzon Trucking contractor agreement to review and sign: ${url}`,
  });

  if (!result.ok) {
    console.error("[applicants] SMS failed:", result);
    return c.json({ error: "Couldn't send the text. Copy the link and send it yourself." }, 502);
  }

  return c.json({ sent: true, to, signingUrl: url });
});

export default applicants;
