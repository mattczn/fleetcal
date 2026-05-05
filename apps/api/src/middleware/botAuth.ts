/**
 * Bot API key middleware.
 *
 * Validates the X-Bot-Key header against BOT_API_KEY and injects the
 * org/user into context the same way clerkAuth does, so bot routes can
 * reuse all existing route handlers without modification.
 *
 * Requires BOT_API_KEY and BOT_ORG_ID to be set in env. If either is
 * missing the middleware returns 503 so a misconfigured deploy fails
 * loudly rather than silently accepting any key.
 */

import type { MiddlewareHandler } from "hono";
import type { AuthVariables } from "./clerk.js";
import { env } from "../lib/env.js";

export const botAuth: MiddlewareHandler<{ Variables: AuthVariables }> =
  async (c, next) => {
    if (!env.botApiKey || !env.botOrgId) {
      return c.json(
        { error: "service_unavailable", reason: "bot_auth_not_configured" },
        503,
      );
    }

    const key = c.req.header("x-bot-key");
    console.log("[botAuth] received key length:", key?.length, "expected length:", env.botApiKey.length, "match:", key === env.botApiKey);
    if (!key || key !== env.botApiKey) {
      return c.json({ error: "unauthorized", reason: "invalid_bot_key" }, 401);
    }

    c.set("userId", "bot");
    c.set("orgId", env.botOrgId);
    await next();
  };
