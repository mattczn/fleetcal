-- 20260713_inspection_media_video.sql
--
-- Videos on inspections. Same table as photos — inspection_photos is
-- really "inspection media" now. Driver can optionally attach a short
-- video (≤3 min, ~40MB at ~480p) at the end of an inspection so dispatch
-- can see something a still can't show: engine noise, brake pedal feel,
-- a rattle under the cab.
--
-- Kept in the same table (and same 'inspection-photos' storage bucket)
-- rather than splitting into inspection_videos because the read path is
-- always "give me all media for this report" — splitting would double
-- the query fanout on every inspection detail load for no benefit.

ALTER TABLE inspection_photos
  ADD COLUMN IF NOT EXISTS media_kind       text NOT NULL DEFAULT 'photo',
  ADD COLUMN IF NOT EXISTS duration_seconds integer,
  ADD COLUMN IF NOT EXISTS size_bytes       bigint,
  ADD COLUMN IF NOT EXISTS mime_type        text;

ALTER TABLE inspection_photos
  DROP CONSTRAINT IF EXISTS inspection_photos_media_kind_check;
ALTER TABLE inspection_photos
  ADD CONSTRAINT inspection_photos_media_kind_check
  CHECK (media_kind IN ('photo', 'video'));

-- duration_seconds only makes sense on video rows; enforce that so a
-- future bug can't leave a duration hanging on a still image.
ALTER TABLE inspection_photos
  DROP CONSTRAINT IF EXISTS inspection_photos_duration_video_only;
ALTER TABLE inspection_photos
  ADD CONSTRAINT inspection_photos_duration_video_only
  CHECK (duration_seconds IS NULL OR media_kind = 'video');

NOTIFY pgrst, 'reload schema';
