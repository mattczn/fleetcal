-- ───────────────────────────────────────────────────────────────────
-- dispatchers — per-org directory of dispatcher personnel.
--
-- Lives alongside drivers/assets/trailers/customers/locations in the
-- "Manage Assets" sidebar. Loads point at a dispatcher row via the
-- new loads.dispatcher_id FK; the existing loads.dispatcher text
-- column stays around as a denormalized name cache so old rows
-- still render and so simple reports can read the name without a
-- join.
--
-- Schema notes:
--   - first_name + last_name are required; everything else optional.
--   - clerk_user_id links to a Clerk org member when known. NULL is
--     valid (contractor, former employee, manually-added record).
--     Stored as text (Clerk IDs are short strings like user_2a8…).
--   - is_default — exactly ONE row per org can be the default, enforced
--     by a partial unique index. The set-default endpoint flips
--     is_default off everywhere else in the org in a single tx before
--     setting the target row's flag.
--   - active — soft delete. Loads keep historical attribution when a
--     dispatcher leaves the company; hard delete is allowed only when
--     no loads reference the row.
-- ───────────────────────────────────────────────────────────────────

CREATE TABLE dispatchers (
  id             bigserial PRIMARY KEY,
  org_id         text   NOT NULL,
  first_name     text   NOT NULL,
  last_name      text   NOT NULL,
  hire_date      date,
  clerk_user_id  text,
  is_default     boolean NOT NULL DEFAULT false,
  active         boolean NOT NULL DEFAULT true,
  created_at     timestamptz NOT NULL DEFAULT now()
);

-- Fast per-org listing — the dominant read pattern.
CREATE INDEX dispatchers_org_id_idx ON dispatchers (org_id, last_name, first_name);

-- One default per org. PARTIAL unique index — only applies to the
-- row currently flagged default, so we don't need to maintain a
-- sentinel value.
CREATE UNIQUE INDEX dispatchers_default_per_org_idx
  ON dispatchers (org_id) WHERE is_default = true;

-- Add FK column on loads. Nullable; existing rows stay NULL.
ALTER TABLE loads ADD COLUMN dispatcher_id bigint REFERENCES dispatchers(id);
CREATE INDEX loads_dispatcher_id_idx ON loads (dispatcher_id) WHERE dispatcher_id IS NOT NULL;
