// A list's setter source as route params, and back: how a playlist's filter
// sheet tells the Discover setters route (`discover/playlist-setters`) whose
// setters to list. Route params are strings, so the route parses them back and
// treats anything malformed as no list at all.

import type { PlaylistSetterSource } from '@boardsesh/playlists-react';
import { isLogbookSmartType } from '../smart-playlists';

/** The params that name a list: a playlist id, or a smart list's type and owner. */
export type PlaylistSetterSourceParams = {
  playlistId?: string;
  smartType?: string;
  userId?: string;
};

export function playlistSetterSourceParams(source: PlaylistSetterSource): PlaylistSetterSourceParams {
  return source.kind === 'playlist'
    ? { playlistId: source.playlistId }
    : { smartType: source.smartType, userId: source.userId };
}

/** The list the params name, or null when they name none (or a list with no setters to list). */
export function parsePlaylistSetterSource(params: PlaylistSetterSourceParams): PlaylistSetterSource | null {
  if (params.playlistId) return { kind: 'playlist', playlistId: params.playlistId };
  const { smartType, userId } = params;
  if (!smartType || !userId || !isLogbookSmartType(smartType)) return null;
  return { kind: 'smart', smartType, userId };
}
