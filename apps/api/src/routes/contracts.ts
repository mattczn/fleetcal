/**
 * /v1/contracts — issuing side (authenticated).
 *
 * Dispatch issues a contract for a hired driver; the driver signs it through
 * the public token route. Merge values are snapshotted here, at issue, so a
 * later edit to the driver record cannot change what was signed.
 */

import { Hono } from "hono";
import { supabase } from "../lib/supabase.js";
import { TEMPLATE_VERSION } from "../lib/contracts/ica.js";
import type { AuthVariables } from "../middleware/clerk.js";
import { requireModule } from "../middleware/require.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const sb = supabase as any;

const contracts = new Hono<{ Variables: AuthVariables }>();

// Ships dark. No org — including Curzon — reaches these until `hiring` is
// switched on in /admin/orgs.
contracts.use("*", requireModule("hiring"));

// ── POST /v1/contracts — issue an agreement for a driver ───────────────────
contracts.post("/", async (c) => {
  const orgId = c.get("orgId");
  const body = await c.req.json().catch(() => ({}));
  const driverId = Number(body.driverId);

  if (!Number.isFinite(driverId)) {
    return c.json({ error: "driverId is required" }, 400);
  }

  const { data: driver } = await sb
    .from("drivers")
    .select("id, name, first_name, last_name, address, active_from")
    .eq("id", driverId)
    .eq("org_id", orgId)
    .maybeSingle();

  if (!driver) return c.json({ error: "Driver not found" }, 404);

  // The Effective Date is the hire date. Without one there is no defensible
  // date to put on the agreement, so refuse rather than quietly using today.
  const effectiveDate = body.effectiveDate || driver.active_from;
  if (!effectiveDate) {
    return c.json(
      { error: "This driver has no start date. Set their hire date first, or pass effectiveDate." },
      400
    );
  }

  const contractorName =
    driver.name ||
    [driver.first_name, driver.last_name].filter(Boolean).join(" ").trim();

  if (!contractorName) {
    return c.json({ error: "This driver has no name on file." }, 400);
  }

  const { data: created, error } = await sb
    .from("driver_contracts")
    .insert({
      org_id: orgId,
      driver_id: driver.id,
      template_key: "ica",
      template_version: TEMPLATE_VERSION,
      effective_date: effectiveDate,
      contractor_name: contractorName,
      contractor_address: driver.address ?? null,
    })
    .select("id, public_token, effective_date, contractor_name, contractor_address, status")
    .single();

  if (error) {
    console.error("[contracts] issue failed:", error);
    return c.json({ error: "Could not create the agreement." }, 500);
  }

  const base = process.env.CONTRACT_SIGNING_BASE_URL || "https://curzontrucking.com";

  return c.json({
    contract: created,
    signingUrl: `${base}/contract/${created.public_token}`,
  });
});

// ── GET /v1/contracts/driver/:driverId — history for a driver ──────────────
contracts.get("/driver/:driverId", async (c) => {
  const orgId = c.get("orgId");
  const driverId = Number(c.req.param("driverId"));

  const { data } = await sb
    .from("driver_contracts")
    .select("id, public_token, effective_date, status, sent_at, signed_name, signed_at, document_path, template_version")
    .eq("org_id", orgId)
    .eq("driver_id", driverId)
    .order("sent_at", { ascending: false });

  return c.json({ contracts: data ?? [] });
});

export default contracts;
