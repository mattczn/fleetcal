/**
 * Hono middleware that captures every 4xx/5xx response into the
 * `api_errors` table for the /admin/errors dashboard.
 *
 * Runs AFTER the route handler executes — by then the response status
 * is set and (most of the time) auth has resolved so we know which
 * org/user the request was for. The insert is fire-and-forget: we
 * never delay the response on it. If the insert fails, we log to
 * stderr and move on; admins lose one row, end-user gets their
 * response normally.
 *
 * Skips:
 *   - GET /v1/health        — public liveness probe, would flood the table
 *   - body capture for multipart — file uploads would dump base64 / PDFs
 *     into Postgres. We still log the row, just without body_snippet.
 *
 * The error_code + detail extraction looks at the JSON response body
 * (where every routes/* file uses the `{ error, detail, errors }`
 * ApiErrorResponse shape). When the body isn't JSON we leave both
 * null and the dashboard just shows the status code.
 */

import type { MiddlewareHandler } from "hono";
import { supabase } from "../lib/supabase.js";

const MAX_BODY_SNIPPET = 500;

export const captureErrors: MiddlewareHandler<{
  Variables: {
    orgId?:   string;
    userId?:  string;
  };
}> = async (c, next) => {
  const started = Date.now();

  // Snapshot the request body BEFORE the handler runs. We can't read
  // it after — the handler has already consumed the stream. Skip
  // multipart so we don't capture file uploads.
  let bodySnippet: string | null = null;
  const ct = c.req.header("content-type") ?? "";
  if (
    c.req.method !== "GET" &&
    c.req.method !== "DELETE" &&
    !ct.startsWith("multipart/")
  ) {
    try {
      // Clone the request — c.req.raw is the underlying Fetch Request.
      // text() consumes the body, so we read from a clone and let the
      // route handler read from the original.
      const clone = c.req.raw.clone();
      const text = await clone.text();
      if (text) {
        bodySnippet = text.length > MAX_BODY_SNIPPET
          ? text.slice(0, MAX_BODY_SNIPPET) + "…"
          : text;
      }
    } catch {
      // Body already consumed somewhere upstream, or stream errored.
      // Skip silently — losing the body is fine, we still get the row.
    }
  }

  await next();

  const status = c.res.status;
  if (status < 400) return;

  // Skip the liveness probe — it never errors today, but if it did
  // we'd flood the table.
  const path = c.req.path;
  if (path === "/v1/health") return;

  // Best-effort: read the JSON response body for error_code + detail.
  let errorCode: string | null = null;
  let detail:    string | null = null;
  try {
    // The handler already wrote the response; clone and re-read.
    const resClone = c.res.clone();
    const text = await resClone.text();
    if (text) {
      try {
        const parsed = JSON.parse(text) as {
          error?:  string;
          detail?: string;
          errors?: string[];
        };
        if (typeof parsed.error  === "string") errorCode = parsed.error;
        if (typeof parsed.detail === "string") detail    = parsed.detail;
        // Fall back to errors[0] if there's no detail string.
        if (!detail && Array.isArray(parsed.errors) && parsed.errors[0]) {
          detail = String(parsed.errors[0]).slice(0, 500);
        }
      } catch {
        // Non-JSON body (HTML error page, plain-text) — leave nulls.
      }
    }
  } catch {
    // Response body unreadable. Still record the row.
  }

  const durationMs = Date.now() - started;
  const orgId  = c.get("orgId")  ?? null;
  const userId = c.get("userId") ?? null;
  const userAgent = c.req.header("user-agent") ?? null;

  // Fire and forget — never block the response on this.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  void (supabase as any)
    .from("api_errors")
    .insert({
      org_id:        orgId,
      user_id:       userId,
      method:        c.req.method,
      path,
      status,
      error_code:    errorCode,
      detail:        detail ? String(detail).slice(0, 500) : null,
      body_snippet:  bodySnippet,
      user_agent:    userAgent ? userAgent.slice(0, 500) : null,
      duration_ms:   durationMs,
    })
    .then(({ error }: { error: unknown }) => {
      if (error) console.warn("[captureErrors] insert failed:", error);
    });
};
