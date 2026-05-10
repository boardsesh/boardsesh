CREATE TABLE "user_climb_grades" (
	"user_id" text NOT NULL,
	"board_type" text NOT NULL,
	"climb_uuid" text NOT NULL,
	"angle" integer NOT NULL,
	"difficulty" integer NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "user_climb_grades_user_id_board_type_climb_uuid_angle_pk" PRIMARY KEY("user_id","board_type","climb_uuid","angle")
);
--> statement-breakpoint
CREATE TABLE "user_climb_qualities" (
	"user_id" text NOT NULL,
	"board_type" text NOT NULL,
	"climb_uuid" text NOT NULL,
	"quality" integer NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "user_climb_qualities_user_id_board_type_climb_uuid_pk" PRIMARY KEY("user_id","board_type","climb_uuid")
);
--> statement-breakpoint
ALTER TABLE "user_climb_grades" ADD CONSTRAINT "user_climb_grades_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_climb_qualities" ADD CONSTRAINT "user_climb_qualities_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "user_climb_grades_climb_idx" ON "user_climb_grades" USING btree ("board_type","climb_uuid","angle");--> statement-breakpoint
CREATE INDEX "user_climb_qualities_climb_idx" ON "user_climb_qualities" USING btree ("board_type","climb_uuid");
