import { GraphQLError } from 'graphql';
import type { ConnectionContext } from '@boardsesh/shared-schema';
import { isRecommendationType } from '@boardsesh/db/queries';
import { canViewUserActivity } from '../../../../services/privacy';
import { applyRateLimit, validateInput } from '../../shared/helpers';
import { PLAYLIST_SETTERS_LIMIT, PlaylistSettersInputSchema } from '../../../../validation/schemas';
import { verifyPlaylistAccess } from '../helpers/enrichment';
import { fetchPlaylistSetters, type PlaylistViewSource } from '../helpers/playlist-view';
import { allBoardsScope, specificBoardScope } from './playlist-climbs';
import { logbookViewSource } from './smart-playlists';

export type PlaylistSettersInput = {
  playlistId?: string;
  smartType?: string;
  userId?: string;
  boardName?: string;
  layoutId?: number;
  sizeId?: number;
  setIds?: string;
  search?: string;
};

/**
 * The setters of the climbs a playlist shows the viewer, for the setter picker
 * in its filter sheet (#6651). A user playlist reads the same rows as
 * `playlistClimbs` without a view (access, drafts, spray walls and board scope),
 * and a logbook smart list the same rows as `smartPlaylist` without one (the
 * owner's activity audience, tick privacy, drafts, spray walls). Recommendations
 * take no view, so they have no setter filter either.
 */
export const playlistSetters = async (
  _: unknown,
  { input }: { input: PlaylistSettersInput },
  ctx: ConnectionContext,
): Promise<Array<{ username: string; climbCount: number }>> => {
  const parsedInput = validateInput(PlaylistSettersInputSchema, input, 'input');
  if (parsedInput.smartType && isRecommendationType(parsedInput.smartType)) {
    throw new GraphQLError('Setters are only listed for Liked, Five Stars, Projects and Most repeated', {
      extensions: { code: 'BAD_USER_INPUT' },
    });
  }
  // The picker refetches as the climber types a prefix: a view's budget, in its
  // own bucket so typing never eats into the list's paging.
  await applyRateLimit(ctx, 120, 'playlist-setters');

  let source: PlaylistViewSource;
  if (parsedInput.playlistId) {
    // `playlistClimbs`' viewer and access check.
    const playlistId = await verifyPlaylistAccess(parsedInput.playlistId, ctx.userId ?? null);
    source = parsedInput.boardName
      ? specificBoardScope(playlistId, parsedInput, ctx.userId)
      : allBoardsScope(playlistId, parsedInput, ctx.userId);
  } else {
    // `smartPlaylist`'s viewer and activity-audience check. The schema pairs
    // smartType with userId, and the recommendation types were refused above;
    // the repeat check here narrows `smartType` to the logbook types for
    // `logbookViewSource` (TypeScript does not carry the earlier guard over).
    const viewerUserId = ctx.isAuthenticated ? ctx.userId : null;
    const { smartType, userId } = parsedInput;
    if (!smartType || !userId || isRecommendationType(smartType)) throw new Error('Playlist not found');
    if (!(await canViewUserActivity(viewerUserId, userId))) throw new Error('Playlist not found');
    source = logbookViewSource(smartType, { userId, boardName: parsedInput.boardName }, viewerUserId);
  }

  return fetchPlaylistSetters(source, parsedInput.search || undefined, PLAYLIST_SETTERS_LIMIT);
};
