import React from 'react';
import { absoluteUrl, SITE_URL } from '@/app/lib/seo/base-url';
import { JsonLd } from '@/app/lib/seo/json-ld';
import type { ClimbStatsForAngle } from '@/app/lib/data/queries';
import type { Climb } from '@/app/lib/types';
import { BEST_QUALITY, normalizedQuality, WORST_QUALITY } from './normalized-quality';

type ClimbCreativeWorkJsonLdProps = {
  climb: Climb;
  /** Display name — already through `resolveClimbDisplayName`, same as the `<h1>`. */
  climbName: string;
  /** The page's CANONICAL path, not the hand-off path. */
  canonicalClimbUrl: string;
  /** Board-render overlay path, or null when the climb has no frames. */
  overlayUrl: string | null;
  /** Stats for the angle being viewed, or undefined when the row is missing. */
  currentAngleStats: ClimbStatsForAngle | undefined;
  /** Already-translated description, or null when the facts to fill it are missing. */
  description: string | null;
};

/**
 * `aggregateRating`, or nothing at all. The conditions live in
 * `normalizedQuality`, shared with the star in the page heading: a climb that
 * fails any of them ships without a rating. Omitting is free; publishing a
 * wrong one is a manual action.
 */
function buildAggregateRating(stats: ClimbStatsForAngle | undefined): Record<string, unknown> | null {
  const quality = normalizedQuality(stats);
  if (!quality) return null;

  return {
    '@type': 'AggregateRating',
    ratingValue: Math.round(quality.average * 100) / 100,
    ratingCount: quality.ratingCount,
    bestRating: BEST_QUALITY,
    worstRating: WORST_QUALITY,
  };
}

/** ISO-ish timestamp or nothing — an unparseable string is worse than no field. */
function validDate(value: string | null | undefined): string | null {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

/**
 * `CreativeWork` for one climb. A boulder problem is a designed artefact, not a
 * product or a place, and it has an author (the setter), a creation date and —
 * where the data honestly supports it — a rating.
 */
export default function ClimbCreativeWorkJsonLd({
  climb,
  climbName,
  canonicalClimbUrl,
  overlayUrl,
  currentAngleStats,
  description,
}: ClimbCreativeWorkJsonLdProps) {
  const aggregateRating = buildAggregateRating(currentAngleStats);
  const setter = climb.setter_username?.trim();
  const dateCreated = validDate(climb.published_at ?? climb.created_at);

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
    ...(description ? { description } : {}),
    // Preserve Railway's absolute image URL; the URL constructor also keeps the
    // same-origin compatibility path valid in local development and old HTML.
    ...(overlayUrl ? { image: new URL(overlayUrl, SITE_URL).toString() } : {}),
    ...(setter ? { author: { '@type': 'Person', name: setter } } : {}),
    ...(dateCreated ? { dateCreated } : {}),
    ...(aggregateRating ? { aggregateRating } : {}),
  };

  return <JsonLd data={data} />;
}
