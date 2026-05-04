-- Check calls: lightweight communication log per load.
-- One row per logged communication (call, text, email, internal note).
-- Optionally schedules the next check-in for the load.

CREATE TABLE IF NOT EXISTS check_calls (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        text NOT NULL,
  load_id       uuid NOT NULL REFERENCES loads(id) ON DELETE CASCADE,
  ts            timestamptz NOT NULL DEFAULT now(),  -- when the comm happened
  by_name       text NOT NULL,                       -- dispatcher who logged it
  channel       text NOT NULL,                       -- 'call' | 'text' | 'email' | 'note'
  with_party    text NOT NULL,                       -- 'driver' | 'broker' | 'shipper' | 'receiver'
  body          text NOT NULL,
  next_check_at timestamptz,                         -- optional — when next check call due
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_check_calls_load_id
  ON check_calls (org_id, load_id, ts DESC);
