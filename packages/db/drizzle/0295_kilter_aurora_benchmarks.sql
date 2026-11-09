CREATE TABLE "kilter_aurora_benchmarks" (
	"climb_uuid" text NOT NULL,
	"angle" integer NOT NULL,
	"benchmark_difficulty" double precision NOT NULL,
	"captured_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "kilter_aurora_benchmarks_climb_uuid_angle_pk" PRIMARY KEY("climb_uuid","angle")
);
--> statement-breakpoint
-- Freeze the grades Aurora published for Kilter climbs (#2493) while the column
-- still holds them. The Kilter catalog sync is about to replace
-- benchmark_difficulty with Kilter's own Verified list, and it refuses to run
-- until this table exists. Creating and filling it in one migration means the
-- table cannot exist without its rows. NaN and NULL are not benchmarks.
INSERT INTO "kilter_aurora_benchmarks" ("climb_uuid", "angle", "benchmark_difficulty")
SELECT "climb_uuid", "angle", "benchmark_difficulty"
FROM "board_climb_stats"
WHERE "board_type" = 'kilter'
  AND "benchmark_difficulty" > 0
  AND "benchmark_difficulty" <> 'NaN'::double precision;
