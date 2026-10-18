import { and, inArray } from 'drizzle-orm';
import * as schema from '@boardsesh/db/schema';
import { publicClimbCondition, userActivityVisibilityCondition } from '@boardsesh/db/queries';
import type { ConnectionContext } from '@boardsesh/shared-schema';
import { db } from '../../../db/client';

type AuthorClaim = { climbUuid: string | null; authorId: string };
type Batch = { claims: AuthorClaim[]; resolved: Promise<Set<string>> };

/** One key per (climb, claimed author) pair, so a batch answers each parent on its own. */
const claimKey = (climbUuid: string | null, authorId: string) => `${climbUuid ?? ''}\u0000${authorId}`;

/**
 * One pending lookup per viewer, filled by every `Climb.userId` resolved in the
 * same tick (a search page, a playlist, a queue event) and flushed once.
 * Nothing is kept after the flush, so a privacy change or a climb being
 * unlisted applies to the next request.
 */
const pendingByViewer = new Map<string | null, Batch>();

/**
 * The claims in a batch whose author this viewer may be told, as `claimKey`s.
 *
 * First the climbs: a published, listed climb names the account in its own
 * `user_id`, for everyone. Read from the row, never from the parent, which can
 * be a `ClimbInput` a session member sent back through the queue. Then, only
 * for the claims that did not settle there (an unlisted climb opened by link, a
 * draft in a queue, a parent with no row), the author's account privacy, as
 * before.
 *
 * Both reads on the primary: account privacy is a policy read, and a lagging
 * replica could restore a link the account just withdrew, or name the author
 * of a climb just unlisted.
 */
async function resolveClaims(claims: AuthorClaim[], viewerId: string | null): Promise<Set<string>> {
  const resolved = new Set<string>();
  const climbUuids = [...new Set(claims.flatMap((claim) => (claim.climbUuid ? [claim.climbUuid] : [])))];
  if (climbUuids.length > 0) {
    const publicClimbs = await db
      .select({ uuid: schema.boardClimbs.uuid, userId: schema.boardClimbs.userId })
      .from(schema.boardClimbs)
      .where(and(inArray(schema.boardClimbs.uuid, climbUuids), publicClimbCondition(schema.boardClimbs)));
    for (const climb of publicClimbs) {
      if (climb.userId) resolved.add(claimKey(climb.uuid, climb.userId));
    }
  }

  const unsettled = claims.filter((claim) => !resolved.has(claimKey(claim.climbUuid, claim.authorId)));
  if (unsettled.length === 0) return resolved;
  const authorIds = [...new Set(unsettled.map((claim) => claim.authorId))];
  const visibleRows = await db
    .select({ id: schema.users.id })
    .from(schema.users)
    .where(and(inArray(schema.users.id, authorIds), userActivityVisibilityCondition(schema.users.id, viewerId)));
  const visibleAuthors = new Set(visibleRows.map((row) => row.id));
  for (const claim of unsettled) {
    if (visibleAuthors.has(claim.authorId)) resolved.add(claimKey(claim.climbUuid, claim.authorId));
  }
  return resolved;
}

function resolvedClaims(claim: AuthorClaim, viewerId: string | null): Promise<Set<string>> {
  const pending = pendingByViewer.get(viewerId);
  if (pending) {
    pending.claims.push(claim);
    return pending.resolved;
  }
  const claims = [claim];
  const resolved = new Promise<Set<string>>((resolve, reject) => {
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
 * So for such a climb everyone gets it, signed in or not.
 *
 * Anything else keeps the account rule. An unlisted climb opened by its link,
 * a draft riding a session queue, or a parent whose uuid matches no published,
 * listed row names its author only to a viewer who may see that account's
 * activity. The owner always gets their own id (the edit and delete gates
 * compare it).
 *
 * Resolved per viewer, after any shared cache: search pages are cached across
 * viewers, and whether a climb is still listed is read fresh here.
 */
export async function resolveClimbAuthorId(
  climb: { uuid?: string | null; userId?: string | null },
  ctx: ConnectionContext | undefined,
): Promise<string | null> {
  const authorId = climb.userId ?? null;
  if (!authorId) return null;
  const viewerId = ctx?.isAuthenticated ? (ctx.userId ?? null) : null;
  if (viewerId === authorId) return authorId;
  const climbUuid = climb.uuid ?? null;
  return (await resolvedClaims({ climbUuid, authorId }, viewerId)).has(claimKey(climbUuid, authorId)) ? authorId : null;
}
