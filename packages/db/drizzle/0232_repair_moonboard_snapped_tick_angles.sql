-- Custom SQL migration file, put your code below! --
--
-- Repairs the 55 MoonBoard ticks proven by the production
-- `MoonBoard Tick Angle Snapped` telemetry emitted between the deployment that
-- introduced catalog-angle snapping (2026-08-13 08:53:10 UTC) and the backend
-- deployment that removed it (2026-09-18 11:02:05 UTC).
--
-- Audit result:
--   * 56 production snap events, all requested 25 -> effective 40.
--   * 55 rows are safe to repair by exact tick UUID.
--   * 1 row is deliberately excluded because PostHog recorded a later
--     `Logbook Entry Edited` event at its later database update timestamp.
--   * 0 included events were ambiguous and 0 included ticks have beta links at
--     audit time. Beta links are still moved defensively if one is attached
--     before this migration runs.
--
-- Every tick is fenced by UUID, climb UUID, current angle and the exact
-- production updated_at observed during the audit. Any intervening edit aborts
-- the entire migration before a partial repair can commit.

CREATE TEMP TABLE _moonboard_snapped_angle_repairs (
  tick_uuid text PRIMARY KEY,
  climb_uuid text NOT NULL,
  expected_updated_at timestamp without time zone NOT NULL,
  from_angle integer NOT NULL,
  to_angle integer NOT NULL
) ON COMMIT DROP;

INSERT INTO _moonboard_snapped_angle_repairs
  (tick_uuid, climb_uuid, expected_updated_at, from_angle, to_angle)
