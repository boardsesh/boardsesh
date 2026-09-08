import { and, desc, eq, isNotNull, isNull } from 'drizzle-orm';
import { userBoards } from '@boardsesh/db/schema';
import { db } from '../../../db/client';
import { followBoardMergeChain } from '../board-presence/shared';

/**
 * Resolve a valid slug to its active board, following merge tombstones when the
 * slug has no active owner. Callers apply their own visibility or session guard
 * before exposing this raw row; no enrichment or membership writes happen here.
 */
export async function resolveBoardBySlug(slug: string): Promise<typeof userBoards.$inferSelect | null> {
  if (!slug || slug.length > 120 || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(slug)) return null;

  // An active row wins even when an older merged board used the same slug.
  const [active] = await db
    .select()
    .from(userBoards)
    .where(and(eq(userBoards.slug, slug), isNull(userBoards.deletedAt)))
    .limit(1);
  if (active) return active;

  // A slug can have several merged losers; the latest deletion is authoritative.
  // Plain soft-deletes never resolve, and the shared walk bounds merge chains.
  const [merged] = await db
    .select()
    .from(userBoards)
    .where(and(eq(userBoards.slug, slug), isNotNull(userBoards.mergedIntoBoardUuid), isNotNull(userBoards.deletedAt)))
    .orderBy(desc(userBoards.deletedAt))
    .limit(1);
  return merged ? ((await followBoardMergeChain(merged.mergedIntoBoardUuid)) ?? null) : null;
}
