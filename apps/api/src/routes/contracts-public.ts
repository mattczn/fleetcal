/**
 * /v1/contracts — public contract signing.
 *
 *   GET  /v1/contracts/:token        — the documents to read and sign
 *   POST /v1/contracts/:token/sign   — record the signature, file the PDF
 *
 * SECURITY NOTES
 *
 * 1. The token IS the tenant boundary. org_id is resolved from the contract
 *    row, never accepted from the caller — so this endpoint is multi-tenant
 *    without any per-carrier configuration, unlike the pinned ORG_ID in
 *    tracking-public.ts.
 *
 * 2. Only the fields needed to render and sign leave this file. A contract row
 *    is not sensitive the way a load is, but the driver record behind it is —
 *    never join and spread `drivers`.
 *
 * 3. Signing is idempotent-safe: a contract already signed returns its state
 *    rather than re-signing, so a double-tap can't produce two records or
 *    overwrite the original timestamp.
 */

import { Hono } from "hono";
import { supabase } from "../lib/supabase.js";
import { renderDocuments, TEMPLATE_VERSION } from "../lib/contracts/ica.js";
import { buildContractPdf } from "../lib/contracts/pdf.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const sb = supabase as any;

const contracts = new Hono();

const COMPANY_SIGNER = "Jonathan Curzon / Manager";
const BUCKET = "driver-documents";

const CONTRACT_COLS =
  "id, org_id, driver_id, template_key, template_version, public_token, effective_date, " +
  "contractor_name, contractor_address, status, signed_name, signed_at, document_path, voided_at";

function clientIp(c: { req: { header: (k: string) => string | undefined } }): string {
  return (
    c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ||
    c.req.header("x-real-ip") ||
    "unknown"
  );
}

/** Effective date as it reads on the agreement. Stored as a date, so parse it
 *  as one — `new Date("2026-02-17")` is UTC midnight and can render as the
 *  16th west of Greenwich. */
function formatEffectiveDate(value: string): string {
  const [y, m, d] = value.split("-").map(Number);
  if (!y || !m || !d) return value;
  return `${String(m).padStart(2, "0")}/${String(d).padStart(2, "0")}/${y}`;
}

async function loadByToken(token: string) {
  if (!/^[0-9a-f-]{36}$/i.test(token)) return null;
  const { data } = await sb
    .from("driver_contracts")
    .select(CONTRACT_COLS)
    .eq("public_token", token)
    .maybeSingle();
  if (!data || data.voided_at) return null;
  return data;
}

// ── GET /v1/contracts/:token ───────────────────────────────────────────────
contracts.get("/:token", async (c) => {
  const contract = await loadByToken(c.req.param("token"));
  if (!contract) return c.json({ error: "Not found" }, 404);

  const effectiveDate = formatEffectiveDate(contract.effective_date);

  return c.json({
    status: contract.status,
    contractorName: contract.contractor_name,
    contractorAddress: contract.contractor_address,
    effectiveDate,
    companySigner: COMPANY_SIGNER,
    signedName: contract.signed_name,
    signedAt: contract.signed_at,
    documents: renderDocuments({
      effectiveDate,
      contractorName: contract.contractor_name,
      contractorAddress: contract.contractor_address ?? "",
    }),
  });
});

// ── POST /v1/contracts/:token/sign ─────────────────────────────────────────
contracts.post("/:token/sign", async (c) => {
  const contract = await loadByToken(c.req.param("token"));
  if (!contract) return c.json({ error: "Not found" }, 404);

  if (contract.status === "signed") {
    return c.json({ alreadySigned: true, signedAt: contract.signed_at });
  }

  const body = await c.req.json().catch(() => ({}));
  const signedName = String(body.signedName ?? "").trim();
  const consented = body.consented === true;

  if (signedName.length < 3) {
    return c.json({ error: "Type your full legal name to sign." }, 400);
  }
  if (!consented) {
    return c.json({ error: "Please confirm you agree to sign electronically." }, 400);
  }

  const signedAt = new Date();
  const signedIp = clientIp(c);
  const signedUserAgent = c.req.header("user-agent") || "unknown";
  const effectiveDate = formatEffectiveDate(contract.effective_date);

  const documents = renderDocuments({
    effectiveDate,
    contractorName: contract.contractor_name,
    contractorAddress: contract.contractor_address ?? "",
  });

  const pdfBytes = await buildContractPdf(documents, {
    contractorName: contract.contractor_name,
    signedName,
    signedAt,
    signedIp,
    signedUserAgent,
    companySigner: COMPANY_SIGNER,
    effectiveDate,
  });

  const documentPath = `contracts/${contract.driver_id}/${contract.id}.pdf`;
  const { error: uploadError } = await sb.storage
    .from(BUCKET)
    .upload(documentPath, Buffer.from(pdfBytes), {
      contentType: "application/pdf",
      upsert: true,
    });

  if (uploadError) {
    console.error("[contracts] PDF upload failed:", uploadError);
    return c.json({ error: "We couldn't file your signed agreement. Please try again." }, 502);
  }

  // Only mark signed once the document is safely stored — a row that says
  // "signed" with no PDF behind it is worse than an unsigned one.
  const { error: updateError } = await sb
    .from("driver_contracts")
    .update({
      status: "signed",
      signed_name: signedName,
      signed_at: signedAt.toISOString(),
      signed_ip: signedIp,
      signed_user_agent: signedUserAgent,
      consented: true,
      document_path: documentPath,
      template_version: TEMPLATE_VERSION,
    })
    .eq("id", contract.id);

  if (updateError) {
    console.error("[contracts] status update failed:", updateError);
    return c.json({ error: "We couldn't record your signature. Please try again." }, 502);
  }

  const { data: signed } = await sb.storage
    .from(BUCKET)
    .createSignedUrl(documentPath, 60 * 60);

  return c.json({
    signed: true,
    signedAt: signedAt.toISOString(),
    documentUrl: signed?.signedUrl ?? null,
  });
});

export default contracts;
