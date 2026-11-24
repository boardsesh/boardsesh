-- Prebuild both indexes CONCURRENTLY on existing deployments before running
-- this migration. The migrator uses a transaction and ordinary CREATE INDEX
-- would block writes on the live tick and display streams during each build.
-- Use the same names, columns and predicates shown below. Check that both
-- indexes are valid before migrating. Fresh and disposable databases can build
-- them here.
CREATE TABLE "gym_reporting_observations" (
	"gym_id" bigint NOT NULL,
	"contract_version" integer NOT NULL,
	"started_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	CONSTRAINT "gym_reporting_observations_gym_id_contract_version_pk" PRIMARY KEY("gym_id","contract_version")
);
--> statement-breakpoint
ALTER TABLE "gym_reporting_observations" ADD CONSTRAINT "gym_reporting_observations_gym_id_gyms_id_fk" FOREIGN KEY ("gym_id") REFERENCES "public"."gyms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "boardsesh_ticks_reporting_unbounded_idx" ON "boardsesh_ticks" USING btree ("board_id","user_id") WHERE "boardsesh_ticks"."origin" = 'native'
        AND "boardsesh_ticks"."reporting_attribution" IN ('uuid', 'presence', 'session', 'edit')
        AND ("boardsesh_ticks"."reporting_time_precision" IS DISTINCT FROM 'instant'
          OR "boardsesh_ticks"."reporting_climbed_at" IS DISTINCT FROM "boardsesh_ticks"."climbed_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "board_climb_events_reporting_actor_time_idx" ON "board_climb_events" USING btree ("board_id","user_id","confirmed_at") WHERE "board_climb_events"."source" = 'boardsesh' AND "board_climb_events"."user_id" IS NOT NULL;
