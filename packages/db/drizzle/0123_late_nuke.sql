DROP INDEX "user_favorites_user_idx";--> statement-breakpoint
DROP INDEX "user_favorites_climb_idx";--> statement-breakpoint
DROP INDEX "unique_user_favorite";--> statement-breakpoint
DELETE FROM "user_favorites" uf
USING (
	SELECT "id"
	FROM (
		SELECT
			"id",
			row_number() OVER (
				PARTITION BY "user_id", "climb_uuid"
				ORDER BY "created_at" DESC, "id" DESC
			) AS rn
		FROM "user_favorites"
	) ranked
	WHERE ranked.rn > 1
) duplicate_favorites
WHERE uf."id" = duplicate_favorites."id";--> statement-breakpoint
CREATE UNIQUE INDEX "unique_user_favorite" ON "user_favorites" USING btree ("user_id","climb_uuid");--> statement-breakpoint
ALTER TABLE "user_favorites" DROP COLUMN "board_name";--> statement-breakpoint
ALTER TABLE "user_favorites" DROP COLUMN "angle";