VALUES
  ('08042ac8-59ce-4af2-af76-1d78b20c6f1d', 'c191011b-ebdb-5894-823c-7aec191d4fcb', '2026-09-02 22:51:07.268000'::timestamp, 40, 25),
  ('1547d024-d25a-4d61-ab52-3aa58ec0e09b', 'ffd01b0c-9fda-5530-b2fa-df74cbc78318', '2026-09-14 23:02:54.974000'::timestamp, 40, 25),
  ('1883425e-11bd-4ea2-8da7-7692bdb36784', 'ffd01b0c-9fda-5530-b2fa-df74cbc78318', '2026-09-14 23:00:44.642000'::timestamp, 40, 25),
  ('2028567e-441b-4ed9-9d01-3d123140957e', 'eece8f90-fb2d-5bc0-af50-8954aa770c02', '2026-08-24 11:10:02.246000'::timestamp, 40, 25),
  ('28c68e16-679f-4d64-ac0f-594ce520e9fa', 'c191011b-ebdb-5894-823c-7aec191d4fcb', '2026-09-14 23:25:05.055000'::timestamp, 40, 25),
  ('2a9382b0-6fae-4795-994a-e316ec09ff40', 'fffaff63-a59d-5357-ab01-0cd0548d6a18', '2026-09-17 22:37:45.694926'::timestamp, 40, 25),
  ('36c79f62-bf6f-4faa-9770-cc5bf497c80b', 'ffb11e6e-2a8a-5dfe-8aaf-51ed7e3e1e78', '2026-09-02 22:54:03.379000'::timestamp, 40, 25),
  ('3e720c5f-a191-449c-8399-e8310e546074', '8a1e2f61-c945-5756-a9c2-9984ba1d95c3', '2026-09-14 23:38:24.009000'::timestamp, 40, 25),
  ('43b8d761-7533-4696-8a5a-e86e42f42a00', 'ffe0a22d-113f-57a6-b5db-957fb320943a', '2026-09-14 22:57:05.998000'::timestamp, 40, 25),
  ('4f2cdc2c-0d23-4ad6-9a81-eed5a0aad465', 'fffab0f9-a7a2-5d09-a930-b3183a64f479', '2026-09-17 22:37:45.694926'::timestamp, 40, 25),
  ('59173bdf-f923-4e36-914b-b713da94d7e8', 'fdc6d6f6-9f43-5698-8dd6-3ea56485b392', '2026-09-17 23:50:05.855000'::timestamp, 40, 25),
  ('5f19f6f2-afff-436e-95f6-187e80976614', 'ff907984-16f0-51cf-859e-fa533e081019', '2026-09-14 23:14:35.410000'::timestamp, 40, 25),
  ('63d09704-e0ca-4fa8-aa59-ca853ed691cd', '74c418e2-d33a-5121-9aec-98f576139078', '2026-09-07 12:41:17.949000'::timestamp, 40, 25),
  ('650afe9e-f35f-4f70-9e1a-9f1a11637e10', 'ff66a020-a5e0-5612-a235-fca4cc17dda2', '2026-09-17 23:12:37.949000'::timestamp, 40, 25),
  ('74513ac0-28d9-40bc-8933-2ddfd5398e88', 'ffc59685-6f0b-5d47-9095-4d78300b7b9f', '2026-09-17 22:45:51.401000'::timestamp, 40, 25),
  ('7841670d-568d-4e0f-a3e5-a501c6fce99c', 'b94ba262-4635-5672-adf9-891b5e0c7ac1', '2026-09-07 02:35:43.804142'::timestamp, 40, 25),
  ('7a9e0cc9-98ee-4af4-9e1d-973f4894ddc4', '87b52f96-bfd4-5a29-bb9b-89428fecbbe1', '2026-08-24 10:53:12.480000'::timestamp, 40, 25),
  ('7d409410-904d-4237-9772-051b9131d3c5', 'ffea179b-2f4f-5e8b-bf40-e3ceb90d4bf9', '2026-09-17 22:37:45.670000'::timestamp, 40, 25),
  ('801e1d3e-a722-4c35-982e-01b264f83a4c', 'fea60335-737b-56b6-b987-f78b04495d7a', '2026-09-17 23:19:13.107000'::timestamp, 40, 25),
  ('820a0f79-66c1-4280-881b-1f28c87b343e', '8a1e2f61-c945-5756-a9c2-9984ba1d95c3', '2026-09-07 02:35:43.804142'::timestamp, 40, 25),
  ('87bab5a6-c000-43b4-b6d2-65f55fd0652a', '5f9678f0-8287-5d66-b92d-ac7749a248f5', '2026-09-07 02:35:43.804142'::timestamp, 40, 25),
  ('88887193-9a8f-4495-8984-3a001a75140c', 'ffb11e6e-2a8a-5dfe-8aaf-51ed7e3e1e78', '2026-09-14 23:10:31.367000'::timestamp, 40, 25),
  ('90b0d1e6-92ba-4333-8858-a79aaac5283c', '95bc0dae-0ea3-59f3-9e70-af7ddf7b787f', '2026-08-24 11:30:39.640000'::timestamp, 40, 25),
  ('9162e555-bf47-461b-95af-b274202c3898', 'fe1c9bbc-5f02-5b8a-9640-853be3dea3ba', '2026-09-17 23:47:08.357000'::timestamp, 40, 25),
  ('9a5d0dc4-4ab4-44ea-aaef-ea0d74bc3385', 'ded6dae6-5e5a-5b1e-8350-34426ef15e8e', '2026-09-07 04:01:11.114041'::timestamp, 40, 25),
  ('9e436d38-dd48-4552-a1b1-4e921971ddf9', 'ff0baa1f-30ab-5c68-aa54-ec5b42ca8c4a', '2026-09-17 23:16:23.565000'::timestamp, 40, 25),
  ('a0518ee3-9321-4641-852b-285d6061b315', 'fff8f605-12bd-5df1-9d39-746e80666163', '2026-09-17 22:37:45.694926'::timestamp, 40, 25),
  ('a492075f-32ec-416b-872e-6465d51408ab', '56d6e161-e9ab-54bb-b5b6-7479a9a5ccec', '2026-08-24 10:43:55.839000'::timestamp, 40, 25),
  ('a630ff61-026e-4125-8343-71dc47535221', '66c873cc-725d-5bbe-88bd-3113c80cf983', '2026-09-07 02:35:43.804142'::timestamp, 40, 25),
  ('a8c26cd6-fc23-45e4-862c-acf98e1800a7', 'fd76e408-9d2f-5267-92af-9cae33037bb8', '2026-09-18 00:05:45.488000'::timestamp, 40, 25),
  ('aa7d0283-1657-40a7-b37a-f9e86a012eb5', 'fa3327a3-fc85-5472-8500-12927b766ee0', '2026-09-18 00:17:20.874000'::timestamp, 40, 25),
  ('ab62d45c-1a6d-478f-83ec-11879292683f', 'ffc6e690-1644-5fa1-abb6-6d5ab691da4d', '2026-09-14 23:07:02.365000'::timestamp, 40, 25),
  ('adecda60-35e9-47b2-b9ed-35828301c7ea', 'ffe0a22d-113f-57a6-b5db-957fb320943a', '2026-09-14 23:02:54.993622'::timestamp, 40, 25),
  ('b1359b2d-f61b-4c71-931b-593e584c6876', '1b5238b9-be3b-52e8-9c10-e9d2d556c6ec', '2026-09-07 02:35:43.804142'::timestamp, 40, 25),
  ('b23e43d2-9542-44a7-9cd8-46d9277d0391', '2cf01d38-3f35-544c-a9e2-457ccda5e35f', '2026-09-02 22:51:46.408000'::timestamp, 40, 25),
  ('b66819f0-cb32-42a0-85b5-c46e68e6f9d5', 'fdba0210-f0ce-5975-b85d-62a5d741596e', '2026-09-17 23:53:40.430000'::timestamp, 40, 25),
  ('ba13065c-5a56-4897-981a-ef990cefcda8', 'ffb11e6e-2a8a-5dfe-8aaf-51ed7e3e1e78', '2026-09-14 23:10:46.361000'::timestamp, 40, 25),
  ('bc282a1f-1f3a-499e-a302-8d881a5099c9', 'ffca940a-1aeb-51a5-bd43-7a240382f6ce', '2026-09-14 23:04:55.408000'::timestamp, 40, 25),
  ('bfdcb30a-01aa-4170-8f8a-92d59c6e8101', '3dc9ae1c-62bc-5c4e-ad4a-451c1abd2672', '2026-08-24 11:38:56.981000'::timestamp, 40, 25),
  ('c482fa20-58a3-4ea4-bd29-b346a74c246b', 'ffcabc78-5aa7-54ba-81bb-996b21eb3743', '2026-09-14 23:06:51.251000'::timestamp, 40, 25),
  ('ca2d1e07-0854-4807-89f7-a8c5f068ddee', 'fb563532-4ad6-5d14-b6d9-228bd6198aa0', '2026-09-18 00:13:47.456000'::timestamp, 40, 25),
  ('d161861c-728f-4c4d-9f57-eb29b2615b09', 'ffeb4691-03da-5182-b72a-af97f1159f1a', '2026-09-17 22:42:24.464000'::timestamp, 40, 25),
  ('d26f455a-d3d9-4649-9d70-9e7d7a5c4568', 'fecae050-c6cb-5729-ab59-5715d5768563', '2026-09-17 23:24:10.504000'::timestamp, 40, 25),
  ('d3ce0569-fcaf-4da2-926f-d1f7bfe28106', '561b2374-1eba-5b31-9873-45346d04e7ed', '2026-09-02 22:53:15.149000'::timestamp, 40, 25),
  ('d5b510e4-82fb-4e35-96f1-0605302afe10', 'fed45a3e-60ed-5fff-9737-bf11e66e9d3f', '2026-09-18 00:30:24.166000'::timestamp, 40, 25),
  ('dd0a0b95-3d12-4fb2-a873-e9c14e0e3b15', 'ff907984-16f0-51cf-859e-fa533e081019', '2026-09-17 22:47:20.578000'::timestamp, 40, 25),
  ('e2a2e343-d1d9-4c17-8816-1636c60a1493', '62fd0c04-b7ce-5283-bedc-2014739e3691', '2026-09-02 22:52:29.426000'::timestamp, 40, 25),
  ('e8103b1d-df1e-4f41-ae38-c7cef44474bd', 'ffc6e690-1644-5fa1-abb6-6d5ab691da4d', '2026-09-14 23:07:21.621000'::timestamp, 40, 25),
  ('e8efccdb-a450-4fd7-888a-4f8d2434f6e8', 'c7b1fce5-09db-5cef-a967-78dacbe6e3fd', '2026-08-24 11:49:26.337000'::timestamp, 40, 25),
  ('f1a85f87-9266-49ca-823f-55690185f6be', 'fe856376-2e42-5519-83fd-d03649e0f51f', '2026-09-18 00:33:26.914000'::timestamp, 40, 25),
  ('f26d36bb-12cc-4c90-813d-6d3fb7a4779c', 'feea7a5a-2611-5f85-8333-f1d8868769a0', '2026-09-18 00:27:09.109000'::timestamp, 40, 25),
  ('f29a9c4d-09f0-42c8-b378-3bdff65179cd', 'ffcabc78-5aa7-54ba-81bb-996b21eb3743', '2026-09-14 23:02:16.945000'::timestamp, 40, 25),
  ('fb08d3b2-ff73-4c3e-bd55-42d1aed3f80d', 'c191011b-ebdb-5894-823c-7aec191d4fcb', '2026-09-07 02:35:43.804142'::timestamp, 40, 25),
  ('fea91879-1f8d-490b-a590-a2c53493583e', 'c35b6364-f642-53a3-987a-3e8882ce7caa', '2026-08-24 11:44:48.388000'::timestamp, 40, 25),
  ('ff927368-e6a7-446e-8f6c-5877512236d5', 'ff907984-16f0-51cf-859e-fa533e081019', '2026-09-14 23:15:52.529000'::timestamp, 40, 25);
