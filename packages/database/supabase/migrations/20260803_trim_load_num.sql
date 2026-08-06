-- 20260803_trim_load_num.sql
--
-- DATA FIX. Run once, any time. Safe to re-run (idempotent).
--
-- Some loads carry a load_num with surrounding whitespace — '4743608 '
-- rather than '4743608'. In Curzon prod that is 31 of 4,390 live loads
-- (0.7%); internal_load_id is clean at 100%.
--
-- It looks cosmetic and isn't. Anything matching a load by its number does
-- an exact comparison, so a stored '4743608 ' can never equal a '4743608'
-- read off a document. On the ITS remittance REMIT272541 this silently cost
-- exactly one line of sixteen: the load was sitting in the ledger, visible
-- on screen, and the matcher could not see it. The failure mode is a row
-- that quietly doesn't match while its fifteen neighbours do — which reads
-- as "the matcher is unreliable" rather than "this one value has a space".
--
-- The same exact-match problem applies to the invoice search, to any future
-- bank-line matching, and to a human pasting the number into a search box.
--
-- NULLIF keeps a value that is nothing but whitespace from becoming '',
-- which would be a second, quieter kind of wrong.
--
-- REVERSAL: none. There is no legitimate load number that differs from
-- another only by surrounding whitespace, so nothing is lost.

BEGIN;

-- What will change, before it changes.
SELECT count(*) AS rows_to_trim
FROM loads
WHERE load_num IS NOT NULL
  AND load_num <> btrim(load_num);

UPDATE loads
SET load_num = NULLIF(btrim(load_num), '')
WHERE load_num IS NOT NULL
  AND load_num <> btrim(load_num);

COMMIT;

-- Expect 0 after this runs, and 0 on any re-run.
SELECT count(*) AS still_untrimmed
FROM loads
WHERE load_num IS NOT NULL
  AND load_num <> btrim(load_num);

-- Worth knowing: this fixes the rows that exist. It does not stop new ones
-- arriving, since load_num is written from imports and hand entry. If dirty
-- values keep appearing, the durable fix is to trim on write —
--   ALTER TABLE loads ADD CONSTRAINT loads_load_num_trimmed
--     CHECK (load_num IS NULL OR load_num = btrim(load_num));
-- — but that will reject writes from any importer still sending padded
-- values, so it should follow a check of what those importers send rather
-- than ship blind.
