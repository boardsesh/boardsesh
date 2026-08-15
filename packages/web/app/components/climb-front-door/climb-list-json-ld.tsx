import React from 'react';
import { FRONT_DOOR_PAGE_SIZE } from '@/app/lib/seo/list-page-robots';
import { absoluteLocaleUrl } from '@/app/lib/seo/base-url';
import type { Locale } from '@/app/lib/i18n/config';
import { JsonLd } from '@/app/lib/seo/json-ld';
import { resolveClimbDisplayName } from '@/app/lib/string-utils';
import { buildCanonicalClimbViewUrl } from '@/app/lib/url-utils';
import type { BoardDetails, Climb } from '@/app/lib/types';

type ClimbListJsonLdProps = {
  climbs: readonly Climb[];
  boardDetails: BoardDetails;
  /** 1-based `?page=N`, already clamped by `parseFrontDoorPage`. */
  page: number;
  /** The locale this page is rendering on — every `url` is locale-prefixed. */
  locale: Locale;
};

/**
 * `ItemList` for the climbs this `/list` page actually rendered.
 *
 * Two things it must get right:
 *
 *  - **`position` is global, not page-local.** Page 2 starts at 51. A list whose
 *    every page starts at 1 tells Google it is looking at the same list over and
 *    over.
 *  - **Every `url` is the string `static-climb-row` renders for the same climb**
 *    — same builder, same `resolveClimbDisplayName` fallback, and locale-prefixed
 *    the same way `createPageMetadata` prefixes the page's own canonical. If they
 *    diverge, the markup advertises URLs the page does not link to.
 *
 * Emitted unconditionally, including on the `noindex, follow` `?page=N` variants
 * past the indexable cap: structured data on a noindex page is simply ignored,
 * and a conditional here would be one more thing to get wrong.
 */
export default function ClimbListJsonLd({ climbs, boardDetails, page, locale }: ClimbListJsonLdProps) {
  if (climbs.length === 0) return null;

  const offset = (page - 1) * FRONT_DOOR_PAGE_SIZE;

  return (
    <JsonLd
      data={{
        '@context': 'https://schema.org',
        '@type': 'ItemList',
        numberOfItems: climbs.length,
        itemListElement: climbs.map((climb, index) => ({
          '@type': 'ListItem',
          position: offset + index + 1,
          name: resolveClimbDisplayName(climb.name, boardDetails.board_name),
          url: absoluteLocaleUrl(
            buildCanonicalClimbViewUrl(
              boardDetails,
              climb.angle,
              climb.uuid,
              resolveClimbDisplayName(climb.name, boardDetails.board_name),
            ),
            locale,
          ),
        })),
      }}
    />
  );
}
