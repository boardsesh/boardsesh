import React from 'react';
import { absoluteLocaleUrl } from '@/app/lib/seo/base-url';
import type { Locale } from '@/app/lib/i18n/config';
import { JsonLd } from '@/app/lib/seo/json-ld';
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
  const url = absoluteLocaleUrl(`/setter/${encodeURIComponent(username)}`, locale);
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

  return (
    <JsonLd
      data={{
        '@context': 'https://schema.org',
        '@type': 'ProfilePage',
        url,
        mainEntity: {
          '@type': 'Person',
          name: displayName,
          url,
        },
        ...(listItems.length > 0
          ? { mainEntityOfPage: { '@type': 'ItemList', numberOfItems: listItems.length, itemListElement: listItems } }
          : {}),
      }}
    />
  );
}
