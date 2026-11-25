-- Which truck has this trailer, said by a human.
--
-- Until now the answer was derived: the last load naming the trailer
-- also named a tractor, so that tractor was said to have it. Measured
-- against live Motive positions on 2026-11-25 that was wrong for 13 of
-- Curzon's 14 linked trailers, because loads get swapped mid-route and
-- nobody retypes the dispatch record. #402595 was shown behind CT-2020
-- while CT-2020 sat 370 miles away and P-C412863 was 0.1 miles from the
-- trailer.
--
-- GPS fixes most of that on its own and needs no storage. What it
-- cannot do is the yard: six trucks and six trailers stand within 800 m
-- of the Salt Lake yard at zero distance from each other, and no
-- proximity reading can say which tractor is under which trailer. That
-- is the case this column is for — a dispatcher who can see the yard
-- states the pairing, and their word outranks both derivations.
--
-- A column on trailers rather than a hookups table: the question is
-- "what is true now", one tractor per trailer, and the history of who
-- had it is already recoverable from loads and from the stored
-- location samples. A table would be a second place to keep the same
-- fact in sync.
--
-- NULL = nobody has said, which is every existing row. Nothing changes
-- until someone sets one. The assignment holds until it is changed or
-- cleared (Matt's call, 2026-11-25) — GPS disagreeing with it is
-- surfaced in the UI as a flag, never as a silent override, because a
-- human standing in the yard beats a derivation.

alter table trailers
  add column if not exists manual_asset_id bigint
    references assets(id) on delete set null;

-- When, and by whom. Not an audit trail — audit_log already has one —
-- but the UI says "set by Matt, 3 days ago" so a stale assignment can
-- be recognised as stale rather than trusted forever in silence.
alter table trailers
  add column if not exists manual_asset_at timestamptz;

alter table trailers
  add column if not exists manual_asset_by text;

-- Clearing the tractor clears its provenance with it: a timestamp
-- hanging off a NULL assignment would read as "somebody set this"
-- on a trailer nobody has claimed.
alter table trailers
  drop constraint if exists trailers_manual_asset_coherent;

alter table trailers
  add constraint trailers_manual_asset_coherent
  check (manual_asset_id is not null or (manual_asset_at is null and manual_asset_by is null));

-- Answering "which trailer is on CT-2025" from the truck side, which
-- is how the map's truck pins are built. Partial: the overwhelming
-- majority of rows are NULL and always will be.
create index if not exists trailers_manual_asset_id_idx
  on trailers (manual_asset_id)
  where manual_asset_id is not null;
