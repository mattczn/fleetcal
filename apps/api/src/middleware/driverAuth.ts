/**
 * Driver-app auth middleware. Drivers authenticate against Supabase via
 * phone-OTP, then send the resulting Supabase access token to the API.
 * We verify the HS256 signature against SUPABASE_JWT_SECRET, pull the
 * verified phone off the claims, and resolve to the corresponding row in
 * the `drivers` table.
 *
 * Sets:
 *   c.driverId — bigint id from drivers.id
 *   c.orgId    — drivers.org_id
 *   c.driverName — drivers.name (handy for audit log writes)
 *   c.phone    — normalized phone, for debugging
 *
 * Returns:
 *   401 — missing / malformed / expired Supabase token
 *   401 — token has no verified phone claim
 *   404 — token is valid but no drivers row matches that phone
 */
import type { MiddlewareHandler } from "hono";
import { jwtVerify } from "jose";
import { supabase } from "../lib/supabase.js";
import { env } from "../lib/env.js";

export type DriverAuthVariables = {
  driverId:   number;
  orgId:      string;
  driverName: string;
  phone:      string;
};

const SUPABASE_JWT_KEY = new TextEncoder().encode(env.supabaseJwtSecret);

interface SupabaseJwtClaims {
  sub:    string;
  phone?: string;
  user_metadata?: { phone?: string };
  exp?:   number;
  aal?:   string;
}

export const driverAuth: MiddlewareHandler<{ Variables: DriverAuthVariables }> =
  async (c, next) => {
    const header = c.req.header("authorization");
    if (!header?.startsWith("Bearer ")) {
      return c.json({ error: "unauthorized", reason: "missing_bearer" }, 401);
    }
    const token = header.slice("Bearer ".length).trim();
    if (!token) {
      return c.json({ error: "unauthorized", reason: "empty_token" }, 401);
    }

    let claims: SupabaseJwtClaims;
    try {
      const { payload } = await jwtVerify(token, SUPABASE_JWT_KEY, {
        algorithms: ["HS256"],
      });
      claims = payload as unknown as SupabaseJwtClaims;
    } catch (err) {
      const message = err instanceof Error ? err.message : "verification_failed";
      return c.json({ error: "unauthorized", reason: message }, 401);
    }

    // Supabase puts the verified phone on the top-level `phone` claim. Some
    // older / federated tokens stash it under user_metadata; fall through.
    const phone = claims.phone ?? claims.user_metadata?.phone;
    if (!phone) {
      return c.json({ error: "unauthorized", reason: "no_phone_claim" }, 401);
    }

    // Drivers are scoped to one org and one phone, so an exact match is enough.
    // We don't trust client-supplied org_id — derive it from the row.
    const { data: row, error } = await supabase
      .from("drivers")
      .select("id, org_id, name, phone")
      .eq("phone", phone)
      .limit(1)
      .maybeSingle();
    if (error) {
      console.error("[driverAuth] drivers lookup failed:", error);
      return c.json({ error: "lookup_failed", detail: error.message }, 500);
    }
    if (!row) {
      return c.json({ error: "not_found", reason: "no_driver_for_phone" }, 404);
    }
    const driver = row as { id: number; org_id: string; name: string; phone: string };

    c.set("driverId",   driver.id);
    c.set("orgId",      driver.org_id);
    c.set("driverName", driver.name);
    c.set("phone",      driver.phone);
    await next();
  };
