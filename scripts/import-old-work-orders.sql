-- One-shot: import 85 historical work orders into the FleetCal
-- maintenance_action_items table.
--
-- HOW TO RUN
--   1. Open Supabase dashboard → SQL editor
--   2. Paste this entire file
--   3. Click Run
--
-- WHAT IT DOES
--   - Resolves the old `asset_id` UUID column against your current
--     assets + trailers tables, joining on the unit number / trailer
--     number. Truck WOs land in asset_id, trailer WOs in trailer_id.
--   - 2 source rows have a null asset_id (they were general work
--     orders in the old system). They land with both nulls; assign
--     equipment later via the UI.
--   - Preserves the old created_at / updated_at / completed_at so
--     the timeline view stays accurate.
--   - Each row gets a "[migrated-from <old-uuid>]" suffix in the
--     description column so re-running this file is idempotent (it
--     skips rows whose old-uuid already lives in the DB).
--
-- AFTER YOU'VE VERIFIED — strip the migration suffixes:
--   UPDATE maintenance_action_items
--   SET description = trim(regexp_replace(description,
--       E'\\s*\\[migrated-from [0-9a-f-]+\\]\\s*$', ''))
--   WHERE org_id = 'org_3Cgzom31hVxbq6WR3FjVTbL6K3t'
--     AND description LIKE '%[migrated-from %';
--
-- AFTER YOU'VE VERIFIED — drop the import marker entirely:
--   The script tags created_by='imported' so historical rows are
--   distinguishable from rows the dispatcher actually created. Leave
--   as-is unless you want to overwrite.

WITH
-- ── Step 1: old-asset → new-id resolution ────────────────────────────
-- The 21 old asset UUIDs that appear in the WO data, mapped to
-- (type, unit). We then join to assets/trailers to get the real
-- new bigint id. Anything that doesn't match (e.g. a unit was
-- renamed in the new system) falls through to NULL and the work
-- order still imports — you can attach the equipment from the UI.
asset_map AS (
  SELECT
    m.old_uuid::uuid AS old_uuid,
    CASE WHEN m.type = 'truck'   THEN a.id END AS asset_id,
    CASE WHEN m.type = 'trailer' THEN t.id END AS trailer_id
  FROM (VALUES
    -- Trucks
    ('ffd3b47c-939f-4323-a18d-b7faaf35ce8a', 'truck',   '2021'),
    ('19f88c8a-662d-4fbc-809f-44a115bac4d2', 'truck',   '2026'),
    ('c61c6262-7cd3-484d-9390-6fb34e04bf2d', 'truck',   '2023'),
    ('e365acd6-1c9f-427c-abf7-df2984c8007b', 'truck',   '2022'),
    ('f4d69b33-5198-4dfd-b2c9-062396877930', 'truck',   '2024'),
    ('f50b6002-5934-4925-92bc-9a4365ed7b94', 'truck',   '2025'),
    ('75ee9206-f912-42b3-beac-71cec6bae969', 'truck',   '412863'),
    ('c5617287-bcaa-446b-9016-3fea2ca06aeb', 'truck',   '264495'),
    ('2fd1def8-c537-4f90-a794-e05d21dadce7', 'truck',   '01'),
    ('c88631af-bccf-440a-a540-fc505414d910', 'truck',   '431985'),
    ('fcd359f6-79b8-4c6a-ac13-1827c57a5ced', 'truck',   '214733'),
    -- Trailers
    ('71081eea-4fbc-4269-90a7-4dd36241a068', 'trailer', '330580'),
    ('14595de0-69a9-4be2-b850-4ffa6d5c3259', 'trailer', '292995'),
    ('451152b5-f1da-4bf8-b781-574c9135dede', 'trailer', '292817'),
    ('934ebc32-5ac6-403c-b173-4e5cc0f46133', 'trailer', '292992'),
    ('eb01201c-afc9-4e5f-bd4a-c55dce62fc34', 'trailer', '292988'),
    ('dc10ea36-084b-4ede-a265-363c70977f22', 'trailer', '292991'),
    ('e9c95c41-58d6-47ac-be8c-5df579dd0e89', 'trailer', '292819'),
    ('2b532090-95a3-48c5-9353-3ee8fda91f4d', 'trailer', '263195'),
    ('a9455404-880f-42dc-87fd-8ea78c23f58b', 'trailer', '220627'),
    ('a109c005-a4f7-4d5d-8aca-d6c314f4fc6d', 'trailer', '330755')
  ) AS m(old_uuid, type, unit)
  LEFT JOIN assets   a ON m.type = 'truck'   AND a.unit = m.unit
                       AND a.org_id = 'org_3Cgzom31hVxbq6WR3FjVTbL6K3t'
  LEFT JOIN trailers t ON m.type = 'trailer' AND t.trailer_number = m.unit
                       AND t.org_id = 'org_3Cgzom31hVxbq6WR3FjVTbL6K3t'
),

