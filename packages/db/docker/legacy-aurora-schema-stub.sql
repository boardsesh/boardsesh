-- Legacy Aurora table stubs (kilter_* / tension_*).
--
-- The drizzle journal cannot be applied to a bare cluster on its own:
-- 0000_cloudy_carlie_cooper.sql ALTERs kilter_climbs/tension_climbs and
-- 0025_shocking_clint_barton.sql opens with an unguarded
-- `DELETE FROM kilter_beta_links`. Those tables used to exist because
-- pgloader created them from the Aurora APK SQLite files before drizzle ran.
-- The image no longer runs pgloader (the board catalogue now comes from the
-- published board snapshots), so this file creates the same tables empty.
-- 0038_drop_legacy_tables.sql drops every one of them again.
--
-- Generated from packages/db/drizzle/meta/0000_snapshot.json, which is frozen
-- (migration 0000 never changes). Columns only: pgloader ran with
-- `create no indexes`, so primary keys, foreign keys and indexes are added by
-- the journal itself, exactly as they were before.

CREATE TABLE IF NOT EXISTS "kilter_android_metadata" (
  "locale" text
);

CREATE TABLE IF NOT EXISTS "kilter_ascents" (
  "uuid" text,
  "climb_uuid" text,
  "angle" integer,
  "is_mirror" boolean,
  "user_id" integer,
  "attempt_id" integer,
  "bid_count" integer,
  "quality" integer,
  "difficulty" integer,
  "is_benchmark" integer,
  "comment" text,
  "climbed_at" text,
  "created_at" text
);

CREATE TABLE IF NOT EXISTS "kilter_attempts" (
  "id" integer,
  "position" integer,
  "name" text
);

CREATE TABLE IF NOT EXISTS "kilter_beta_links" (
  "climb_uuid" text,
  "link" text,
  "foreign_username" text,
  "angle" integer,
  "thumbnail" text,
  "is_listed" boolean,
  "created_at" text
);

CREATE TABLE IF NOT EXISTS "kilter_bids" (
  "uuid" text,
  "user_id" integer,
  "climb_uuid" text,
  "angle" integer,
  "is_mirror" boolean,
  "bid_count" integer,
  "comment" text,
  "climbed_at" text,
  "created_at" text
);

CREATE TABLE IF NOT EXISTS "kilter_circuits" (
  "uuid" text,
  "name" text,
  "description" text,
  "color" text,
  "user_id" integer,
  "is_public" boolean,
  "created_at" text,
  "updated_at" text
);

CREATE TABLE IF NOT EXISTS "kilter_circuits_climbs" (
  "circuit_uuid" text,
  "climb_uuid" text,
  "position" integer
);

CREATE TABLE IF NOT EXISTS "kilter_climb_cache_fields" (
  "id" bigint,
  "climb_uuid" text,
  "ascensionist_count" integer,
  "display_difficulty" double precision,
  "quality_average" double precision
);

CREATE TABLE IF NOT EXISTS "kilter_climb_random_positions" (
  "climb_uuid" text,
  "position" integer
);

CREATE TABLE IF NOT EXISTS "kilter_climb_stats" (
  "id" bigint,
  "climb_uuid" text,
  "angle" bigint,
  "display_difficulty" double precision,
  "benchmark_difficulty" double precision,
  "ascensionist_count" bigint,
  "difficulty_average" double precision,
  "quality_average" double precision,
  "fa_username" text,
  "fa_at" timestamp
);

CREATE TABLE IF NOT EXISTS "kilter_climbs" (
  "uuid" text,
  "layout_id" integer,
  "setter_id" integer,
  "setter_username" text,
  "name" text,
  "description" text,
  "hsm" integer,
  "edge_left" integer,
  "edge_right" integer,
  "edge_bottom" integer,
  "edge_top" integer,
  "angle" integer,
  "frames_count" integer,
  "frames_pace" integer,
  "frames" text,
  "is_draft" boolean,
  "is_listed" boolean,
  "created_at" text
);

CREATE TABLE IF NOT EXISTS "kilter_difficulty_grades" (
  "difficulty" integer,
  "boulder_name" text,
  "route_name" text,
  "is_listed" boolean
);

CREATE TABLE IF NOT EXISTS "kilter_holes" (
  "id" integer,
  "product_id" integer,
  "name" text,
  "x" integer,
  "y" integer,
  "mirrored_hole_id" integer,
  "mirror_group" integer
);

CREATE TABLE IF NOT EXISTS "kilter_kits" (
  "serial_number" text,
  "name" text,
  "is_autoconnect" boolean,
  "is_listed" boolean,
  "created_at" text,
  "updated_at" text
);

CREATE TABLE IF NOT EXISTS "kilter_layouts" (
  "id" integer,
  "product_id" integer,
  "name" text,
  "instagram_caption" text,
  "is_mirrored" boolean,
  "is_listed" boolean,
  "password" text,
  "created_at" text
);

