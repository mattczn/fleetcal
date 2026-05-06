/**
 * Driver-app auth middleware. Drivers authenticate against Supabase via
 * phone-OTP, then send the resulting Supabase access token to the API.
 *
 * Verification uses Supabase's JWKS endpoint, which handles both the
 * legacy HS256 path and the newer asymmetric (ES256) path automatically
 * — modern Supabase projects sign with rotating asymmetric keys and
 * publish the public keys at /auth/v1/.well-known/jwks.json. The HS256
 * legacy secret is no longer used for tokens minted after the migration.
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
import { createRemoteJWKSet, jwtVerify } from "jose";
import { supabase } from "../lib/supabase.js";
import { env } from "../lib/env.js";

export type DriverAuthVariables = {
  driverId:   number;
  orgId:      string;
  driverName: string;
  phone:      string;
};

const SUPABASE_JWKS = createRemoteJWKSet(
  new URL(`${env.supabaseUrl}/auth/v1/.well-known/jwks.json`),
);

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
      const { payload } = await jwtVerify(token, SUPABASE_JWKS);
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

    // Phones can be stored a few different ways depending on when they were
    // entered ("+15551234567", "15551234567", "5551234567", "(555) 123-4567").
    // Match on the last 10 digits (the US mobile number) so any historical
    // format works without manual cleanup.
    const digits   = phone.replace(/\D/g, "");
    const last10   = digits.slice(-10);
    if (last10.length !== 10) {
      return c.json({ error: "unauthorized", reason: "phone_too_short", phone }, 401);
    }
    // Try the obvious variants; PostgREST .or() splits on commas.
    const variants = [
      `+1${last10}`,
      `1${last10}`,
      last10,
    ];
    const orFilter = variants.map((v) => `phone.eq.${v}`).join(",");
    const { data: row, error } = await supabase
      .from("drivers")
      .select("id, org_id, name, phone")
      .or(orFilter)
      .limit(1)
      .maybeSingle();
    if (error) {
      console.error("[driverAuth] drivers lookup failed:", error);
      return c.json({ error: "lookup_failed", detail: error.message }, 500);
    }
    if (!row) {
      return c.json({
        error:  "not_found",
        reason: "no_driver_for_phone",
        // Echo what we tried so it's obvious from the error which row to add.
        triedPhones: variants,
      }, 404);
    }
    const driver = row as { id: number; org_id: string; name: string; phone: string };

    c.set("driverId",   driver.id);
    c.set("orgId",      driver.org_id);
    c.set("driverName", driver.name);
    c.set("phone",      driver.phone);
    await next();
  };
