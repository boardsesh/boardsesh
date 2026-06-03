CREATE TABLE "board_layout_aliases" (
	"board_type" text NOT NULL,
	"layout_uuid" text NOT NULL,
	"layout_id" integer NOT NULL,
	"source" text NOT NULL,
	"first_seen_at" timestamp DEFAULT now() NOT NULL,
	"last_seen_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "board_layout_aliases_board_type_layout_uuid_pk" PRIMARY KEY("board_type","layout_uuid"),
	CONSTRAINT "board_layout_aliases_uuid_non_empty" CHECK ("board_layout_aliases"."layout_uuid" <> '')
);
--> statement-breakpoint
ALTER TABLE "board_layout_aliases" ADD CONSTRAINT "board_layout_aliases_layout_fk" FOREIGN KEY ("board_type","layout_id") REFERENCES "public"."board_layouts"("board_type","id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
CREATE INDEX "board_layout_aliases_layout_idx" ON "board_layout_aliases" USING btree ("board_type","layout_id");