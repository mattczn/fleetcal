-- 20260807_link_unlinked_loads.sql
--
-- DATA FIX. Run once. Safe to re-run.
--
-- WHY "No customer" SHOWS A CUSTOMER WHEN YOU CLICK IN
--
-- Receivables groups by the INVOICE's customer. The load detail shows
-- loads.broker, which is free text. A load with broker = 'GAMPAC LOGISTICS'
-- and customer_id = NULL therefore reads as "No customer" in the ledger and
-- as GAMPAC everywhere else. It was never linked; only labelled.
--
-- That is the same defect as invoices.customer_id and loads.broker earlier
-- today, in its third form: a label standing in for a link.
--
-- On Curzon: 160 unlinked live loads, of which 133 carry broker text that
-- EXACTLY names an existing customer — name, short_name or alias, case- and
-- whitespace-insensitive. Those are linkable without a judgement call.
--
-- EXACT match only, deliberately. Fuzzy matching is how "Go Lighthouse"
-- becomes "Lighthouse Recycling" and "PT" becomes "Titan Concepts" — both
-- real mistakes found in this ledger today. The 27 that don't match exactly
-- are left for a person; they are listed by section 3.

-- ── 1. DRY RUN ───────────────────────────────────────────────────────

SELECT l.broker, c.name AS will_link_to, count(*) AS loads
FROM loads l
JOIN customers c
  ON c.org_id = l.org_id
 AND (lower(btrim(c.name))       = lower(btrim(l.broker))
   OR lower(btrim(c.short_name)) = lower(btrim(l.broker))
   OR EXISTS (SELECT 1 FROM unnest(c.aliases) a
              WHERE lower(btrim(a)) = lower(btrim(l.broker))))
WHERE l.org_id = 'org_3Ck09w6LuEjiX4WgxJEPyiyjuXN'
  AND l.deleted_at IS NULL
  AND l.customer_id IS NULL
  AND btrim(coalesce(l.broker, '')) <> ''
GROUP BY 1, 2
ORDER BY loads DESC;

-- Expected on Curzon: 133 loads. Largest groups are Triple T Transport (26),
-- ITS National LLC (24), Uber Freight LLC (20), Freight Tec (13).

-- ── 2. LINK THEM ─────────────────────────────────────────────────────

BEGIN;

-- Only where the broker text matches EXACTLY ONE customer. A text matching
-- two customer records is ambiguous and must not be guessed — that is the
-- duplicate-customer trap (TCI Global / Titan Concepts) in another costume.
UPDATE loads l
SET customer_id = m.cid,
    broker      = m.cname,
    updated_at  = now()
FROM (
  SELECT l2.id AS lid, min(c.id) AS cid, min(c.name) AS cname
  FROM loads l2
  JOIN customers c
    ON c.org_id = l2.org_id
   AND (lower(btrim(c.name))       = lower(btrim(l2.broker))
     OR lower(btrim(c.short_name)) = lower(btrim(l2.broker))
     OR EXISTS (SELECT 1 FROM unnest(c.aliases) a
                WHERE lower(btrim(a)) = lower(btrim(l2.broker))))
  WHERE l2.org_id = 'org_3Ck09w6LuEjiX4WgxJEPyiyjuXN'
    AND l2.deleted_at IS NULL
    AND l2.customer_id IS NULL
    AND btrim(coalesce(l2.broker, '')) <> ''
  GROUP BY l2.id
  HAVING count(DISTINCT c.id) = 1
) m
WHERE l.id = m.lid;

-- Carry the invoices with their loads — the rule the API now applies on
-- every load edit, repeated because this bypasses the API.
UPDATE invoices i
SET customer_id = l.customer_id,
    updated_at  = now()
FROM loads l
WHERE l.id = i.load_id
  AND i.org_id = 'org_3Ck09w6LuEjiX4WgxJEPyiyjuXN'
  AND i.status <> 'void'
  AND i.customer_id IS DISTINCT FROM l.customer_id;

COMMIT;

-- ── 3. WHAT'S LEFT FOR A PERSON ──────────────────────────────────────
-- Unlinked loads whose broker text matches no customer, or matches more
-- than one. Each needs the customer created, or the right one chosen.

SELECT l.broker,
       count(*)          AS loads,
       sum(l.load_price) AS value,
       min(l.load_num)   AS example_load
FROM loads l
WHERE l.org_id = 'org_3Ck09w6LuEjiX4WgxJEPyiyjuXN'
  AND l.deleted_at IS NULL
  AND l.customer_id IS NULL
GROUP BY 1
ORDER BY loads DESC;

-- The six invoices showing under "No customer" in Receivables are in here:
-- Riverbend, FLS, GAMPAC LOGISTICS, GIX Logistics, Motus Freight, and
-- ITS National LLC (that last one links in section 2).
