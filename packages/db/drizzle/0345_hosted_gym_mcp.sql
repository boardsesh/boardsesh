CREATE TABLE "gym_mcp_write_receipts" (
	"user_id" text NOT NULL,
	"client_id" text NOT NULL,
	"connection_generation" integer NOT NULL,
	"idempotency_key" text NOT NULL,
	"operation_name" text NOT NULL,
	"input_hash" text NOT NULL,
	"result" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "gym_mcp_write_receipts_user_id_client_id_connection_generation_idempotency_key_pk" PRIMARY KEY("user_id","client_id","connection_generation","idempotency_key")
);
--> statement-breakpoint
CREATE TABLE "oauth_mcp_client_policy" (
	"client_id" text PRIMARY KEY NOT NULL,
	"max_active_connections" integer DEFAULT 10000 NOT NULL,
	"max_new_connections_per_day" integer DEFAULT 1000 NOT NULL,
	"suspended_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "gym_mcp_write_receipts" ADD CONSTRAINT "gym_mcp_write_receipts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gym_mcp_write_receipts" ADD CONSTRAINT "gym_mcp_write_receipts_client_id_oauth_client_client_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."oauth_client"("client_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_mcp_client_policy" ADD CONSTRAINT "oauth_mcp_client_policy_client_id_oauth_client_client_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."oauth_client"("client_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "gym_mcp_write_receipts_client_id_idx" ON "gym_mcp_write_receipts" USING btree ("client_id");