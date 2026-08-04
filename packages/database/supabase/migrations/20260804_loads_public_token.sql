-- 20260804_loads_public_token.sql
--
-- Shareable load-tracking links for curzontrucking.com/track.
--
-- A per-load opaque token is the primary way a customer reaches the portal:
-- dispatch copies a link and texts it. The alternative entry — searching by
-- load or reference number — CANNOT be the only mechanism, because
-- loads.internal_load_id is a sequential integer starting at 10000 and
-- load_num is the broker's, often sequential too. Anything keyed on those
-- alone can be walked to enumerate the entire book of business, so the
-- search path is gated on a second factor (delivery ZIP) and the token path
-- is unguessable.
--
-- Tokens are per-load, not per-leg: a relay is one journey to the customer
-- however many events rows carry it.

ALTER TABLE loads
  ADD COLUMN IF NOT EXISTS public_token uuid NOT NULL DEFAULT gen_random_uuid();

-- Lookup is by token alone, so it must be unique and indexed. The uniqueness
-- constraint also guards against a botched backfill collapsing tokens.
CREATE UNIQUE INDEX IF NOT EXISTS loads_public_token_key
  ON loads (public_token);

-- Revocation: dispatch can kill a link that went to the wrong party without
-- deleting the load. Null here means "tracking disabled for this load".
ALTER TABLE loads
  ADD COLUMN IF NOT EXISTS tracking_revoked_at timestamptz;

COMMENT ON COLUMN loads.public_token IS
  'Opaque token for the public tracking portal. Never expose alongside org_id or any pricing field.';
COMMENT ON COLUMN loads.tracking_revoked_at IS
  'When set, /v1/tracking returns 404 for this load''s token.';