--> statement-breakpoint

DO $$
DECLARE
  expected_count constant integer := 55;
  repair_count integer;
  present_count integer;
  eligible_count integer;
BEGIN
  SELECT count(*) INTO repair_count
  FROM _moonboard_snapped_angle_repairs;

  IF repair_count <> expected_count THEN
    RAISE EXCEPTION 'MoonBoard angle repair expected % input rows, found %', expected_count, repair_count;
  END IF;

  SELECT count(*) INTO present_count
  FROM _moonboard_snapped_angle_repairs repair
  JOIN boardsesh_ticks tick ON tick.uuid = repair.tick_uuid;

  -- Local, preview and fresh databases contain none of these production UUIDs.
  -- Keep normal migration replay and new installations a clean no-op.
  IF present_count = 0 THEN
    RETURN;
  END IF;

  IF present_count <> expected_count THEN
    RAISE EXCEPTION 'MoonBoard angle repair found % of % production tick UUIDs; refusing a partial repair',
      present_count, expected_count;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM _moonboard_snapped_angle_repairs repair
    LEFT JOIN board_climbs climb
      ON climb.board_type = 'moonboard'
     AND climb.uuid = repair.climb_uuid
    WHERE climb.uuid IS NULL OR climb.user_id IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'MoonBoard angle repair input is no longer entirely catalog-backed';
  END IF;

  SELECT count(*) INTO eligible_count
  FROM _moonboard_snapped_angle_repairs repair
  JOIN boardsesh_ticks tick
    ON tick.uuid = repair.tick_uuid
   AND tick.board_type = 'moonboard'
   AND tick.origin = 'native'
   AND tick.climb_uuid = repair.climb_uuid
   AND tick.angle = repair.from_angle
   AND tick.updated_at = repair.expected_updated_at;

  IF eligible_count <> expected_count THEN
    RAISE EXCEPTION 'MoonBoard angle repair expected % unchanged ticks, found %; refresh the production audit',
      expected_count, eligible_count;
  END IF;