CREATE TABLE IF NOT EXISTS "kilter_leds" (
  "id" integer,
  "product_size_id" integer,
  "hole_id" integer,
  "position" integer
);

CREATE TABLE IF NOT EXISTS "kilter_placement_roles" (
  "id" integer,
  "product_id" integer,
  "position" integer,
  "name" text,
  "full_name" text,
  "led_color" text,
  "screen_color" text
);

CREATE TABLE IF NOT EXISTS "kilter_placements" (
  "id" integer,
  "layout_id" integer,
  "hole_id" integer,
  "set_id" integer,
  "default_placement_role_id" integer
);

CREATE TABLE IF NOT EXISTS "kilter_product_sizes" (
  "id" integer,
  "product_id" integer,
  "edge_left" integer,
  "edge_right" integer,
  "edge_bottom" integer,
  "edge_top" integer,
  "name" text,
  "description" text,
  "image_filename" text,
  "position" integer,
  "is_listed" boolean
);

CREATE TABLE IF NOT EXISTS "kilter_product_sizes_layouts_sets" (
  "id" integer,
  "product_size_id" integer,
  "layout_id" integer,
  "set_id" integer,
  "image_filename" text,
  "is_listed" boolean
);

CREATE TABLE IF NOT EXISTS "kilter_products" (
  "id" integer,
  "name" text,
  "is_listed" boolean,
  "password" text,
  "min_count_in_frame" integer,
  "max_count_in_frame" integer
);

CREATE TABLE IF NOT EXISTS "kilter_products_angles" (
  "product_id" integer,
  "angle" integer
);

CREATE TABLE IF NOT EXISTS "kilter_sets" (
  "id" integer,
  "name" text,
  "hsm" integer
);

CREATE TABLE IF NOT EXISTS "kilter_shared_syncs" (
  "table_name" text,
  "last_synchronized_at" text
);

CREATE TABLE IF NOT EXISTS "kilter_tags" (
  "entity_uuid" text,
  "user_id" integer,
  "name" text,
  "is_listed" boolean
);

CREATE TABLE IF NOT EXISTS "kilter_user_permissions" (
  "user_id" integer,
  "name" text
);

CREATE TABLE IF NOT EXISTS "kilter_user_syncs" (
  "user_id" integer,
  "table_name" text,
  "last_synchronized_at" text
);

CREATE TABLE IF NOT EXISTS "kilter_users" (
  "id" integer,
  "username" text,
  "created_at" text
);

CREATE TABLE IF NOT EXISTS "kilter_walls" (
  "uuid" text,
  "user_id" integer,
  "name" text,
  "product_id" integer,
  "is_adjustable" boolean,
  "angle" integer,
  "layout_id" integer,
  "product_size_id" integer,
  "hsm" integer,
  "serial_number" text,
  "created_at" text
);

CREATE TABLE IF NOT EXISTS "kilter_walls_sets" (
  "wall_uuid" text,
  "set_id" integer
);

CREATE TABLE IF NOT EXISTS "tension_android_metadata" (
  "locale" text
);

CREATE TABLE IF NOT EXISTS "tension_ascents" (
  "uuid" text,
  "climb_uuid" text,
  "angle" integer,
  "is_mirror" boolean,
  "user_id" integer,
  "attempt_id" integer,
  "bid_count" integer,
  "quality" integer,
  "difficulty" integer,
  "is_benchmark" integer,
  "comment" text,
  "climbed_at" text,
  "created_at" text
);

CREATE TABLE IF NOT EXISTS "tension_attempts" (
  "id" integer,
  "position" integer,
  "name" text
);

CREATE TABLE IF NOT EXISTS "tension_beta_links" (
  "climb_uuid" text,
  "link" text,
  "foreign_username" text,
  "angle" integer,
  "thumbnail" text,
  "is_listed" boolean,
  "created_at" text
);

CREATE TABLE IF NOT EXISTS "tension_bids" (
  "uuid" text,
  "user_id" integer,
  "climb_uuid" text,
  "angle" integer,
  "is_mirror" boolean,
  "bid_count" integer,
  "comment" text,
  "climbed_at" text,
  "created_at" text
);

CREATE TABLE IF NOT EXISTS "tension_circuits" (
  "uuid" text,
  "name" text,
  "description" text,
  "color" text,
  "user_id" integer,
  "is_public" boolean,
  "created_at" text,
  "updated_at" text
);

CREATE TABLE IF NOT EXISTS "tension_circuits_climbs" (
  "circuit_uuid" text,
  "climb_uuid" text,
  "position" integer
);

CREATE TABLE IF NOT EXISTS "tension_climb_cache_fields" (
  "id" bigint,
  "climb_uuid" text,
  "ascensionist_count" integer,
  "display_difficulty" double precision,
  "quality_average" double precision
);

