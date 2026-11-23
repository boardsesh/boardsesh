import React from 'react';
import { absoluteUrl, SITE_URL } from '@/app/lib/seo/base-url';
import { JsonLd } from '@/app/lib/seo/json-ld';
import { buildOgBoardRenderUrl } from '@/app/components/board-renderer/util';
import { buildOgClimbCardIdentity } from '@/app/lib/seo/og-climb-identity';
import { isRoutableSetterUsername } from '@/app/lib/seo/setter-username';
import type { BoardImageDetails } from '@/app/lib/board-image-details';
import type { ClimbStatsForAngle } from '@/app/lib/data/queries';
import type { Climb } from '@/app/lib/types';

type ClimbCreativeWorkJsonLdProps = {
  climb: Climb;
  /** Display name — already through `resolveClimbDisplayName`, same as the `<h1>`. */
  climbName: string;
  /** The page's CANONICAL path, not the hand-off path. */
  canonicalClimbUrl: string;
  /** The board the page draws the climb on, which the share card draws too. */
  boardDetails: BoardImageDetails;
  /** The angle the canonical names, and so the angle the share card names. */
  canonicalAngle: number;
  /** Every angle's stats, for the grade the share card prints at `canonicalAngle`. */
  angleStats: ClimbStatsForAngle[];
  /** The page's meta description, from `buildClimbSearchDescription`. */
  description: string;
};

/** ISO-ish timestamp or nothing — an unparseable string is worse than no field. */
function validDate(value: string | null | undefined): string | null {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

/**
 * `CreativeWork` for one climb. A boulder problem is a designed artefact, not a
 * product or a place, and it has an author (the setter) and a creation date.
 *
 * No `aggregateRating`, on purpose. Google shows review snippets for a fixed
 * list of types (Product, Book, Course, SoftwareApplication and a few more) and
 * CreativeWork is not on it, so the field bought nothing. Worse, its count
 * blended in Aurora's upstream ratings, and Google's review rules forbid
 * aggregating ratings collected on another site.
 */
export default function ClimbCreativeWorkJsonLd({
  climb,
  climbName,
  canonicalClimbUrl,
  boardDetails,
  canonicalAngle,
  angleStats,
  description,
}: ClimbCreativeWorkJsonLdProps) {
  const setter = climb.setter_username?.trim();
  const dateCreated = validDate(climb.published_at ?? climb.created_at);
  // The share card `generateMetadata` puts in `og:image`, built from the same
  // identity at the same canonical angle: one stable URL per climb, cached for
  // a year, where the bare holds render changed with every renderer version. A
  // climb with no frames gets no image, because the card endpoint rejects it.
  const imageUrl = climb.frames
    ? buildOgBoardRenderUrl(
        boardDetails,
        climb.frames,
        buildOgClimbCardIdentity(climb, boardDetails.board_name, canonicalAngle, angleStats),
      )
    : null;

  const data: Record<string, unknown> = {
    '@context': 'https://schema.org',
    '@type': 'CreativeWork',
    name: climbName,
    // Locale-FREE, because climb pages go through `createBoardContentPageMetadata`:
    // it pins `<link rel="canonical">` to the default-locale URL and ships no
    // `alternates.languages` at all. A `/es` render naming the `/es` URL here would
    // advertise an address the canonical beside it disowns. Same rule as
    // `front-door-breadcrumb.tsx`, which sits on these very pages.
    url: absoluteUrl(canonicalClimbUrl),
    description,
    // Keeps the backend's absolute card URL; the URL constructor also resolves
    // the same-origin fallback path when no backend origin is configured.
    ...(imageUrl ? { image: new URL(imageUrl, SITE_URL).toString() } : {}),
    // The setter page the front door's setter link opens, locale-free for the
    // same reason as `url`, and the same address `SetterJsonLd` names the person
    // by. Only for a name the setter sitemap would submit too: a padded name or
    // one with `/` names a URL a crawler cannot reach.
    ...(setter
      ? {
          author: {
            '@type': 'Person',
            name: setter,
            ...(isRoutableSetterUsername(climb.setter_username)
              ? { url: absoluteUrl(`/setter/${encodeURIComponent(setter)}`) }
              : {}),
          },
        }
      : {}),
    ...(dateCreated ? { dateCreated } : {}),
  };

  return <JsonLd data={data} />;
}
