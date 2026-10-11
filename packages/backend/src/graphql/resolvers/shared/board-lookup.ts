import { and, desc, eq, isNotNull, isNull } from 'drizzle-orm';
import { userBoards } from '@boardsesh/db/schema';
import { db } from '../../../db/client';
import { followBoardMergeChain } from '../board-presence/shared';

type BoardRow = typeof userBoards.$inferSelect;

/**
 * Resolve a valid slug to its active board, following merge tombstones when the
 * slug has no active owner. Callers apply their own visibility or session guard
 * before exposing this raw row; no enrichment or membership writes happen here.
 */
export async function resolveBoardBySlug(slug: string): Promise<BoardRow | null> {
  return (await resolveBoardLinkBySlug(slug))?.board ?? null;
}

/**
 * `resolveBoardBySlug`, plus whether the slug is still the link of the board it
 * resolved to. An active row's own slug is. A merged-away row's slug redirects
 * to the surviving board, but carries the link across only when one owner holds
 * both: slugs are derived from names and reused once a board is gone, so an old
 * shared link must not open somebody else's Unlisted board. When `slugIsLink`
 * is false the caller reads the survivor without the link.
 */
export async function resolveBoardLinkBySlug(slug: string): Promise<{ board: BoardRow; slugIsLink: boolean } | null> {
  if (!slug || slug.length > 120 || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(slug)) return null;

  // An active row wins even when an older merged board used the same slug.
  const [active] = await db
    .select()
    .from(userBoards)
    .where(and(eq(userBoards.slug, slug), isNull(userBoards.deletedAt)))
    .limit(1);
  if (active) return { board: active, slugIsLink: true };

  // A slug can have several merged losers; the latest deletion is authoritative.
  // Plain soft-deletes never resolve, and the shared walk bounds merge chains.
  const [merged] = await db
    .select()
    .from(userBoards)
    .where(and(eq(userBoards.slug, slug), isNotNull(userBoards.mergedIntoBoardUuid), isNotNull(userBoards.deletedAt)))
    .orderBy(desc(userBoards.deletedAt))
    .limit(1);
  if (!merged) return null;
  const survivor = await followBoardMergeChain(merged.mergedIntoBoardUuid);
  return survivor ? { board: survivor, slugIsLink: survivor.ownerId === merged.ownerId } : null;
}