END $$;
--> statement-breakpoint

CREATE TEMP TABLE _moonboard_snapped_angle_stats_keys (
  climb_uuid text NOT NULL,
  angle integer NOT NULL,
  PRIMARY KEY (climb_uuid, angle)
) ON COMMIT DROP;

INSERT INTO _moonboard_snapped_angle_stats_keys (climb_uuid, angle)
SELECT repair.climb_uuid, repair.from_angle
FROM _moonboard_snapped_angle_repairs repair
WHERE EXISTS (SELECT 1 FROM boardsesh_ticks tick WHERE tick.uuid = repair.tick_uuid)
UNION
SELECT repair.climb_uuid, repair.to_angle
FROM _moonboard_snapped_angle_repairs repair
WHERE EXISTS (SELECT 1 FROM boardsesh_ticks tick WHERE tick.uuid = repair.tick_uuid);
--> statement-breakpoint

DO $$
DECLARE
  expected_count constant integer := 55;
  present_count integer;
  moved_count integer;
BEGIN
  SELECT count(*) INTO present_count
  FROM _moonboard_snapped_angle_repairs repair
  JOIN boardsesh_ticks tick ON tick.uuid = repair.tick_uuid;

  IF present_count = 0 THEN
    RETURN;
  END IF;

  UPDATE boardsesh_ticks tick
     SET angle = repair.to_angle
    FROM _moonboard_snapped_angle_repairs repair
   WHERE tick.uuid = repair.tick_uuid
     AND tick.board_type = 'moonboard'
     AND tick.origin = 'native'
     AND tick.climb_uuid = repair.climb_uuid
     AND tick.angle = repair.from_angle
     AND tick.updated_at = repair.expected_updated_at;

  GET DIAGNOSTICS moved_count = ROW_COUNT;
  IF moved_count <> expected_count THEN
    RAISE EXCEPTION 'MoonBoard angle repair moved % ticks instead of %', moved_count, expected_count;
  END IF;
