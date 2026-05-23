-- 20260525_inspection_photo_target.sql
--
-- Tag each inspection photo as belonging to the truck or the trailer.
-- Without this distinction, a driver doing a combined truck+trailer
-- inspection ends up with a single pile of photos in dispatch and
-- has to caption every one of them manually for the photo to be
-- useful ("this is the trailer brake light, this is the truck brake
-- light", etc).
--
-- target = 'truck' | 'trailer' | NULL
--   - per-item photos derive target from which checklist row they
--     were attached to
--   - general photos pick up target from which equipment block they
--     were added under (driver explicitly chooses by tapping +
--     under the truck or trailer section)
--   - legacy rows: backfilled from the item_id prefix convention.
--     `tr_*` items are trailer; everything else is truck; null
--     stays null (general photos from before this migration — there
--     shouldn't be many since the feature only launched a couple days
--     ago).

ALTER TABLE inspection_photos
  ADD COLUMN IF NOT EXISTS target text;

-- Backfill from existing item_id naming. Trailer item ids start with
-- 'tr_' (see TRAILER_CHECKLIST in InspectionFormScreen). Truck items
-- don't have that prefix.
UPDATE inspection_photos
   SET target = CASE
     WHEN item_id LIKE 'tr\_%' ESCAPE '\' THEN 'trailer'
     WHEN item_id IS NOT NULL              THEN 'truck'
     ELSE NULL
   END
 WHERE target IS NULL;

-- Constrain to the two valid values (NULL allowed for general photos
-- on legacy or truck-only inspections without an explicit target).
ALTER TABLE inspection_photos
  DROP CONSTRAINT IF EXISTS inspection_photos_target_check;
ALTER TABLE inspection_photos
  ADD CONSTRAINT inspection_photos_target_check
  CHECK (target IS NULL OR target IN ('truck', 'trailer'));

NOTIFY pgrst, 'reload schema';