CREATE TABLE IF NOT EXISTS "tension_climb_random_positions" (
  "climb_uuid" text,
  "position" integer
);

CREATE TABLE IF NOT EXISTS "tension_climb_stats" (
  "id" bigint,
  "climb_uuid" text,
  "angle" bigint,
  "display_difficulty" double precision,
  "benchmark_difficulty" double precision,
  "ascensionist_count" bigint,
  "difficulty_average" double precision,
  "quality_average" double precision,
  "fa_username" text,
  "fa_at" timestamp
);

CREATE TABLE IF NOT EXISTS "tension_climbs" (
  "uuid" text,
  "layout_id" integer,
  "setter_id" integer,
  "setter_username" text,
  "name" text,
  "description" text,
  "hsm" integer,
  "edge_left" integer,
  "edge_right" integer,
  "edge_bottom" integer,
  "edge_top" integer,
  "angle" integer,
  "frames_count" integer,
  "frames_pace" integer,
  "frames" text,
  "is_draft" boolean,
  "is_listed" boolean,
  "created_at" text
);

CREATE TABLE IF NOT EXISTS "tension_difficulty_grades" (
  "difficulty" integer,
  "boulder_name" text,
  "route_name" text,
  "is_listed" boolean
);

CREATE TABLE IF NOT EXISTS "tension_holes" (
  "id" integer,
  "product_id" integer,
  "name" text,
  "x" integer,
  "y" integer,
  "mirrored_hole_id" integer,
  "mirror_group" integer
);

CREATE TABLE IF NOT EXISTS "tension_kits" (
  "serial_number" text,
  "name" text,
  "is_autoconnect" boolean,
  "is_listed" boolean,
  "created_at" text,
  "updated_at" text
);

CREATE TABLE IF NOT EXISTS "tension_layouts" (
  "id" integer,
  "product_id" integer,
  "name" text,
  "instagram_caption" text,
  "is_mirrored" boolean,
  "is_listed" boolean,
  "password" text,
  "created_at" text
);

CREATE TABLE IF NOT EXISTS "tension_leds" (
  "id" integer,
  "product_size_id" integer,
  "hole_id" integer,
  "position" integer
);

CREATE TABLE IF NOT EXISTS "tension_placement_roles" (
  "id" integer,
  "product_id" integer,
  "position" integer,
  "name" text,
  "full_name" text,
  "led_color" text,
  "screen_color" text
);

CREATE TABLE IF NOT EXISTS "tension_placements" (
  "id" integer,
  "layout_id" integer,
  "hole_id" integer,
  "set_id" integer,
  "default_placement_role_id" integer
);

CREATE TABLE IF NOT EXISTS "tension_product_sizes" (
  "id" integer,
  "product_id" integer,
  "edge_left" integer,
  "edge_right" integer,
  "edge_bottom" integer,
  "edge_top" integer,
  "name" text,
  "description" text,
  "image_filename" text,
  "position" integer,
  "is_listed" boolean
);

CREATE TABLE IF NOT EXISTS "tension_product_sizes_layouts_sets" (
  "id" integer,
  "product_size_id" integer,
  "layout_id" integer,
  "set_id" integer,
  "image_filename" text,
  "is_listed" boolean
);

CREATE TABLE IF NOT EXISTS "tension_products" (
  "id" integer,
  "name" text,
  "is_listed" boolean,
  "password" text,
  "min_count_in_frame" integer,
  "max_count_in_frame" integer
);

CREATE TABLE IF NOT EXISTS "tension_products_angles" (
  "product_id" integer,
  "angle" integer
);

CREATE TABLE IF NOT EXISTS "tension_sets" (
  "id" integer,
  "name" text,
  "hsm" integer
);

CREATE TABLE IF NOT EXISTS "tension_shared_syncs" (
  "table_name" text,
  "last_synchronized_at" text
);

CREATE TABLE IF NOT EXISTS "tension_tags" (
  "entity_uuid" text,
  "user_id" integer,
  "name" text,
  "is_listed" boolean
);

CREATE TABLE IF NOT EXISTS "tension_user_permissions" (
  "user_id" integer,
  "name" text
);

CREATE TABLE IF NOT EXISTS "tension_user_syncs" (
  "user_id" integer,
  "table_name" text,
  "last_synchronized_at" text
);

CREATE TABLE IF NOT EXISTS "tension_users" (
  "id" integer,
  "username" text,
  "created_at" text
);

CREATE TABLE IF NOT EXISTS "tension_walls" (
  "uuid" text,
  "user_id" integer,
  "name" text,
  "product_id" integer,
  "is_adjustable" boolean,
  "angle" integer,
  "layout_id" integer,
  "product_size_id" integer,
  "hsm" integer,
  "serial_number" text,
  "created_at" text
);

CREATE TABLE IF NOT EXISTS "tension_walls_sets" (
  "wall_uuid" text,
  "set_id" integer
);
