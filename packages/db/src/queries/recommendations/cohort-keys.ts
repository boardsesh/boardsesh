/**
 * Single source of truth for the public per-board recommendation cohorts.
 *
 * The nightly generator (`scripts/refresh-recommendations.ts`) writes one
 * playlist per (cohort × variant) keyed by a deterministic
 * `generated_recommendation` string, and the `recommendedPlaylists` resolver
 * reconstructs those keys to look the playlists back up by exact board config.
 * Both sides import the slugs and key format from here so they can't drift.
 */
import type { RecommendationType } from './types';

/** A public recommendation cohort variant. `slug` is part of the persisted
 *  `generated_recommendation` key; label/color/icon seed the public playlist. */
export type PublicRecommendationVariant = {
  type: RecommendationType;
  slug: string;
  label: string;
  color: string;
  icon: string;
};

/**
 * The public per-board cohort variants, in display order. Crowd Favorites leads
 * (the broadest), then Hidden Gems, then Fresh — the order Home renders the
 * rows in.
 */
export const PUBLIC_RECOMMENDATION_VARIANTS: readonly PublicRecommendationVariant[] = [
  {
    type: 'RECOMMENDED_CROWD_FAVORITES',
    slug: 'crowd-favorites',
    label: 'Crowd Favorites',
    color: '#d65a4f',
    icon: 'LocalFireDepartmentOutlined',
  },
  {
    type: 'RECOMMENDED_HIDDEN_GEMS',
    slug: 'hidden-gems',
    label: 'Hidden Gems',
    color: '#9C27B0',
    icon: 'DiamondOutlined',
  },
  {
    type: 'RECOMMENDED_FRESH',
    slug: 'fresh',
    label: 'Fresh',
    color: '#FBBF24',
    icon: 'EnergySavingsLeafOutlined',
  },
];

/** Deterministic `generated_recommendation` key for one cohort playlist. */
export function cohortKey(
  boardType: string,
  layoutId: number,
  sizeId: number,
  angle: number,
  variantSlug: string,
): string {
  return `${boardType}:${layoutId}:${sizeId}:${angle}:${variantSlug}`;
}

/** All cohort keys (one per public variant) for an exact board config. */
export function cohortKeysForBoard(boardType: string, layoutId: number, sizeId: number, angle: number): string[] {
  return PUBLIC_RECOMMENDATION_VARIANTS.map((variant) => cohortKey(boardType, layoutId, sizeId, angle, variant.slug));
}

/** Pull the variant slug back out of a `generated_recommendation` key. */
export function variantSlugFromKey(key: string | null | undefined): string {
  if (!key) return '';
  return key.slice(key.lastIndexOf(':') + 1);
}
