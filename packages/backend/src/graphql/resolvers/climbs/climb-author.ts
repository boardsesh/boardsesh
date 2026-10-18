import { and, inArray } from 'drizzle-orm';
import * as schema from '@boardsesh/db/schema';
import { publicClimbCondition, userActivityVisibilityCondition } from '@boardsesh/db/queries';
import type { ConnectionContext } from '@boardsesh/shared-schema';
import { db } from '../../../db/client';

type AuthorClaim = { climbUuid: string | null; claimedAuthorId: string | null };
type Resolution = {
  /** Published, listed climbs in the batch, by uuid: the author their own row names (null for none). */
  publicAuthors: Map<string, string | null>;
  /** Claimed authors this viewer may see under the account rule, for the claims no public row settled. */
  visibleAuthors: Set<string>;
};
type Batch = { claims: AuthorClaim[]; resolved: Promise<Resolution> };

/**
 * One pending lookup per viewer, filled by every `Climb.userId` resolved in the
 * same tick (a search page, a playlist, a queue event) and flushed once.
 * Nothing is kept after the flush, so a privacy change or a climb being
 * unlisted applies to the next request.
 */
const pendingByViewer = new Map<string | null, Batch>();

/**
 * One batch's answers.
 *
 * First the climbs: a published, listed climb names the account in its own
 * `user_id`, for everyone. Read from the row, never from the parent, which can
 * omit the field (`userClimbs`, `setterClimbsFull`) or be a `ClimbInput` a
 * session member sent back through the queue. Then, only for the claims that
 * did not settle there (an unlisted climb opened by link, a draft in a queue, a
 * parent with no row), the claimed author's account privacy, as before.
 *
 * Both reads on the primary: account privacy is a policy read, and a lagging
 * replica could restore a link the account just withdrew, or name the author
 * of a climb just unlisted.
 */
async function resolveClaims(claims: AuthorClaim[], viewerId: string | null): Promise<Resolution> {
  const publicAuthors = new Map<string, string | null>();
  const climbUuids = [...new Set(claims.flatMap((claim) => (claim.climbUuid ? [claim.climbUuid] : [])))];
  if (climbUuids.length > 0) {
    const publicClimbs = await db
      .select({ uuid: schema.boardClimbs.uuid, userId: schema.boardClimbs.userId })
      .from(schema.boardClimbs)
      .where(and(inArray(schema.boardClimbs.uuid, climbUuids), publicClimbCondition(schema.boardClimbs)));
    for (const climb of publicClimbs) publicAuthors.set(climb.uuid, climb.userId);
  }

  const fallbackAuthorIds = [
    ...new Set(
      claims.flatMap(({ climbUuid, claimedAuthorId }) =>
        claimedAuthorId && claimedAuthorId !== viewerId && !(climbUuid && publicAuthors.has(climbUuid))
          ? [claimedAuthorId]
          : [],
      ),
    ),
  ];
  const visibleAuthors = new Set<string>();
  if (fallbackAuthorIds.length > 0) {
    const visibleRows = await db
      .select({ id: schema.users.id })
      .from(schema.users)
      .where(
        and(inArray(schema.users.id, fallbackAuthorIds), userActivityVisibilityCondition(schema.users.id, viewerId)),
      );
    for (const row of visibleRows) visibleAuthors.add(row.id);
  }
  return { publicAuthors, visibleAuthors };
}

function resolvedClaims(claim: AuthorClaim, viewerId: string | null): Promise<Resolution> {
  const pending = pendingByViewer.get(viewerId);
  if (pending) {
    pending.claims.push(claim);
    return pending.resolved;
  }
  const claims = [claim];
  const resolved = new Promise<Resolution>((resolve, reject) => {
    process.nextTick(() => {
      pendingByViewer.delete(viewerId);
      resolveClaims(claims, viewerId).then(resolve, reject);
    });
  });
  pendingByViewer.set(viewerId, { claims, resolved });
  return resolved;
}

/**
 * `Climb.userId`: the Boardsesh account that set the climb.
 *
 * Who set a published, listed climb is public with it, whatever the account's
 * privacy: the same id travels in the board sync behind every offline download.
 * So for such a climb everyone gets the `user_id` on its own row, signed in or
 * not, whatever the parent carried: a producer that never selected the field
 * gets it filled, and a stale or forged claim gets the real author.
 *
 * Anything else keeps the account rule on the parent's claim. An unlisted
 * climb opened by its link, a draft riding a session queue, or a parent whose
 * uuid matches no published, listed row names its claimed author only to a
 * viewer who may see that account's activity, and the owner always gets their
 * own id (the edit and delete gates compare it). With no claim there is
 * nothing to name.
 *
 * Resolved per viewer, after any shared cache: search pages are cached across
 * viewers, and whether a climb is still listed is read fresh here.
 */
export async function resolveClimbAuthorId(
  climb: { uuid?: string | null; userId?: string | null },
  ctx: ConnectionContext | undefined,
): Promise<string | null> {
  const climbUuid = climb.uuid ?? null;
  const claimedAuthorId = climb.userId ?? null;
  if (!climbUuid && !claimedAuthorId) return null;
  const viewerId = ctx?.isAuthenticated ? (ctx.userId ?? null) : null;
  const { publicAuthors, visibleAuthors } = await resolvedClaims({ climbUuid, claimedAuthorId }, viewerId);
  if (climbUuid && publicAuthors.has(climbUuid)) return publicAuthors.get(climbUuid) ?? null;
  if (!claimedAuthorId) return null;
  if (claimedAuthorId === viewerId) return claimedAuthorId;
  return visibleAuthors.has(claimedAuthorId) ? claimedAuthorId : null;
}
