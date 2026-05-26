-- 20260529_org_api_keys.sql
--
-- org_api_keys — long-lived API keys for server-to-server callers
-- that can't carry a Clerk session. First (and currently only)
-- consumer: the Google Apps Script that polls fuel@curzontrucking.com
-- and POSTs Mudflap receipts to /v1/fuel-transactions/inbound-email.
--
-- Security model:
--   • The plaintext key is shown ONCE at creation time, never stored.
--     We store only sha256(key) so a DB leak can't be replayed.
--   • The first 8 chars of the plaintext are stored separately as
--     `key_prefix` for display ("fck_a1b2c3d4...") so dispatch can
--     identify which key is which without seeing the secret.
--   • Scopes are an open-coded text array; the API validates that
--     the requested scope is present before serving. Start with
--     'fuel.ingest' for the Mudflap poller.
--   • Keys are revocable via revoked_at — the auth middleware
--     filters revoked keys out at lookup time.
--
-- Key format: `fck_<32 hex chars>` ("fc" = FleetCal, "k" = key). The
-- prefix lets dispatch users grep for them in shell history /
-- accidentally-pasted-anywhere audits.

CREATE TABLE IF NOT EXISTS org_api_keys (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        text NOT NULL,

  -- Human-readable label ("fuel-email-poller", "ops-zapier-bridge").
  -- Required so dispatch can tell which key does what.
  name          text NOT NULL,

  -- sha256 of the plaintext key. UNIQUE across all orgs so a
  -- collision is impossible (the random space makes collisions
  -- vanishingly unlikely; the unique constraint just enforces it).
  key_hash      text NOT NULL UNIQUE,

  -- First 8 chars of the plaintext (e.g. "fck_a1b2"). Lets dispatch
  -- identify a key in the UI without showing the secret. The full
  -- plaintext is shown only at creation time.
  key_prefix    text NOT NULL,

  -- What this key can do. Open-coded so adding new scopes is a
  -- code change, not a migration. Current scopes:
  --   'fuel.ingest' — POST /v1/fuel-transactions/inbound-email
  scopes        text[] NOT NULL DEFAULT '{}',

  created_at    timestamptz NOT NULL DEFAULT now(),
  -- Clerk user id of the creator (null if seeded directly).
  created_by    text,
  -- Recorded by the auth middleware on every successful auth so
  -- dispatch can see "this key hasn't been used in 90 days" and
  -- decide to revoke it.
  last_used_at  timestamptz,
  -- Soft revocation. Auth middleware filters by `revoked_at IS NULL`.
  revoked_at    timestamptz,
  revoked_by    text
);

-- Hash lookup is the hot path — every authed request runs it. Partial
-- so revoked keys don't slow it down.
CREATE INDEX IF NOT EXISTS org_api_keys_hash_idx
  ON org_api_keys (key_hash)
  WHERE revoked_at IS NULL;

-- "Show me all active keys for this org" — settings page.
CREATE INDEX IF NOT EXISTS org_api_keys_org_idx
  ON org_api_keys (org_id, created_at DESC)
  WHERE revoked_at IS NULL;
