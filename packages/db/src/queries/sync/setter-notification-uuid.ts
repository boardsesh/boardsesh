import { v5 as uuidv5 } from 'uuid';

/**
 * Fixed namespace for `new_climbs_synced` notification uuids. Minted once for
 * issue #3539 and never rotated — changing it would make every already-sent
 * notification re-eligible for a duplicate.
 */
const SETTER_SYNC_NOTIFICATION_NAMESPACE = 'f0583582-bf46-4ba3-8ece-78edfde18aab';

/**
 * Deterministic uuid for a "new climbs from <setter>" notification, so a
 * repeated insert of the same notification collides instead of landing twice.
 *
 * Both sync packages build these rows from a pre-read of which climb uuids
 * already exist, inside a transaction — so two overlapping shared/catalog syncs
 * both classify the same climbs as new and both fire a full set of follower
 * notifications. `notifications_dedup_idx` is a plain index, so nothing stopped
 * the second set.
 *
 * The backstop rides `notifications.uuid`, which is already NOT NULL UNIQUE, so
 * it needs no migration, no index build over existing rows, and no cleanup of
 * historical duplicates — rows written before this carry random v4 uuids that
 * can never collide with these v5 values.
 *
 * A composite UNIQUE index on (actor_id, recipient_id, type, entity_id) was the
 * obvious alternative and is the wrong tool here: `actor_id` is NULL whenever
 * the setter has no linked Boardsesh account, which is the majority case, and
 * Postgres treats NULLs as distinct in a unique index — so it would fail to
 * block exactly the duplicates we care about. `NULLS NOT DISTINCT` fixes that
 * but drizzle-orm's pg-core index builder can't express it, and migration SQL
 * is generated, never hand-written.
 *
 * Callers must pair this with `.onConflictDoNothing()`. `type` is folded into
 * the name so this can never dedup another notification type, even by accident.
 */
export function setterSyncNotificationUuid(input: {
  recipientId: string;
  entityId: string;
  actorId: string | null;
}): string {
  return uuidv5(
    `new_climbs_synced|${input.recipientId}|${input.entityId}|${input.actorId ?? ''}`,
    SETTER_SYNC_NOTIFICATION_NAMESPACE,
  );
}
