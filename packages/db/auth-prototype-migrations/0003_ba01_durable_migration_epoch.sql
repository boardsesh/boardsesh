CREATE TABLE "prototype_auth_migration_epoch" (
	"name" text PRIMARY KEY NOT NULL,
	"cutover_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
