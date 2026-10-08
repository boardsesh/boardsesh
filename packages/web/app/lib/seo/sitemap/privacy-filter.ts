import 'server-only';
import { and, eq, inArray } from 'drizzle-orm';
import {
  contentVisibilityCondition,
  playlistVisibilityCondition,
  sprayClimbVisibilityCondition,
} from '@boardsesh/db/queries';
import { dbz } from '@/app/lib/db/db';
import { boardClimbs, playlists } from '@/app/lib/db/schema';
import { extractUuidFromSlug } from '@/app/lib/url-utils';
import type { SitemapItem } from './entries';

/** Stored and cached sitemap rows are candidates, never continuing publication consent. */
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
  const identityColumn = kind === 'setters' ? boardClimbs.setterUsername : boardClimbs.uuid;
  const rows = await dbz
    .selectDistinct({ identifier: identityColumn, boardType: boardClimbs.boardType })
    .from(boardClimbs)
    .where(
      and(
        inArray(identityColumn, identifiers),
        eq(boardClimbs.isListed, true),
        eq(boardClimbs.isDraft, false),
        eq(boardClimbs.isHidden, false),
        contentVisibilityCondition('climb', boardClimbs.uuid, boardClimbs.userId, null),
        sprayClimbVisibilityCondition({ boardType: boardClimbs.boardType, layoutId: boardClimbs.layoutId }, null),
      ),
    );
  const allowed = new Set(
    rows.map((row) => (kind === 'setters' ? row.identifier : `${row.boardType}:${row.identifier}`)),
  );
  return items.filter((item, index) => {
    if (kind === 'setters') return allowed.has(identifiers[index]);
    const boardType = item.path.startsWith('/b/') ? 'spray' : item.path.split('/')[1];
    return allowed.has(`${boardType}:${identifiers[index]}`);
  });
}
