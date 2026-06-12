-- Cache of AI reference-number extractions from rate-con PDFs, keyed on the
-- PDF's content hash. A broker sends the SAME attachment to every dispatcher,
-- so the parse should happen once per unique PDF — not once per inbox. The
-- Gmail extension's /v1/bot/loads/search-pdf checks this before calling Claude;
-- the first person to open a given rate con pays the AI cost, everyone else
-- (any mailbox) gets an instant cache hit.

CREATE TABLE IF NOT EXISTS pdf_extractions (
  org_id     text NOT NULL,
  pdf_sha256 text NOT NULL,
  refs       jsonb NOT NULL DEFAULT '[]'::jsonb,    -- extracted reference numbers
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, pdf_sha256)
);

-- service-role only (bot endpoint uses the service-role key; RLS bypassed).
ALTER TABLE pdf_extractions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON pdf_extractions FROM anon, authenticated;
