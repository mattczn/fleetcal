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
import { convertIfHeicAtUpload } from "../lib/heicToJpeg.js";
import type { AuthVariables } from "../middleware/clerk.js";
import { requireModule, requireCapability } from "../middleware/require.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const sb = supabase as any;

const applicants = new Hono<{ Variables: AuthVariables }>();
applicants.use("*", requireModule("hiring"), requireCapability("hiring.access"));

const COLS =
  "id, first_name, last_name, phone, email, address, " +
  "address_line1, address_line2, city, state, postal_code, " +
  "cdl_class, license_number, license_state, dob, experience, " +
  "position, start_date, status, source, notes, driver_id, hired_at, created_at, " +
  "consent_signature, consent_signed_at, consent_ip, consent_records, consent_employers, certified";

const BUCKET = "driver-documents";

const DOC_COLS =
  "id, kind, storage_path, file_name, mime_type, size_bytes, notes, uploaded_at, uploaded_by, driver_id";

/** Ops can add any of the four existing kinds. The MVR is the one that
 *  matters here — it's ordered off the applicant's signed authorization and
 *  has nowhere else to live until they're hired. */
const DOC_KINDS = new Set(["license", "medical_card", "mvr", "other"]);

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

  // Document counts, so the table can say "CDL + medical card on file, no
  // MVR yet" without a request per row.
  const docCounts = new Map<string, { total: number; kinds: string[] }>();
  if (list.length) {
    const { data: docs } = await sb
      .from("driver_documents")
      .select("application_id, kind")
      .eq("org_id", orgId)
      .in("application_id", list.map((a: { id: string }) => a.id));

    for (const doc of (docs ?? []) as Array<{ application_id: string; kind: string }>) {
      const entry = docCounts.get(doc.application_id) ?? { total: 0, kinds: [] };
      entry.total += 1;
      if (!entry.kinds.includes(doc.kind)) entry.kinds.push(doc.kind);
      docCounts.set(doc.application_id, entry);
    }
  }

  return c.json({
    applicants: list.map((a: { id: string; driver_id: number | null }) => {
      const contract = a.driver_id ? contractsByDriver.get(a.driver_id) : null;
      const docs = docCounts.get(a.id) ?? { total: 0, kinds: [] };
      return {
        ...a,
        documentCount: docs.total,
        documentKinds: docs.kinds,
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
    licenseNumber: "license_number", licenseState: "license_state",
    dob: "dob", experience: "experience",
    startDate: "start_date", status: "status", notes: "notes",
    ...ADDRESS_FIELDS,
  };
  for (const [key, column] of Object.entries(map)) {
    if (key in body) {
      let value = body[key] === "" ? null : body[key];
      if ((column === "state" || column === "license_state") && typeof value === "string") {
        value = value.toUpperCase();
      }
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

  // Hand the documents over. The CDL photos and MVR gathered during hiring
  // are the same documents the driver profile wants, so they're re-pointed
  // rather than copied — one object in storage, one row, visible from both
  // sides. Rows keep their application_id, so the hiring page still shows
  // what was collected before the hire.
  const { error: handoffError } = await sb
    .from("driver_documents")
    .update({ driver_id: driverId })
    .eq("org_id", orgId)
    .eq("application_id", applicant.id)
    .is("driver_id", null);

  if (handoffError) {
    // Not fatal: the driver and the agreement both exist, and the documents
    // are still reachable from the applicant.
    console.error("[applicants] document handoff failed:", handoffError);
  }

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

// ── Applicant documents ────────────────────────────────────────────────────
//   GET    /v1/applicants/:id/documents  — list, with signed URLs
//   POST   /v1/applicants/:id/documents  — upload (multipart): the MVR, or
//                                          anything the website didn't collect
//   DELETE /v1/applicants/:id/documents/:docId
//
// These are the same `driver_documents` rows the driver profile uses. An
// applicant's documents carry `driver_id = null` until they're hired, which
// is what keeps someone still being screened out of the driver surfaces.

async function requireApplicant(orgId: string, id: string) {
  const { data } = await sb
    .from("driver_applications")
    .select("id, driver_id")
    .eq("id", id)
    .eq("org_id", orgId)
    .maybeSingle();
  return data as { id: string; driver_id: number | null } | null;
}

applicants.get("/:id/documents", async (c) => {
  const orgId = c.get("orgId");
  const applicant = await requireApplicant(orgId, c.req.param("id"));
  if (!applicant) return c.json({ error: "Applicant not found." }, 404);

  const { data: rows, error } = await sb
    .from("driver_documents")
    .select(DOC_COLS)
    .eq("org_id", orgId)
    .eq("application_id", applicant.id)
    .order("uploaded_at", { ascending: false });

  if (error) {
    console.error("[applicants] document list failed:", error);
    return c.json({ error: "Could not load documents." }, 500);
  }

  const list = (rows ?? []) as Array<Record<string, unknown> & { storage_path: string }>;
  const urlByPath = new Map<string, string>();

  if (list.length) {
    const { data: signed } = await sb.storage
      .from(BUCKET)
      .createSignedUrls(list.map((r) => r.storage_path), 60 * 60);
    for (const s of (signed ?? []) as Array<{ path: string; signedUrl: string }>) {
      urlByPath.set(s.path, s.signedUrl);
    }
  }

  return c.json({
    documents: list.map((r) => ({
      id: r.id,
      kind: r.kind,
      fileName: r.file_name,
      mimeType: r.mime_type,
      sizeBytes: r.size_bytes,
      notes: r.notes,
      uploadedAt: r.uploaded_at,
      uploadedBy: r.uploaded_by,
      onDriver: r.driver_id != null,
      url: urlByPath.get(r.storage_path) ?? null,
    })),
  });
});

applicants.post("/:id/documents", async (c) => {
  const orgId = c.get("orgId");
  const userId = c.get("userId");
  const applicant = await requireApplicant(orgId, c.req.param("id"));
  if (!applicant) return c.json({ error: "Applicant not found." }, 404);

  let form: FormData;
  try {
    form = await c.req.formData();
  } catch {
    return c.json({ error: "Could not read that upload." }, 400);
  }

  const file = form.get("file");
  if (!file || typeof file === "string" || file.size === 0) {
    return c.json({ error: "Choose a file to upload." }, 400);
  }

  const kind = (form.get("kind")?.toString() || "other").trim();
  if (!DOC_KINDS.has(kind)) return c.json({ error: "Unknown document type." }, 400);

  let bytes = new Uint8Array(await file.arrayBuffer());
  let mime = file.type || "application/octet-stream";
  let name = file.name || `${kind}.bin`;

  const converted = await convertIfHeicAtUpload(file, bytes, "[applicants documents]");
  if ("failed" in converted) {
    return c.json({ error: "That photo couldn't be read. Try a JPEG or PDF." }, 415);
  }
  bytes = converted.bytes;
  mime = converted.mime || mime;
  name = converted.name;

  const ext = (name.split(".").pop() ?? "bin").toLowerCase();
  const rand = Math.random().toString(36).slice(2, 10);
  const path = `${orgId}/applications/${applicant.id}/${kind}_${Date.now()}_${rand}.${ext}`;

  const { error: uploadError } = await sb.storage
    .from(BUCKET)
    .upload(path, bytes, { contentType: mime, upsert: false });
  if (uploadError) {
    console.error("[applicants] document upload failed:", uploadError);
    return c.json({ error: "Could not store that file." }, 502);
  }

  const { data, error } = await sb
    .from("driver_documents")
    .insert({
      org_id: orgId,
      // Already hired? Then it belongs to the driver too, immediately —
      // otherwise an MVR added after the hire would be stranded on the
      // applicant and invisible on the driver profile.
      driver_id: applicant.driver_id,
      application_id: applicant.id,
      kind,
      storage_path: path,
      file_name: name,
      mime_type: mime,
      size_bytes: bytes.length,
      notes: form.get("notes")?.toString().trim() || null,
      uploaded_by: userId,
    })
    .select(DOC_COLS)
    .single();

  if (error || !data) {
    void sb.storage.from(BUCKET).remove([path]);
    console.error("[applicants] document insert failed:", error);
    return c.json({ error: "Could not save that document." }, 500);
  }

  const { data: signed } = await sb.storage.from(BUCKET).createSignedUrl(path, 60 * 60);

  return c.json({
    document: {
      id: data.id,
      kind: data.kind,
      fileName: data.file_name,
      mimeType: data.mime_type,
      sizeBytes: data.size_bytes,
      notes: data.notes,
      uploadedAt: data.uploaded_at,
      uploadedBy: data.uploaded_by,
      onDriver: data.driver_id != null,
      url: signed?.signedUrl ?? null,
    },
  });
});

applicants.delete("/:id/documents/:docId", async (c) => {
  const orgId = c.get("orgId");

  // Scoped by application_id as well as id: a doc id from another applicant
  // must not delete through this path.
  const { data: doc } = await sb
    .from("driver_documents")
    .select("id, storage_path")
    .eq("id", c.req.param("docId"))
    .eq("org_id", orgId)
    .eq("application_id", c.req.param("id"))
    .maybeSingle();

  if (!doc) return c.json({ error: "Document not found." }, 404);

  const { error } = await sb.from("driver_documents").delete().eq("id", doc.id);
  if (error) {
    console.error("[applicants] document delete failed:", error);
    return c.json({ error: "Could not delete that document." }, 500);
  }
  void sb.storage.from(BUCKET).remove([doc.storage_path]);

  return c.json({ ok: true });
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