END $$;
--> statement-breakpoint

-- Keep any beta attached after the audit on the same wall angle as its tick.
UPDATE board_beta_links beta
   SET angle = repair.to_angle
  FROM _moonboard_snapped_angle_repairs repair
 WHERE beta.tick_uuid = repair.tick_uuid
   AND beta.board_type = 'moonboard'
   AND beta.angle = repair.from_angle;
--> statement-breakpoint

-- Seed a missing requested-angle stats row only when a real climb and a send at
-- that key both exist. Existing upstream/catalog fields remain untouched.
INSERT INTO board_climb_stats (
  board_type,
  climb_uuid,
  angle,
  ascensionist_count,
  upstream_ascensionist_count,
  boardsesh_ascensionist_count,
  quality_normalized
)
SELECT 'moonboard', key.climb_uuid, key.angle, 0, 0, 0, TRUE
FROM _moonboard_snapped_angle_stats_keys key
WHERE EXISTS (
  SELECT 1
  FROM board_climbs climb
  WHERE climb.board_type = 'moonboard'
    AND climb.uuid = key.climb_uuid
)
  AND EXISTS (
    SELECT 1
    FROM boardsesh_ticks tick
    WHERE tick.board_type = 'moonboard'
      AND tick.climb_uuid = key.climb_uuid
      AND tick.angle = key.angle
      AND tick.status IN ('flash', 'send')
      AND tick.kilter_detached_at IS NULL
  )
ON CONFLICT (board_type, climb_uuid, angle) DO NOTHING;
--> statement-breakpoint

