import 'server-only';
import { and, eq, inArray } from 'drizzle-orm';
import { playlistVisibilityCondition, sprayClimbVisibilityCondition, type SerialPlanDb } from '@boardsesh/db/queries';
import { dbz } from '@/app/lib/db/db';
import { boardClimbs, playlists } from '@/app/lib/db/schema';
import { extractUuidFromSlug } from '@/app/lib/url-utils';
import type { SitemapItem } from './entries';

/**
 * Which of these climbs (or setters) still have a climb a crawler may be sent
 * to: listed, published, not voted out of browse, and not on a private spray
 * wall.
 *
 * A published, listed climb is public to everyone, whoever set it. No account
 * privacy, item audience or follow relation is consulted, so a private
 * account's published climbs stay in the sitemap. The spray predicate is the
 * wall's own rule, not the climb's, and stays.
 *
 * Read on the primary: the spray predicate is a visibility rule a wall owner
 * can withdraw, and a lagging replica could restore it.
 */
export function buildSitemapClimbRecheckQuery(db: SerialPlanDb, kind: 'climbs' | 'setters', identifiers: string[]) {
  const identityColumn = kind === 'setters' ? boardClimbs.setterUsername : boardClimbs.uuid;
  return db
    .selectDistinct({ identifier: identityColumn, boardType: boardClimbs.boardType })
    .from(boardClimbs)
    .where(
      and(
        inArray(identityColumn, identifiers),
        eq(boardClimbs.isListed, true),
        eq(boardClimbs.isDraft, false),
        eq(boardClimbs.isHidden, false),
        sprayClimbVisibilityCondition({ boardType: boardClimbs.boardType, layoutId: boardClimbs.layoutId }, null),
      ),
    );
}

/** Stored and cached sitemap rows are candidates; drop any whose climb has since been withdrawn. */
export async function filterPublicSitemapItems(items: SitemapItem[], kind: string): Promise<SitemapItem[]> {
  if (!['climbs', 'setters', 'playlists'].includes(kind) || items.length === 0) return items;
  const identifiers = items.map((item) => {
    const segment = decodeURIComponent(item.path.split('/').filter(Boolean).at(-1) ?? '');
    return kind === 'climbs' ? extractUuidFromSlug(segment) : segment;
  });
  if (kind === 'playlists') {
    const rows = await dbz
      .select({ uuid: playlists.uuid })
      .from(playlists)
      .where(and(inArray(playlists.uuid, identifiers), playlistVisibilityCondition(null, playlists)));
    const allowed = new Set(rows.map((row) => row.uuid));
    return items.filter((_item, index) => allowed.has(identifiers[index]));
  }
  const rows = await buildSitemapClimbRecheckQuery(dbz, kind === 'setters' ? 'setters' : 'climbs', identifiers);
  const allowed = new Set(
    rows.map((row) => (kind === 'setters' ? row.identifier : `${row.boardType}:${row.identifier}`)),
  );
  return items.filter((item, index) => {
    if (kind === 'setters') return allowed.has(identifiers[index]);
    const boardType = item.path.startsWith('/b/') ? 'spray' : item.path.split('/')[1];
    return allowed.has(`${boardType}:${identifiers[index]}`);
  });
}
