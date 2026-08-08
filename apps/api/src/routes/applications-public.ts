/**
 * /v1/public/applications — intake from a carrier's public website.
 *
 * curzontrucking.com/drivers/apply POSTs the finished application here:
 * contact details, work history, the signed MVR/background authorization,
 * and the photos of the CDL and medical card. It lands as an applicant row
 * plus documents, so the hiring pipeline starts populated instead of someone
 * retyping an email into it.
 *
 * SECURITY NOTES — read before editing.
 *
 * 1. This is an unauthenticated origin posting personal data (DOB, license
 *    number). A shared secret gates it: APPLICATION_INTAKE_KEY, sent as
 *    x-application-key. Without the key set the endpoint refuses everything
 *    rather than defaulting open.
 *
 * 2. The org is derived from the key, never from the request body. A
 *    body-supplied org_id here would let anyone holding one carrier's key
 *    file applicants into another's pipeline. Which carrier the key feeds
 *    falls back to CURZON_ORG_ID — this deployment's single-carrier pin —
 *    with APPLICATION_INTAKE_ORG_ID available to override it if the two
 *    ever need to differ.
 *
 * 3. Nothing is read back out. This endpoint only writes — there is no GET,
 *    no echo of the stored row, no applicant lookup. A leaked key is then a
 *    spam problem, not a disclosure one.
 *
 * 4. `hiring` must be enabled for the target org. Turning the module off
 *    stops intake too, rather than quietly accumulating rows in a table
 *    nobody can see.
 */

import { Hono } from "hono";
import { supabase } from "../lib/supabase.js";
import { isModuleEnabled } from "@fleetcal/types";
import { env } from "../lib/env.js";
import { convertIfHeicAtUpload } from "../lib/heicToJpeg.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const sb = supabase as any;

const applicationsPublic = new Hono();

const BUCKET = "driver-documents";

/** Form field → (document kind, what it is). Front and back are both
 *  `license`; see the migration note on why the kind list isn't growing. */
const DOCUMENT_FIELDS: Record<string, { kind: string; label: string }> = {
  licenseFront: { kind: "license", label: "CDL — front" },
  licenseBack: { kind: "license", label: "CDL — back" },
  medicalCard: { kind: "medical_card", label: "Medical card" },
};

const MAX_FILE_BYTES = 12 * 1024 * 1024;

const ACCEPTED_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/heic",
  "image/heif",
  "application/pdf",
]);

function intakeOrg(key: string | undefined): string | null {
  const expected = process.env.APPLICATION_INTAKE_KEY;
  const orgId = process.env.APPLICATION_INTAKE_ORG_ID || env.curzonOrgId;
  if (!expected || !orgId) return null; // not configured = closed
  if (!key || key !== expected) return null;
  return orgId;
}

function str(form: FormData, field: string): string {
  const value = form.get(field);
  return typeof value === "string" ? value.trim() : "";
}

function composeAddress(parts: {
  line1: string; line2: string; city: string; state: string; postal: string;
}): string | null {
  const street = [parts.line1, parts.line2].filter(Boolean).join(" ");
  const region = [parts.city, parts.state].filter(Boolean).join(", ");
  const tail = [region, parts.postal].filter(Boolean).join(" ");
  return [street, tail].filter(Boolean).join(", ").trim() || null;
}