-- ── Step 2: the 85 work-order rows from the old CSV ──────────────────
-- Columns kept: title, description, category, priority, status,
-- out_of_service, completed_at, created_at, updated_at. Old system
-- mixed trucks + trailers in one asset_id column; resolution to the
-- right new column happens via asset_map below.
old_work_orders(old_id, old_asset_uuid, title, description, category, priority, status, oos, completed_at, created_at, updated_at) AS (
  VALUES
    ('03a4587f-3bb7-46ec-8677-3facc1150142'::uuid, 'ffd3b47c-939f-4323-a18d-b7faaf35ce8a'::uuid, 'Check ELD', 'Make sure ELD is working right. It hasn''t updated since Jan 30', 'repair'::text, 'normal'::text, 'done'::text, false, '2026-03-20 21:59:56.155+00'::timestamptz, '2026-03-09 21:14:55.559799+00'::timestamptz, '2026-03-20 21:59:56.155+00'::timestamptz),
    ('056f5d0a-bb23-42cd-b000-ad731765eac5'::uuid, '19f88c8a-662d-4fbc-809f-44a115bac4d2'::uuid, 'Driver side abs loose robing aircaan', NULL, 'repair', 'high',   'open', false, NULL::timestamptz, '2026-05-21 15:34:46.57495+00'::timestamptz,  '2026-05-21 15:34:46.57495+00'::timestamptz),
    ('06a95906-3254-4684-83a1-f8e308c5c13c'::uuid, '451152b5-f1da-4bf8-b781-574c9135dede'::uuid, 'Flat tire', NULL, 'repair', 'normal', 'open', false, NULL, '2026-04-18 19:19:49.960985+00'::timestamptz, '2026-04-18 19:19:49.960985+00'::timestamptz),
    ('0b7cdbda-19b0-41c8-9e75-ad0b8d3f30f9'::uuid, 'c5617287-bcaa-446b-9016-3fea2ca06aeb'::uuid, '7 way change with penske', NULL, 'repair', 'normal', 'open', false, NULL, '2026-04-13 03:30:47.929077+00'::timestamptz, '2026-04-13 03:30:47.929077+00'::timestamptz),
    ('0f7ee309-e339-4d5f-a5eb-48a3688af493'::uuid, 'ffd3b47c-939f-4323-a18d-b7faaf35ce8a'::uuid, 'Check ELD', 'Make sure motive is updating correctly', 'repair', 'normal', 'done', false, '2026-03-09 20:37:24.399+00'::timestamptz, '2026-03-09 19:34:48.294281+00'::timestamptz, '2026-03-09 20:49:32.825+00'::timestamptz),
    ('11e218ee-9862-47f1-b211-67ab855480cf'::uuid, '934ebc32-5ac6-403c-b173-4e5cc0f46133'::uuid, 'Take off the new tire they put on', NULL, 'repair', 'normal', 'open', false, NULL, '2026-05-05 17:54:14.753991+00'::timestamptz, '2026-05-05 17:54:14.753991+00'::timestamptz),
    ('11fef0ca-2c68-428c-bfb3-d1e9e247b443'::uuid, '19f88c8a-662d-4fbc-809f-44a115bac4d2'::uuid, 'Leveling valve repair', NULL, 'repair', 'normal', 'open', false, NULL, '2026-05-21 15:37:19.584875+00'::timestamptz, '2026-05-21 15:37:19.584875+00'::timestamptz),
    ('1c0a4ba2-2ef2-4d58-9256-b39969385ba1'::uuid, 'f50b6002-5934-4925-92bc-9a4365ed7b94'::uuid, 'Def leak', NULL, 'repair', 'urgent', 'done', false, '2026-05-05 04:13:59.895+00'::timestamptz, '2026-04-03 14:24:00.987592+00'::timestamptz, '2026-05-05 04:13:59.895+00'::timestamptz),
    ('1c3457c7-9b64-4813-973b-c432ecbc9af1'::uuid, 'e365acd6-1c9f-427c-abf7-df2984c8007b'::uuid, 'Inside step plastic loose', NULL, 'repair', 'normal', 'open', false, NULL, '2026-04-18 19:09:24.790467+00'::timestamptz, '2026-04-18 19:09:24.790467+00'::timestamptz),
    ('2234d95a-a0aa-4d32-8def-f16f2b75663e'::uuid, '19f88c8a-662d-4fbc-809f-44a115bac4d2'::uuid, 'Install ELD', NULL, 'repair', 'normal', 'done', false, '2026-03-20 21:59:48.872+00'::timestamptz, '2026-03-09 21:14:29.991653+00'::timestamptz, '2026-03-20 21:59:48.873+00'::timestamptz),
    ('26c159a5-ebd5-416d-aeab-cf610391101f'::uuid, '19f88c8a-662d-4fbc-809f-44a115bac4d2'::uuid, 'PM annul inspection', NULL, 'repair', 'high', 'done', true, '2026-05-21 15:17:17.211+00'::timestamptz, '2026-05-19 16:05:20.93966+00'::timestamptz, '2026-05-21 15:17:17.212+00'::timestamptz),
    ('28febef9-4e79-4926-94cd-f2d149f3a139'::uuid, 'ffd3b47c-939f-4323-a18d-b7faaf35ce8a'::uuid, 'Stellar luz de cuartos trasera izquierda', NULL, 'repair', 'high', 'open', false, NULL, '2026-05-09 11:03:13.104541+00'::timestamptz, '2026-05-09 11:03:13.104541+00'::timestamptz),
    ('2ae73bf6-29e1-4666-a404-f8f1b1acbe5c'::uuid, NULL,                                                  '402648 Numbers and triangle back square reflector', NULL, 'repair', 'normal', 'open', false, NULL, '2026-04-18 19:18:44.520448+00'::timestamptz, '2026-04-18 19:18:44.520448+00'::timestamptz),
    ('329110d5-aabc-4579-b3ec-d502163597ed'::uuid, 'ffd3b47c-939f-4323-a18d-b7faaf35ce8a'::uuid, 'Cables', NULL, 'repair', 'urgent', 'open', false, NULL, '2026-04-10 22:30:29.749778+00'::timestamptz, '2026-04-10 22:30:29.749778+00'::timestamptz),
    ('33f4bad6-6d9d-4238-93f2-b79818325bf9'::uuid, 'ffd3b47c-939f-4323-a18d-b7faaf35ce8a'::uuid, 'Break light is just taped on.', NULL, 'repair', 'normal', 'open', false, NULL, '2026-04-19 23:14:59.013617+00'::timestamptz, '2026-04-19 23:14:59.013617+00'::timestamptz),
    ('35620aa4-d6e2-4bd5-9afe-89325684c8bd'::uuid, 'ffd3b47c-939f-4323-a18d-b7faaf35ce8a'::uuid, 'Rust', NULL, 'repair', 'normal', 'open', false, NULL, '2026-04-19 23:15:07.271352+00'::timestamptz, '2026-04-19 23:15:07.271352+00'::timestamptz),
    ('383044af-33f4-49cf-9c78-b9c4538d0e1d'::uuid, '71081eea-4fbc-4269-90a7-4dd36241a068'::uuid, 'Llanta gastada', NULL, 'repair', 'high', 'open', false, NULL, '2026-05-05 04:16:28.171741+00'::timestamptz, '2026-05-05 04:16:28.171741+00'::timestamptz),
    ('3b2ab355-9bb8-4f4d-94b1-16147372a249'::uuid, 'ffd3b47c-939f-4323-a18d-b7faaf35ce8a'::uuid, 'Floor has hole by foot', NULL, 'repair', 'low', 'open', false, NULL, '2026-04-04 00:05:00.145359+00'::timestamptz, '2026-04-04 00:05:00.145359+00'::timestamptz),
    ('3c8b2b5f-cd21-455e-bfa9-fce2f39aa545'::uuid, 'ffd3b47c-939f-4323-a18d-b7faaf35ce8a'::uuid, 'Break light is just taped on.', NULL, 'repair', 'normal', 'open', false, NULL, '2026-04-19 23:14:58.815347+00'::timestamptz, '2026-04-19 23:14:58.815347+00'::timestamptz),
    ('3d7b9dbc-a43c-43d3-9ed5-514a87761411'::uuid, 'ffd3b47c-939f-4323-a18d-b7faaf35ce8a'::uuid, '7way out of truck crasked', NULL, 'repair', 'high', 'open', false, NULL, '2026-04-04 00:04:28.701764+00'::timestamptz, '2026-04-08 00:16:11.091+00'::timestamptz),
    ('462c7677-a17a-46a9-9738-fd5091994cfa'::uuid, 'c61c6262-7cd3-484d-9390-6fb34e04bf2d'::uuid, 'Alighnment', NULL, 'repair', 'high', 'open', true, NULL, '2026-05-26 22:27:54.145645+00'::timestamptz, '2026-05-26 22:27:54.145645+00'::timestamptz),
    ('474ccd9b-14f8-4522-aebb-b88c09b3219e'::uuid, 'ffd3b47c-939f-4323-a18d-b7faaf35ce8a'::uuid, 'Engine air filter', NULL, 'repair', 'normal', 'open', false, NULL, '2026-04-03 14:23:15.025935+00'::timestamptz, '2026-04-03 14:23:15.025935+00'::timestamptz),
    ('49f2eed0-8048-4226-bb6f-666df3862044'::uuid, '19f88c8a-662d-4fbc-809f-44a115bac4d2'::uuid, 'Fire extinguisher install', NULL, 'repair', 'high', 'open', false, NULL, '2026-05-21 15:32:44.559686+00'::timestamptz, '2026-05-21 15:32:44.559686+00'::timestamptz),
    ('4a67567b-cd14-4a3b-bd70-7712f96c4de0'::uuid, 'ffd3b47c-939f-4323-a18d-b7faaf35ce8a'::uuid, 'Cabin air bag tilted', NULL, 'repair', 'normal', 'open', false, NULL, '2026-04-19 23:17:43.143954+00'::timestamptz, '2026-04-19 23:17:43.143954+00'::timestamptz),
    ('4b2fc814-315b-4a1b-92a7-81fb8c2caa03'::uuid, 'a9455404-880f-42dc-87fd-8ea78c23f58b'::uuid, 'Missing auto air tube', NULL, 'repair', 'normal', 'open', false, NULL, '2026-05-08 18:55:28.366455+00'::timestamptz, '2026-05-08 18:55:28.366455+00'::timestamptz),
    ('51bccab0-4107-4d88-9649-6e0a19e1d19b'::uuid, 'f50b6002-5934-4925-92bc-9a4365ed7b94'::uuid, 'Air leak', NULL, 'repair', 'high', 'open', false, NULL, '2026-04-23 04:14:20.261831+00'::timestamptz, '2026-04-23 04:14:20.261831+00'::timestamptz),
    ('587ee18a-3252-4433-92d5-b1d0d5dfc7c0'::uuid, 'ffd3b47c-939f-4323-a18d-b7faaf35ce8a'::uuid, 'Check the breaks', NULL, 'repair', 'normal', 'open', false, NULL, '2026-05-18 06:58:36.553292+00'::timestamptz, '2026-05-18 06:58:36.553292+00'::timestamptz),
    ('5e7b5c51-1cbc-4ed7-b9f8-7942b808f569'::uuid, 'ffd3b47c-939f-4323-a18d-b7faaf35ce8a'::uuid, 'Coolant level high', NULL, 'repair', 'urgent', 'open', false, NULL, '2026-04-04 00:02:09.303688+00'::timestamptz, '2026-04-04 00:02:09.303688+00'::timestamptz),
    ('64cc6561-adcf-4b7a-87d6-ed9372db5bbe'::uuid, 'ffd3b47c-939f-4323-a18d-b7faaf35ce8a'::uuid, 'Passenger light doesnt work', NULL, 'repair', 'normal', 'in_progress', false, NULL, '2026-04-02 19:51:37.524507+00'::timestamptz, '2026-04-07 20:29:52.551+00'::timestamptz),
    ('6a5ddf9d-07a6-4f75-aef9-b4b718cae162'::uuid, 'c61c6262-7cd3-484d-9390-6fb34e04bf2d'::uuid, 'Driver Report — Truck #2023', E'Llantas delanteras desgastadas pendiente alineación \nPuerto de carga para el celular no funciona', 'repair', 'normal', 'open', false, NULL, '2026-05-02 03:26:36.990367+00'::timestamptz, '2026-05-02 03:26:36.990367+00'::timestamptz),
    ('7064f75f-e555-4740-9f53-3531f53b6f8d'::uuid, 'e365acd6-1c9f-427c-abf7-df2984c8007b'::uuid, 'Check ELD', NULL, 'repair', 'normal', 'done', false, '2026-03-09 19:36:10.621+00'::timestamptz, '2026-03-09 19:35:39.095116+00'::timestamptz, '2026-03-09 19:36:10.621+00'::timestamptz),
    ('7112661d-1c42-4ef4-9fab-e5260aa23fc3'::uuid, '19f88c8a-662d-4fbc-809f-44a115bac4d2'::uuid, 'Air dryer Change', NULL, 'repair', 'normal', 'open', false, NULL, '2026-05-21 15:36:21.58691+00'::timestamptz, '2026-05-21 15:36:21.58691+00'::timestamptz),
    ('7208c348-9590-4c3f-a6b1-e970e4bee17d'::uuid, 'dc10ea36-084b-4ede-a265-363c70977f22'::uuid, 'Parchar llanta', 'Eje delantero, lado del pasajero, interior', 'repair', 'high', 'open', false, NULL, '2026-05-09 10:45:30.468823+00'::timestamptz, '2026-05-09 10:45:30.468823+00'::timestamptz),
    ('72bfc22f-9fea-47ae-8775-af0248f780dd'::uuid, 'ffd3b47c-939f-4323-a18d-b7faaf35ce8a'::uuid, 'Windshield wipper fluid', NULL, 'repair', 'low', 'open', false, NULL, '2026-05-09 11:06:17.305665+00'::timestamptz, '2026-05-09 11:06:17.305665+00'::timestamptz),
    ('73a5ef22-cbbc-437b-933e-a58bac49ad22'::uuid, '19f88c8a-662d-4fbc-809f-44a115bac4d2'::uuid, 'Fix Air', 'fix air hose', 'repair', 'normal', 'done', false, '2026-04-03 03:02:28.714+00'::timestamptz, '2026-04-02 17:22:51.145273+00'::timestamptz, '2026-04-03 03:02:28.714+00'::timestamptz),
    ('771795d0-5d4f-429c-a62c-5d6e09c80abf'::uuid, '19f88c8a-662d-4fbc-809f-44a115bac4d2'::uuid, 'Steering tire hub oil plugs', NULL, 'repair', 'normal', 'open', false, NULL, '2026-05-21 15:40:15.710174+00'::timestamptz, '2026-05-21 15:40:15.710174+00'::timestamptz),
    ('7dbe08dd-4f4a-4db8-86ad-448d58d98ea9'::uuid, '75ee9206-f912-42b3-beac-71cec6bae969'::uuid, 'Driver Report — Truck #412863', 'Tiene problemas con la dirección se va mucho hacia el lado derecho y al parecer está malo el amortiguador delantero izquierdo  y l camión se siente caído hacia ese lado', 'repair', 'normal', 'open', false, NULL, '2026-04-10 16:55:57.626186+00'::timestamptz, '2026-04-10 16:55:57.626186+00'::timestamptz),
    ('7de195b9-e2a7-4b56-9e3f-9892e1d23b03'::uuid, 'c61c6262-7cd3-484d-9390-6fb34e04bf2d'::uuid, 'Transmission problem', NULL, 'repair', 'high', 'open', false, NULL, '2026-05-22 21:22:15.240083+00'::timestamptz, '2026-05-22 21:22:15.240083+00'::timestamptz),
    ('7f4e39de-feae-4633-a966-3fccee38e35a'::uuid, '19f88c8a-662d-4fbc-809f-44a115bac4d2'::uuid, 'Truck recalerbration relearn', NULL, 'repair', 'urgent', 'open', false, NULL, '2026-04-04 06:57:35.817783+00'::timestamptz, '2026-04-07 20:10:13.929+00'::timestamptz),
    ('857d9959-adfc-47f6-8b8e-37ce05d21040'::uuid, 'ffd3b47c-939f-4323-a18d-b7faaf35ce8a'::uuid, 'Gender driver side broken', NULL, 'repair', 'normal', 'open', false, NULL, '2026-05-09 11:00:36.316179+00'::timestamptz, '2026-05-09 11:00:36.316179+00'::timestamptz),
    ('87763c62-00e1-440b-998d-97602ad04ff7'::uuid, '19f88c8a-662d-4fbc-809f-44a115bac4d2'::uuid, '5th wheel ajustment', NULL, 'repair', 'normal', 'open', false, NULL, '2026-05-21 15:42:13.569574+00'::timestamptz, '2026-05-21 15:42:13.569574+00'::timestamptz),
    ('8791ba98-b410-4d8f-8382-5febadb0608b'::uuid, 'eb01201c-afc9-4e5f-bd4a-c55dce62fc34'::uuid, 'Golpe de Ring lateral derecho', NULL, 'repair', 'normal', 'open', false, NULL, '2026-05-18 06:57:40.558736+00'::timestamptz, '2026-05-18 06:57:40.558736+00'::timestamptz),
    ('947418c9-a19f-4f61-98e8-bbd563d3c663'::uuid, 'f4d69b33-5198-4dfd-b2c9-062396877930'::uuid, 'Uneven wear on tires passenger side', NULL, 'repair', 'high', 'open', false, NULL, '2026-04-13 03:26:48.650613+00'::timestamptz, '2026-04-13 03:26:48.650613+00'::timestamptz),
    ('95be6901-719d-44a8-a68e-04ce9e0a282d'::uuid, 'c61c6262-7cd3-484d-9390-6fb34e04bf2d'::uuid, 'Battery fix terminals', NULL, 'repair', 'high', 'done', false, '2026-05-05 04:13:11.67+00'::timestamptz, '2026-04-24 20:51:47.318392+00'::timestamptz, '2026-05-05 04:13:11.67+00'::timestamptz),
    ('9b455403-9e88-4434-813b-0dfb1a8b52d0'::uuid, 'c61c6262-7cd3-484d-9390-6fb34e04bf2d'::uuid, 'Steer tires', NULL, 'repair', 'normal', 'open', false, NULL, '2026-04-03 03:01:22.085478+00'::timestamptz, '2026-04-03 03:01:22.085478+00'::timestamptz),
    ('9b9424bf-a6be-4393-a287-e818809a6a98'::uuid, 'a109c005-a4f7-4d5d-8aca-d6c314f4fc6d'::uuid, 'Side Skirt broken', NULL, 'repair', 'normal', 'open', false, NULL, '2026-04-02 22:23:23.47819+00'::timestamptz, '2026-04-02 22:23:23.47819+00'::timestamptz),
    ('9ce06dc2-3095-4d4e-b54d-1c1275248f87'::uuid, NULL,                                                  'Glad hand passenger side need support', NULL, 'repair', 'normal', 'open', false, NULL, '2026-04-13 03:49:52.034761+00'::timestamptz, '2026-04-13 03:49:52.034761+00'::timestamptz),
    ('9dc93f7d-a79f-44ec-a170-40602cd3bb67'::uuid, 'c61c6262-7cd3-484d-9390-6fb34e04bf2d'::uuid, 'Charging cable inside cab doesn’t work', NULL, 'repair', 'normal', 'open', false, NULL, '2026-05-05 04:11:56.563907+00'::timestamptz, '2026-05-05 04:11:56.563907+00'::timestamptz),
    ('a0e4a878-3535-412b-b464-32d3a7ecc33d'::uuid, 'c61c6262-7cd3-484d-9390-6fb34e04bf2d'::uuid, 'Subir velocidad', NULL, 'repair', 'normal', 'open', false, NULL, '2026-05-05 04:22:13.574319+00'::timestamptz, '2026-05-05 04:22:13.574319+00'::timestamptz),
    ('a2846168-d6a8-4424-95b9-111819d05ecb'::uuid, '19f88c8a-662d-4fbc-809f-44a115bac4d2'::uuid, 'Move lisense plate so not covering radiator', NULL, 'repair', 'normal', 'open', false, NULL, '2026-04-13 03:11:12.684138+00'::timestamptz, '2026-04-13 03:11:12.684138+00'::timestamptz),
    ('a42138dd-fdd9-41ca-8db0-924cf6a94b28'::uuid, '19f88c8a-662d-4fbc-809f-44a115bac4d2'::uuid, 'Fire extinguisher install', NULL, 'repair', 'high', 'open', false, NULL, '2026-05-21 15:32:44.226417+00'::timestamptz, '2026-05-21 15:32:44.226417+00'::timestamptz),
    ('a5aa79a0-8a23-4fc8-8bf0-83d59c7a99fa'::uuid, 'f4d69b33-5198-4dfd-b2c9-062396877930'::uuid, 'Air leak', NULL, 'repair', 'normal', 'open', false, NULL, '2026-05-02 18:46:56.851155+00'::timestamptz, '2026-05-02 18:46:56.851155+00'::timestamptz),
    ('a89fe0a0-48ca-40dc-b21e-3ed7a64f7751'::uuid, '2fd1def8-c537-4f90-a794-e05d21dadce7'::uuid, 'Scatch', 'Statch on left side trailer', 'inspection', 'normal', 'open', false, NULL, '2026-04-02 22:35:48.97053+00'::timestamptz, '2026-04-02 22:35:48.97053+00'::timestamptz),
    ('ac500d24-3c78-46ac-9f4f-6ef64823d16b'::uuid, 'e365acd6-1c9f-427c-abf7-df2984c8007b'::uuid, 'Hub oil and cap', NULL, 'repair', 'normal', 'open', false, NULL, '2026-04-18 19:11:48.480419+00'::timestamptz, '2026-04-18 19:11:48.480419+00'::timestamptz),
    ('af2e1012-a867-4ff1-908a-4139d77b6530'::uuid, '14595de0-69a9-4be2-b850-4ffa6d5c3259'::uuid, 'Mud flap', NULL, 'repair', 'high', 'done', false, '2026-05-17 06:13:02.047+00'::timestamptz, '2026-05-08 02:31:30.231924+00'::timestamptz, '2026-05-17 06:13:02.047+00'::timestamptz),
    ('b17259c3-687e-4e2f-a7a0-20b118d8754d'::uuid, 'ffd3b47c-939f-4323-a18d-b7faaf35ce8a'::uuid, 'Wiper blades bad', NULL, 'repair', 'normal', 'open', false, NULL, '2026-04-04 00:05:50.568968+00'::timestamptz, '2026-04-04 00:05:50.568968+00'::timestamptz),
    ('b2120965-1052-4599-937f-69849c6dbf89'::uuid, '19f88c8a-662d-4fbc-809f-44a115bac4d2'::uuid, 'Windsheild repair', NULL, 'repair', 'high', 'open', false, NULL, '2026-05-21 15:31:32.509962+00'::timestamptz, '2026-05-21 15:31:32.509962+00'::timestamptz),
    ('b5c1d1d0-8dc1-4688-b95d-a848e788b9b6'::uuid, '75ee9206-f912-42b3-beac-71cec6bae969'::uuid, '5th wheel locking jaw', NULL, 'repair', 'urgent', 'open', false, NULL, '2026-04-03 01:48:54.386539+00'::timestamptz, '2026-04-03 01:48:54.386539+00'::timestamptz),
    ('b6a40c78-14c0-405c-9aaf-38fd53702f71'::uuid, 'e365acd6-1c9f-427c-abf7-df2984c8007b'::uuid, 'Air dryer. Radiator cap. Injector seals. Air fitting on trans', E'BOTH HOOD MIRROR GLASS ARE LOOSE, STAGE 2 ENGINE OIL LEAK AT ENGINE OIL PAN SEAL, AIR LEAK FROM\nAIR FITTING ON TRANS AIR TANK, INJECTOR PASS THROUGH SEAL #2 & #4 LEAKING FAILED, RECOMMEND AIR DRYER CART IF IT HAS NOT DONE IN THE PAST YEAR.', 'repair', 'normal', 'open', false, NULL, '2026-04-03 14:21:25.105343+00'::timestamptz, '2026-04-03 14:21:25.105343+00'::timestamptz),
    ('b6d549d5-49fd-4db9-8da9-d20c94d1db72'::uuid, 'c61c6262-7cd3-484d-9390-6fb34e04bf2d'::uuid, 'Alignment steer', NULL, 'repair', 'normal', 'open', false, NULL, '2026-04-03 14:24:39.329889+00'::timestamptz, '2026-04-03 14:24:39.329889+00'::timestamptz),
    ('be80612a-6cba-4fe9-9b56-e1a015a434e2'::uuid, 'e9c95c41-58d6-47ac-be8c-5df579dd0e89'::uuid, 'Mudflap crooked', NULL, 'repair', 'normal', 'open', false, NULL, '2026-05-05 04:26:06.346042+00'::timestamptz, '2026-05-05 04:26:06.346042+00'::timestamptz),
    ('c49812d7-5660-4622-93bd-5744e6a1a5bb'::uuid, '2b532090-95a3-48c5-9353-3ee8fda91f4d'::uuid, 'Red glad hand liqueo aire', NULL, 'repair', 'high', 'open', false, NULL, '2026-05-18 07:01:02.060128+00'::timestamptz, '2026-05-18 07:01:02.060128+00'::timestamptz),
    ('c6976045-2b53-4bae-8357-b9f5cfb53f46'::uuid, 'ffd3b47c-939f-4323-a18d-b7faaf35ce8a'::uuid, 'Heat shield on hood falling', NULL, 'repair', 'normal', 'open', false, NULL, '2026-04-04 00:02:41.317943+00'::timestamptz, '2026-04-04 00:02:41.317943+00'::timestamptz),
    ('d0d62e7c-043c-4555-8660-e57920cf717d'::uuid, 'e365acd6-1c9f-427c-abf7-df2984c8007b'::uuid, 'Left side steering is off', NULL, 'repair', 'normal', 'open', false, NULL, '2026-04-30 18:09:03.878551+00'::timestamptz, '2026-04-30 18:09:03.878551+00'::timestamptz),
    ('d572c4c6-7700-4b8d-b2f6-19571e98ca50'::uuid, 'eb01201c-afc9-4e5f-bd4a-c55dce62fc34'::uuid, 'Parchar llanta', 'Eje delantero, lado del pasajero, interior', 'repair', 'high', 'open', false, NULL, '2026-05-09 10:46:14.915801+00'::timestamptz, '2026-05-09 10:46:14.915801+00'::timestamptz),
    ('d5f140de-2d28-4b26-8261-ccbfa3bfb789'::uuid, 'fcd359f6-79b8-4c6a-ac13-1827c57a5ced'::uuid, 'Check ELD', NULL, 'repair', 'high', 'done', false, '2026-03-09 19:35:15.314+00'::timestamptz, '2026-03-09 19:35:01.451032+00'::timestamptz, '2026-03-09 19:35:15.315+00'::timestamptz),
    ('d6276a52-19b1-4f27-bcb1-238464e22818'::uuid, 'ffd3b47c-939f-4323-a18d-b7faaf35ce8a'::uuid, 'BUY Cabin shock broken. And frame suport', NULL, 'repair', 'normal', 'open', false, NULL, '2026-04-19 23:20:34.244108+00'::timestamptz, '2026-04-19 23:20:34.244108+00'::timestamptz),
    ('d87aa09a-4ef4-447f-aa9e-448feaca441a'::uuid, 'f4d69b33-5198-4dfd-b2c9-062396877930'::uuid, 'Truck shuts down', NULL, 'repair', 'urgent', 'open', false, NULL, '2026-05-05 04:19:48.528463+00'::timestamptz, '2026-05-05 04:19:48.528463+00'::timestamptz),
    ('d8908c05-3dab-44f0-a35a-6274a306ae92'::uuid, 'ffd3b47c-939f-4323-a18d-b7faaf35ce8a'::uuid, 'Change Light', 'changed light', 'repair', 'normal', 'done', false, '2026-04-02 17:21:11.044+00'::timestamptz, '2026-04-02 17:21:04.923338+00'::timestamptz, '2026-04-02 17:21:11.044+00'::timestamptz),
    ('d97f7a4a-263f-4a97-a569-a64d922d006d'::uuid, '71081eea-4fbc-4269-90a7-4dd36241a068'::uuid, 'Hole in floor', NULL, 'repair', 'high', 'done', false, '2026-05-17 06:06:44.132+00'::timestamptz, '2026-05-05 04:15:54.90969+00'::timestamptz, '2026-05-17 06:06:44.132+00'::timestamptz),
    ('da491542-4b5f-4ba7-ad35-9987605f5c1d'::uuid, '19f88c8a-662d-4fbc-809f-44a115bac4d2'::uuid, 'Power steering Service', NULL, 'repair', 'normal', 'open', false, NULL, '2026-05-21 15:35:40.867319+00'::timestamptz, '2026-05-21 15:35:40.867319+00'::timestamptz),
    ('dc23922e-7117-4a0f-a419-081fbc93544b'::uuid, 'ffd3b47c-939f-4323-a18d-b7faaf35ce8a'::uuid, '5th wheel spring', NULL, 'repair', 'normal', 'open', false, NULL, '2026-04-19 22:53:38.966039+00'::timestamptz, '2026-04-19 22:53:38.966039+00'::timestamptz),
    ('e266e348-84f3-4686-8b2a-f1e2e837dc81'::uuid, '19f88c8a-662d-4fbc-809f-44a115bac4d2'::uuid, 'PM annul inspection', NULL, 'repair', 'high', 'done', true, '2026-05-21 15:17:20.65+00'::timestamptz, '2026-05-19 16:05:22.705374+00'::timestamptz, '2026-05-21 15:17:20.65+00'::timestamptz),
    ('e40e01fe-fffe-43db-bf88-f9fe4d900c25'::uuid, 'c61c6262-7cd3-484d-9390-6fb34e04bf2d'::uuid, 'Alighnment', NULL, 'repair', 'high', 'open', true, NULL, '2026-05-26 22:27:51.916764+00'::timestamptz, '2026-05-26 22:27:51.916764+00'::timestamptz),
    ('e6164c96-f0a1-4a9c-a82e-a3fc64ffc543'::uuid, 'c88631af-bccf-440a-a540-fc505414d910'::uuid, 'Write curzon on ifta sticker', NULL, 'repair', 'normal', 'open', false, NULL, '2026-04-25 00:37:39.747929+00'::timestamptz, '2026-04-25 00:37:39.747929+00'::timestamptz),
    ('e8e7e784-6e61-4360-82a7-8e07d8c37c6b'::uuid, 'c61c6262-7cd3-484d-9390-6fb34e04bf2d'::uuid, 'Oil change', NULL, 'repair', 'normal', 'open', false, NULL, '2026-05-05 04:22:44.658774+00'::timestamptz, '2026-05-05 04:22:44.658774+00'::timestamptz),
    ('ed1428e4-cc6f-4e5f-b837-a34e1fb5cbd2'::uuid, '14595de0-69a9-4be2-b850-4ffa6d5c3259'::uuid, 'No tiene Mudflap', NULL, 'repair', 'high', 'done', false, '2026-05-17 06:06:32.01+00'::timestamptz, '2026-05-05 04:18:25.582659+00'::timestamptz, '2026-05-17 06:06:32.011+00'::timestamptz),
    ('ed5128be-d15f-4c20-aa3c-573395374cec'::uuid, 'f4d69b33-5198-4dfd-b2c9-062396877930'::uuid, 'Problema con SCR', NULL, 'repair', 'normal', 'open', false, NULL, '2026-05-18 07:01:53.696079+00'::timestamptz, '2026-05-18 07:01:53.696079+00'::timestamptz),
    ('f0fe9c3b-5b43-4228-a536-03bb8dcbffc1'::uuid, '19f88c8a-662d-4fbc-809f-44a115bac4d2'::uuid, 'Wipers install', NULL, 'repair', 'high', 'open', false, NULL, '2026-05-21 15:41:09.389318+00'::timestamptz, '2026-05-21 15:41:09.389318+00'::timestamptz),
    ('f2e39f09-bc53-4f30-b003-d5a0ffbf5299'::uuid, 'e365acd6-1c9f-427c-abf7-df2984c8007b'::uuid, 'Bumper', NULL, 'repair', 'normal', 'open', false, NULL, '2026-04-18 19:03:45.142556+00'::timestamptz, '2026-04-18 19:03:45.142556+00'::timestamptz),
    ('f39a6df1-ef96-4062-8412-95e4f272058a'::uuid, '451152b5-f1da-4bf8-b781-574c9135dede'::uuid, 'Air leak by axle', NULL, 'repair', 'normal', 'open', false, NULL, '2026-04-20 01:44:56.087611+00'::timestamptz, '2026-04-20 01:44:56.087611+00'::timestamptz),
    ('f7b37211-cf6d-4e79-9cf1-5265f75ac089'::uuid, 'e365acd6-1c9f-427c-abf7-df2984c8007b'::uuid, 'Air leak', NULL, 'repair', 'normal', 'open', false, NULL, '2026-04-18 19:08:06.114592+00'::timestamptz, '2026-04-18 19:08:06.114592+00'::timestamptz),
    ('fe37c3e2-f89e-4f8e-982b-f8cc1f832068'::uuid, 'e365acd6-1c9f-427c-abf7-df2984c8007b'::uuid, 'Battery suport', NULL, 'repair', 'normal', 'open', false, NULL, '2026-04-18 19:04:10.733353+00'::timestamptz, '2026-04-18 19:04:10.733353+00'::timestamptz),
    ('ffbb266a-d151-4558-9683-f449671ed19e'::uuid, 'c61c6262-7cd3-484d-9390-6fb34e04bf2d'::uuid, 'Speed limit to 70', NULL, 'repair', 'normal', 'open', false, NULL, '2026-04-08 22:55:01.73281+00'::timestamptz, '2026-04-08 22:55:01.73281+00'::timestamptz)
)

