import 'server-only';
import { type RequestDocument, type Variables, GraphQLClient } from 'graphql-request';
import { getGraphQLHttpUrl } from './client';
import type { UserBoard } from '@boardsesh/shared-schema';
import { GET_MY_BOARDS, type GetMyBoardsQueryResponse } from '@boardsesh/graphql/operations/boards';
import {
  GET_ALL_USER_PLAYLISTS,
  GET_PLAYLIST,
  GET_PLAYLIST_CLIMBS,
  type Playlist,
  type GetAllUserPlaylistsQueryResponse,
  type GetPlaylistQueryResponse,
  type GetPlaylistClimbsQueryResponse,
  type GetPlaylistClimbsInput,
} from '@boardsesh/graphql/operations/playlists';

/**
 * Execute a GraphQL query with an auth token (non-cached, per-user data).
 * Used for server-side rendering of authenticated pages where results
 * should not be shared across users or requests.
 * Also used by server-cached-client.ts for cached-but-authenticated queries.
 */
export async function executeAuthenticatedGraphQL<T = unknown, V extends Variables = Variables>(
  document: RequestDocument,
  variables?: V,
  authToken?: string,
): Promise<T> {
  const url = getGraphQLHttpUrl();
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (authToken) {
    headers['Authorization'] = `Bearer ${authToken}`;
  }
  const client = new GraphQLClient(url, { headers });
  return client.request<T>(document, variables);
}

/**
 * Server-side fetch of the current user's boards (owned + followed).
 * NOT cached — personalized data is per-user.
 */
export async function serverMyBoards(authToken: string): Promise<UserBoard[] | null> {
  try {
    const response = await executeAuthenticatedGraphQL<GetMyBoardsQueryResponse>(
      GET_MY_BOARDS,
      { input: { limit: 50, offset: 0 } },
      authToken,
    );
    return response.myBoards.boards;
  } catch (error) {
    console.error('serverMyBoards failed:', error);
    return null;
  }
}

export type ServerUserPlaylistsResult = {
  playlists: Playlist[];
  totalCount: number;
  hasMore: boolean;
};

/**
 * Server-side fetch of the user's playlists (authenticated, not cached).
 * Returns the raw paginated result so the client hook can seed both totalCount
 * and hasMore from SSR — passing only the playlists array would force a
 * redundant first fetch just to discover hasMore.
 */
export async function serverUserPlaylists(
  authToken: string,
  input: { boardType?: string; layoutId?: number; page?: number; pageSize?: number } = {},
): Promise<ServerUserPlaylistsResult | null> {
  type Response = GetAllUserPlaylistsQueryResponse;

  try {
    const response = await executeAuthenticatedGraphQL<Response>(GET_ALL_USER_PLAYLISTS, { input }, authToken);
    return response.allUserPlaylists;
  } catch (error) {
    console.error('serverUserPlaylists failed:', error);
    return null;
  }
}

/**
 * Server-side fetch of a single playlist.
 */
export async function serverPlaylist(authToken: string | undefined, playlistId: string): Promise<Playlist | null> {
  try {
    const response = await executeAuthenticatedGraphQL<GetPlaylistQueryResponse>(
      GET_PLAYLIST,
      { playlistId },
      authToken,
    );
    return response.playlist;
  } catch (error) {
    console.error('serverPlaylist failed:', error);
    return null;
  }
}

/**
 * Server-side fetch of the first page of playlist climbs.
 */
export async function serverPlaylistClimbs(
  authToken: string | undefined,
  input: GetPlaylistClimbsInput,
): Promise<GetPlaylistClimbsQueryResponse['playlistClimbs'] | null> {
  try {
    const response = await executeAuthenticatedGraphQL<GetPlaylistClimbsQueryResponse>(
      GET_PLAYLIST_CLIMBS,
      { input },
      authToken,
    );
    return response.playlistClimbs;
  } catch (error) {
    console.error('serverPlaylistClimbs failed:', error);
    return null;
  }
}
