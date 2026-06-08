import { eq, and, inArray } from 'drizzle-orm';
import type { ConnectionContext } from '@boardsesh/shared-schema';
import { cohortKeysForBoard, variantSlugFromKey, PUBLIC_RECOMMENDATION_VARIANTS } from '@boardsesh/db/queries';
import { db } from '../../../../db/client';
import * as dbSchema from '@boardsesh/db/schema';
import { validateInput } from '../../shared/helpers';
import { RecommendedPlaylistsInputSchema } from '../../../../validation/schemas';
import { formatPublicPlaylist } from '../helpers/enrichment';
import { PUBLIC_PLAYLIST_SELECT, PUBLIC_PLAYLIST_GROUP_BY } from './discover';

/** Display order of the cohort variants by slug (crowd-favorites → fresh). */
const VARIANT_ORDER = new Map(PUBLIC_RECOMMENDATION_VARIANTS.map((variant, index) => [variant.slug, index]));

/**
 * Public per-board recommendation cohort playlists (Crowd Favorites / Hidden
 * Gems / Fresh) for an exact board config. The cohort's size + angle live only
 * inside the `generated_recommendation` key, so we reconstruct the three keys
 * and look the playlists up by them. Returns `[]` when the config isn't a
 * generated cohort — callers (Home) fall back to a popularity sort.
 *
 * No authentication required: cohort playlists are public, owned by the
 * `system-recommendations` user.
 */
export const recommendedPlaylists = async (
  _: unknown,
  {
    input,
  }: {
    input: {
      boardType: string;
      layoutId: number;
      sizeId: number;
      angle: number;
    };
  },
  _ctx: ConnectionContext,
): Promise<unknown[]> => {
  validateInput(RecommendedPlaylistsInputSchema, input, 'input');

  const keys = cohortKeysForBoard(input.boardType, input.layoutId, input.sizeId, input.angle);

  // Select the public-playlist projection plus the cohort key so we can order
  // the (≤3) rows by canonical variant order without a second round-trip.
  const rows = await db
    .select({ ...PUBLIC_PLAYLIST_SELECT, generatedRecommendation: dbSchema.playlists.generatedRecommendation })
    .from(dbSchema.playlists)
    .innerJoin(dbSchema.playlistOwnership, eq(dbSchema.playlistOwnership.playlistId, dbSchema.playlists.id))
    .innerJoin(dbSchema.playlistClimbs, eq(dbSchema.playlistClimbs.playlistId, dbSchema.playlists.id))
    .innerJoin(dbSchema.users, eq(dbSchema.users.id, dbSchema.playlistOwnership.userId))
    .where(
      and(
        eq(dbSchema.playlists.isPublic, true),
        eq(dbSchema.playlistOwnership.role, 'owner'),
        inArray(dbSchema.playlists.generatedRecommendation, keys),
      ),
    )
    .groupBy(...PUBLIC_PLAYLIST_GROUP_BY, dbSchema.playlists.generatedRecommendation);

  rows.sort(
    (a, b) =>
      (VARIANT_ORDER.get(variantSlugFromKey(a.generatedRecommendation)) ?? Number.MAX_SAFE_INTEGER) -
      (VARIANT_ORDER.get(variantSlugFromKey(b.generatedRecommendation)) ?? Number.MAX_SAFE_INTEGER),
  );

  return rows.map(formatPublicPlaylist);
};
