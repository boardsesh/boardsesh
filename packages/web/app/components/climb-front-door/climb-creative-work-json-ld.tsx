import React from 'react';
import { absoluteLocaleUrl, SITE_URL } from '@/app/lib/seo/base-url';
import type { Locale } from '@/app/lib/i18n/config';
import { JsonLd } from '@/app/lib/seo/json-ld';
import type { ClimbStatsForAngle } from '@/app/lib/data/queries';
import type { Climb } from '@/app/lib/types';

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
  /** The locale this page is rendering on — the canonical is locale-prefixed. */
  locale: Locale;
};

/**
 * Rating bounds. `board_climb_stats.quality_average` is the canonical 1-5 blend
 * — but only on rows where `quality_normalized` is true (Aurora reports 1-3).
 */
const WORST_RATING = 1;
const BEST_RATING = 5;

/**
 * `aggregateRating`, or nothing at all.
 *
 * Three conditions, all required, and the negative cases are the point:
 *
 *  1. `quality_normalized` — otherwise the value is on Aurora's raw 1-3 scale
 *     and publishing it with `bestRating: 5` understates the climb. ~235k
 *     JSON-imported Kilter tick rows are still on that scale.
 *  2. `quality_average` is present and lands inside [1, 5].
 *  3. The rating count is at least 1, and it is the *blend's own denominator*,
 *     not `ascensionist_count`. Stated precisely, because the loose version
 *     ("never ascents") is not a promise this expression can make: on a climb
 *     whose quality came from Aurora and which has no native ratings yet, the
 *     denominator is `upstream_ascensionist_count` — and that is correct, since
 *     Aurora's average IS taken over the ascents that rated it. What is excluded
 *     is the Boardsesh ascent count, and the upstream ascents of a climb upstream
 *     never rated at all (`upstream_quality_average IS NULL` → 0).
 *
 * A climb that fails any of them ships without a rating. Omitting is free;
 * publishing a wrong one is a manual action.
 */
function buildAggregateRating(stats: ClimbStatsForAngle | undefined): Record<string, unknown> | null {
  if (!stats || !stats.quality_normalized) return null;

  const ratingValue = stats.quality_average === null ? Number.NaN : Number(stats.quality_average);
  if (!Number.isFinite(ratingValue) || ratingValue < WORST_RATING || ratingValue > BEST_RATING) return null;

  const ratingCount = Number(stats.rating_count);
  if (!Number.isFinite(ratingCount) || ratingCount < 1) return null;

  return {
    '@type': 'AggregateRating',
    ratingValue: Math.round(ratingValue * 100) / 100,
    ratingCount: Math.trunc(ratingCount),
    bestRating: BEST_RATING,
    worstRating: WORST_RATING,
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
  locale,
}: ClimbCreativeWorkJsonLdProps) {
  const aggregateRating = buildAggregateRating(currentAngleStats);
  const setter = climb.setter_username?.trim();
  const dateCreated = validDate(climb.published_at ?? climb.created_at);

  const data: Record<string, unknown> = {
    '@context': 'https://schema.org',
    '@type': 'CreativeWork',
    name: climbName,
    // The canonical, on THIS locale, so the structured data names the exact URL
    // the page's own `<link rel="canonical">` claims. `/es/...` pages canonicalise
    // to the `/es` URL, and naming the en-US one here would contradict it.
    url: absoluteLocaleUrl(canonicalClimbUrl, locale),
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
