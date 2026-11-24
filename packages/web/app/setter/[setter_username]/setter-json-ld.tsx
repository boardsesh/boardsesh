import React from 'react';
import { absoluteUrl } from '@/app/lib/seo/base-url';
import { JsonLd } from '@/app/lib/seo/json-ld';
import { frontDoorPagePath } from '@/app/lib/seo/list-page-robots';
import { resolveClimbDisplayName } from '@/app/lib/string-utils';
import { buildCanonicalClimbViewUrl } from '@/app/lib/url-utils';
import type { BoardRouteIdentity, Climb } from '@/app/lib/types';
import { SETTER_PAGE_SIZE } from '@/app/lib/seo/sitemap/setter-page-contract';

type SetterJsonLdProps = {
  username: string;
  displayName: string;
  climbs: readonly Climb[];
  boardDetailsByClimb: Record<string, BoardRouteIdentity>;
  unlinkedClimbUuids: ReadonlySet<string>;
  /** 1-based `?page=N`, already clamped. */
  page: number;
};

/**
 * `ProfilePage` for the setter, with an `ItemList` of the climbs this page
 * actually links to.
 *
 * Two rules carried over from `climb-list-json-ld.tsx`, for the same reasons:
 * `position` is global rather than page-local, and every `url` comes from the
 * same `buildCanonicalClimbViewUrl` + `resolveClimbDisplayName` pair the rows
 * render — markup that advertises a URL the page does not link to is worse than
 * no markup.
 *
 * A climb with no resolvable canonical config is omitted rather than given a
 * best-effort URL. Those rows render without an anchor too, so the two agree.
 *
 * Every URL is locale-FREE. Setter pages go through
 * `createBoardContentPageMetadata`, which pins `<link rel="canonical">` to the
 * default-locale URL and drops `alternates.languages`, so a `/de` render naming
 * `/de` URLs would contradict the canonical it ships beside them.
 */
export default function SetterJsonLd({
  username,
  displayName,
  climbs,
  boardDetailsByClimb,
  unlinkedClimbUuids,
  page,
}: SetterJsonLdProps) {
  const basePath = `/setter/${encodeURIComponent(username)}`;
  // The person's own URL is the bare profile on every page: that is the one
  // canonical address for the entity.
  const profileUrl = absoluteUrl(basePath);
  // The DOCUMENT's URL is this page. `frontDoorPagePath` is the same call
  // `resolveListPageIndexation` makes for the `<link rel="canonical">`, so the
  // two can never name different URLs — on `?page=2` the graph used to claim
  // that page 1 contained items 51–100.
  const pageUrl = absoluteUrl(frontDoorPagePath(basePath, page));
  const offset = (page - 1) * SETTER_PAGE_SIZE;

  const listItems = climbs.flatMap((climb, index) => {
    const boardDetails = boardDetailsByClimb[climb.uuid];
    if (!boardDetails || unlinkedClimbUuids.has(climb.uuid)) return [];
    const climbName = resolveClimbDisplayName(climb.name, boardDetails.board_name);

    return [
      {
        '@type': 'ListItem',
        position: offset + index + 1,
        name: climbName,
        url: absoluteUrl(buildCanonicalClimbViewUrl(boardDetails, climb.angle, climb.uuid, climbName)),
      },
    ];
  });

  // Keep the list beside the ProfilePage, linked by its document URL only.
  // mainEntityOfPage is the inverse of mainEntity: pointing the ItemList at
  // this page would add it as a second main entity. Google requires every
  // ProfilePage mainEntity to be a Person or Organization, not an ItemList.
  return (
    <JsonLd
      data={{
        '@context': 'https://schema.org',
        '@graph': [
          {
            '@type': 'ProfilePage',
            '@id': pageUrl,
            url: pageUrl,
            mainEntity: {
              '@type': 'Person',
              name: displayName,
              url: profileUrl,
            },
          },
          ...(listItems.length > 0
            ? [
                {
                  '@type': 'ItemList',
                  url: pageUrl,
                  numberOfItems: listItems.length,
                  itemListElement: listItems,
                },
              ]
            : []),
        ],
      }}
    />
  );
}
