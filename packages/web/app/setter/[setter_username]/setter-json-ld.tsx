import React from 'react';
import { absoluteLocaleUrl } from '@/app/lib/seo/base-url';
import type { Locale } from '@/app/lib/i18n/config';
import { JsonLd } from '@/app/lib/seo/json-ld';
import { frontDoorPagePath } from '@/app/lib/seo/list-page-robots';
import { resolveClimbDisplayName } from '@/app/lib/string-utils';
import { buildCanonicalClimbViewUrl } from '@/app/lib/url-utils';
import type { BoardDetails, Climb } from '@/app/lib/types';
import { SETTER_PAGE_SIZE } from './server-setter-data';

type SetterJsonLdProps = {
  username: string;
  displayName: string;
  climbs: readonly Climb[];
  boardDetailsByClimb: Record<string, BoardDetails>;
  unlinkedClimbUuids: ReadonlySet<string>;
  /** 1-based `?page=N`, already clamped. */
  page: number;
  locale: Locale;
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
 */
export default function SetterJsonLd({
  username,
  displayName,
  climbs,
  boardDetailsByClimb,
  unlinkedClimbUuids,
  page,
  locale,
}: SetterJsonLdProps) {
  const basePath = `/setter/${encodeURIComponent(username)}`;
  // The person's own URL is the bare profile on every page: that is the one
  // canonical address for the entity.
  const profileUrl = absoluteLocaleUrl(basePath, locale);
  // The DOCUMENT's URL is this page. `frontDoorPagePath` is the same call
  // `resolveListPageIndexation` makes for the `<link rel="canonical">`, so the
  // two can never name different URLs — on `?page=2` the graph used to claim
  // that page 1 contained items 51–100.
  const pageUrl = absoluteLocaleUrl(frontDoorPagePath(basePath, page), locale);
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
        url: absoluteLocaleUrl(buildCanonicalClimbViewUrl(boardDetails, climb.angle, climb.uuid, climbName), locale),
      },
    ];
  });

  // A `@graph` rather than nesting the list under the ProfilePage: `ItemList`
  // is not a valid value for `mainEntity` (that is the Person) nor for
  // `mainEntityOfPage` (that expects the page itself). Two sibling nodes, the
  // list pointing back at the page through `mainEntityOfPage`, is the shape
  // Google's own examples use.
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
                  mainEntityOfPage: { '@id': pageUrl },
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
