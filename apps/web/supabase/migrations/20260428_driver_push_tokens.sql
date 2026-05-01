-- Push notification tokens for the driver mobile app.
-- One driver can have multiple tokens (multiple devices, reinstalls, etc).
-- We never delete on logout — Expo's push API tells us when a token is invalid
-- and we clean up then.

CREATE TABLE driver_push_tokens (
  id           bigserial PRIMARY KEY,
  driver_id    bigint   NOT NULL REFERENCES drivers(id) ON DELETE CASCADE,
  org_id       text     NOT NULL,
  token        text     NOT NULL UNIQUE,
  platform     text     NOT NULL,                  -- 'ios' | 'android'
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_driver_push_tokens_driver ON driver_push_tokens (driver_id);

-- The driver app inserts/updates tokens via the authenticated role.
GRANT SELECT, INSERT, UPDATE ON driver_push_tokens TO authenticated;
GRANT USAGE ON SEQUENCE driver_push_tokens_id_seq TO authenticated;
