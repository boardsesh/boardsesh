import { and, inArray } from 'drizzle-orm';
import * as schema from '@boardsesh/db/schema';
import { userActivityVisibilityCondition } from '@boardsesh/db/queries';
import type { ConnectionContext } from '@boardsesh/shared-schema';
import { db } from '../../../db/client';

type Batch = { authorIds: Set<string>; visible: Promise<Set<string>> };

/**
 * One pending lookup per viewer, filled by every `Climb.userId` resolved in the
 * same tick (a search page, a playlist, a queue event) and flushed once.
 * Nothing is kept after the flush, so a privacy change applies to the next
 * request.
 */
const pendingByViewer = new Map<string | null, Batch>();

function visibleAuthors(authorId: string, viewerId: string | null): Promise<Set<string>> {
  const pending = pendingByViewer.get(viewerId);
  if (pending) {
    pending.authorIds.add(authorId);
    return pending.visible;
  }
  const authorIds = new Set([authorId]);
  const visible = new Promise<Set<string>>((resolve, reject) => {
    process.nextTick(() => {
      pendingByViewer.delete(viewerId);
      // The primary: account privacy is a policy read, and a lagging replica
      // could restore a link the account just withdrew.
      db.select({ id: schema.users.id })
        .from(schema.users)
        .where(
          and(inArray(schema.users.id, [...authorIds]), userActivityVisibilityCondition(schema.users.id, viewerId)),
        )
        .then((rows) => resolve(new Set(rows.map((row) => row.id))), reject);
    });
  });
  pendingByViewer.set(viewerId, { authorIds, visible });
  return visible;
}

/**
 * `Climb.userId`: the Boardsesh account that set the climb, for a viewer who
 * may see that account's activity, and null for anyone else.
 *
 * A published climb is public whoever set it, but the link from the climb to a
 * private account is that account's activity. Its setter name stays on the
 * climb; the account id does not, so a stranger cannot read back the identity
 * `setterProfile` withholds. The owner always gets their own id (the edit and
 * delete gates compare it), and so does an approved follower.
 *
 * Resolved per viewer, after any shared cache: search pages are cached across
 * viewers, so this cannot live in the cached row.
 */
export async function resolveClimbAuthorId(
  climb: { userId?: string | null },
  ctx: ConnectionContext | undefined,
): Promise<string | null> {
  const authorId = climb.userId ?? null;
  if (!authorId) return null;
  const viewerId = ctx?.isAuthenticated ? (ctx.userId ?? null) : null;
  if (viewerId === authorId) return authorId;
  return (await visibleAuthors(authorId, viewerId)).has(authorId) ? authorId : null;
}