-- Recompute the Boardsesh-owned count and quality terms at both the departed
-- 40-degree keys and the restored 25-degree keys. This is the MoonBoard branch
-- of recomputeClimbStatsBulk: upstream counts, catalog grades, benchmark data,
-- and manufacturer FA fields are preserved verbatim.
WITH per_user AS (
  SELECT
    tick.climb_uuid,
    tick.angle,
    tick.user_id,
    bool_or(
      tick.origin = 'native'
      AND tick.status IN ('flash', 'send')
      AND NOT (
        tick.kilter_id IS NOT NULL
        AND tick.kilter_synced_at IS NOT NULL
        AND stats.upstream_synced_at IS NOT NULL
        AND tick.kilter_synced_at < stats.upstream_synced_at - interval '48 hours'
      )
    ) AS has_unabsorbed_native_send,
    bool_or(tick.origin <> 'native' AND tick.status IN ('flash', 'send')) AS has_upstream
  FROM boardsesh_ticks tick
  JOIN _moonboard_snapped_angle_stats_keys key
    ON key.climb_uuid = tick.climb_uuid
   AND key.angle = tick.angle
  JOIN board_climb_stats stats
    ON stats.board_type = 'moonboard'
   AND stats.climb_uuid = tick.climb_uuid
   AND stats.angle = tick.angle
  WHERE tick.board_type = 'moonboard'
    AND tick.kilter_detached_at IS NULL
  GROUP BY tick.climb_uuid, tick.angle, tick.user_id
),
counts AS (
  SELECT
    climb_uuid,
    angle,
    count(*) FILTER (WHERE has_unabsorbed_native_send AND NOT has_upstream) AS distinct_senders
  FROM per_user
  GROUP BY climb_uuid, angle
),
boardsesh_quality AS (
  SELECT
    latest.climb_uuid,
    latest.angle,
    sum(latest.quality)::double precision AS quality_sum,
    count(*)::bigint AS quality_count
  FROM (
    SELECT DISTINCT ON (tick.climb_uuid, tick.angle, tick.user_id)
      tick.climb_uuid,
      tick.angle,
      tick.quality
    FROM boardsesh_ticks tick
    JOIN _moonboard_snapped_angle_stats_keys key
      ON key.climb_uuid = tick.climb_uuid
     AND key.angle = tick.angle
    WHERE tick.board_type = 'moonboard'
      AND tick.origin = 'native'
      AND tick.status IN ('flash', 'send')
      AND tick.quality BETWEEN 1 AND 5
      AND tick.kilter_detached_at IS NULL
    ORDER BY tick.climb_uuid, tick.angle, tick.user_id, tick.climbed_at DESC, tick.id DESC
  ) latest
  GROUP BY latest.climb_uuid, latest.angle
)
UPDATE board_climb_stats stats
   SET boardsesh_ascensionist_count = COALESCE(counts.distinct_senders, 0),
       ascensionist_count = COALESCE(stats.upstream_ascensionist_count, 0)
                          + COALESCE(counts.distinct_senders, 0),
       boardsesh_quality_sum = boardsesh_quality.quality_sum,
       boardsesh_quality_count = NULLIF(boardsesh_quality.quality_count, 0),
       quality_average = COALESCE(
         (
           COALESCE(stats.upstream_quality_average * stats.upstream_ascensionist_count, 0)
           + COALESCE(boardsesh_quality.quality_sum, 0)
         ) / NULLIF(
           COALESCE(
             CASE
               WHEN stats.upstream_quality_average IS NOT NULL THEN stats.upstream_ascensionist_count
             END,
             0
           ) + COALESCE(boardsesh_quality.quality_count, 0),
           0
         ),
         stats.upstream_quality_average
       )
  FROM _moonboard_snapped_angle_stats_keys key
  LEFT JOIN counts
    ON counts.climb_uuid = key.climb_uuid
   AND counts.angle = key.angle
  LEFT JOIN boardsesh_quality
    ON boardsesh_quality.climb_uuid = key.climb_uuid
   AND boardsesh_quality.angle = key.angle
 WHERE stats.board_type = 'moonboard'
   AND stats.climb_uuid = key.climb_uuid
   AND stats.angle = key.angle;