-- ── Step 3: insert into the new table ────────────────────────────────
INSERT INTO maintenance_action_items (
  org_id, asset_id, trailer_id, title, description, category, priority,
  status, out_of_service, completed_at, created_by, created_at, updated_at
)
SELECT
  'org_3Cgzom31hVxbq6WR3FjVTbL6K3t',
  l.asset_id,
  l.trailer_id,
  w.title,
  -- Append a migration tag so re-runs can dedupe via the WHERE NOT
  -- EXISTS below, and so you can find/strip them later via SQL.
  CASE
    WHEN w.description IS NULL OR w.description = '' THEN '[migrated-from ' || w.old_id::text || ']'
    ELSE w.description || E'\n\n[migrated-from ' || w.old_id::text || ']'
  END,
  w.category,
  w.priority,
  w.status,
  w.oos,
  w.completed_at,
  'imported',
  w.created_at,
  w.updated_at
FROM old_work_orders w
LEFT JOIN asset_map l ON l.old_uuid = w.old_asset_uuid
WHERE NOT EXISTS (
  SELECT 1
  FROM maintenance_action_items existing
  WHERE existing.org_id = 'org_3Cgzom31hVxbq6WR3FjVTbL6K3t'
    AND existing.description LIKE '%[migrated-from ' || w.old_id::text || ']%'
);

-- ── Optional sanity check — run after the INSERT to verify ──────────
-- Expected counts:
--   imported: 85 (or fewer on re-run if some already existed)
--   with asset_id set:     ~63
--   with trailer_id set:   ~16
--   both null (no equip):  ~2  (the 2 rows that had no asset in source)
SELECT
  count(*) FILTER (WHERE description LIKE '%[migrated-from %')                                         AS migrated_total,
  count(*) FILTER (WHERE description LIKE '%[migrated-from %' AND asset_id   IS NOT NULL)              AS to_truck,
  count(*) FILTER (WHERE description LIKE '%[migrated-from %' AND trailer_id IS NOT NULL)              AS to_trailer,
  count(*) FILTER (WHERE description LIKE '%[migrated-from %' AND asset_id IS NULL AND trailer_id IS NULL) AS to_neither
FROM maintenance_action_items
WHERE org_id = 'org_3Cgzom31hVxbq6WR3FjVTbL6K3t';