// ── POST /v1/public/applications ───────────────────────────────────────────
applicationsPublic.post("/", async (c) => {
  const orgId = intakeOrg(c.req.header("x-application-key"));
  if (!orgId) return c.json({ error: "Not found" }, 404);

  const { data: settings } = await sb
    .from("org_settings")
    .select("modules")
    .eq("org_id", orgId)
    .maybeSingle();
  if (!isModuleEnabled("hiring", settings?.modules)) {
    return c.json({ error: "Not found" }, 404);
  }

  let form: FormData;
  try {
    form = await c.req.formData();
  } catch {
    return c.json({ error: "Could not read that submission." }, 400);
  }

  const firstName = str(form, "firstName");
  const lastName = str(form, "lastName");
  if (!firstName || !lastName) {
    return c.json({ error: "First and last name are required." }, 400);
  }

  const signature = str(form, "signature");
  const signedOn = str(form, "signedOn");

  const address = composeAddress({
    line1: str(form, "addressLine1"),
    line2: str(form, "addressLine2"),
    city: str(form, "city"),
    state: str(form, "state").toUpperCase(),
    postal: str(form, "postalCode"),
  });

  const { data: applicant, error } = await sb
    .from("driver_applications")
    .insert({
      org_id: orgId,
      first_name: firstName,
      last_name: lastName,
      phone: str(form, "phone") || null,
      email: str(form, "email") || null,
      address_line1: str(form, "addressLine1") || null,
      address_line2: str(form, "addressLine2") || null,
      city: str(form, "city") || null,
      state: str(form, "state").toUpperCase() || null,
      postal_code: str(form, "postalCode") || null,
      address,
      cdl_class: str(form, "cdlClass") || null,
      license_number: str(form, "licenseNumber") || null,
      license_state: str(form, "licenseState").toUpperCase() || null,
      dob: str(form, "dob") || null,
      position: str(form, "position") || null,
      start_date: str(form, "startDate") || null,
      experience: str(form, "experience") || null,
      status: "new",
      source: "website",
      // The authorization is only recorded when it was actually given — a
      // half-filled consent is no consent, and this column is what someone
      // relies on when they order the report.
      consent_signature: signature || null,
      consent_signed_at: signature ? new Date().toISOString() : null,
      consent_ip:
        c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ||
        c.req.header("x-real-ip") ||
        null,
      consent_user_agent: form.get("userAgent")?.toString().slice(0, 500) || null,
      consent_records: str(form, "consentReports") === "true",
      consent_employers: str(form, "consentEmployers") === "true",
      certified: str(form, "certify") === "true",
      notes: signedOn ? `Authorization signed ${signedOn}.` : null,
    })
    .select("id")
    .single();

  if (error || !applicant) {
    console.error("[applications-public] insert failed:", error);
    return c.json({ error: "Could not file that application." }, 500);
  }

  // ── Documents ────────────────────────────────────────────────────────────
  // A failed upload must not fail the application. The row is already
  // filed; a missing photo is something dispatch can ask for, whereas a
  // rejected submission is an applicant who walks away.
  const stored: string[] = [];
  const failed: string[] = [];

  for (const [field, { kind, label }] of Object.entries(DOCUMENT_FIELDS)) {
    const file = form.get(field);
    if (!file || typeof file === "string" || file.size === 0) continue;

    if (!ACCEPTED_TYPES.has(file.type) || file.size > MAX_FILE_BYTES) {
      failed.push(label);
      continue;
    }

    try {
      let bytes = new Uint8Array(await file.arrayBuffer());
      let mime = file.type || "application/octet-stream";
      let name = file.name || `${field}.jpg`;

      // Phone cameras hand us HEIC; convert at the boundary so every
      // downstream viewer can render it. Same playbook as the ops uploader.
      const converted = await convertIfHeicAtUpload(file, bytes, "[applications-public]");
      if (!("failed" in converted)) {
        bytes = converted.bytes;
        mime = converted.mime || mime;
        name = converted.name;
      }

      const ext = (name.split(".").pop() ?? "bin").toLowerCase();
      const rand = Math.random().toString(36).slice(2, 10);
      const path = `${orgId}/applications/${applicant.id}/${field}_${Date.now()}_${rand}.${ext}`;

      const { error: uploadError } = await sb.storage
        .from(BUCKET)
        .upload(path, bytes, { contentType: mime, upsert: false });
      if (uploadError) throw uploadError;

      const { error: insertError } = await sb.from("driver_documents").insert({
        org_id: orgId,
        driver_id: null,
        application_id: applicant.id,
        kind,
        storage_path: path,
        file_name: name,
        mime_type: mime,
        size_bytes: bytes.length,
        notes: label,
        uploaded_by: "website",
      });
      if (insertError) {
        void sb.storage.from(BUCKET).remove([path]);
        throw insertError;
      }

      stored.push(label);
    } catch (err) {
      console.error(`[applications-public] ${field} upload failed:`, err);
      failed.push(label);
    }
  }

  return c.json({ filed: true, applicationId: applicant.id, stored, failed });
});

export default applicationsPublic;
