import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { toBoardName } from '@boardsesh/board-config';
import type { ClimbProject } from '@boardsesh/profile-stats';
import {
  GET_USER_ASCENTS_FEED,
  type AscentFeedItem,
  type GetUserAscentsFeedQueryResponse,
} from '@boardsesh/graphql/operations';
import { getDatabaseHandle } from '../../db';
import type { ActivityTick } from '../../db/queries/get-activity-ticks-local';
import { readClimbArtLocal, type LocalClimbArt } from '../../db/queries/get-climb-art-local';
import { useStoredUserId } from '../../hooks/use-current-user-id';
import { getHttpClient } from '../../lib/graphql/client';
import { getBoardConfigForClimb, type PlaylistBoardConfig } from '../../lib/playlists/board-details-for-playlist';

type Project = ClimbProject<ActivityTick>;

/** What a project row draws and opens: the climb's name, holds and board. */
export type ProjectClimbView = {
  name: string | null;
  frames: string | null;
  /** Null when neither the phone nor the server knows the climb's board: the row cannot open it. */
  boardConfig: PlaylistBoardConfig | null;
};

/** The server's largest page of the ascents feed. */
const RECENT_ATTEMPTS_LIMIT = 50;
const RECENT_ATTEMPTS_STALE_MS = 5 * 60 * 1000;

export const projectKey = (boardType: string, climbUuid: string) => `${boardType}\u0000${climbUuid}`;

/** The board an ascent was climbed on, as the logbook row draws it. */
function feedBoardConfig(item: AscentFeedItem): PlaylistBoardConfig | null {
  const boardName = toBoardName(item.boardType);
  if (!boardName) return null;
  if (item.renderBoard) {
    const { layoutId, sizeId, setIds } = item.renderBoard;
    return { boardName, layoutId, sizeId, setIds };
  }
  return item.layoutId == null ? null : getBoardConfigForClimb(item.boardType, item.layoutId, null);
}

/**
 * Names, holds and boards for the shelf's rows (#7691). The board catalogue on
 * this phone answers first and offline. A climb whose board is not downloaded,
 * which is most climbers' case, comes from the climber's latest attempts on the
 * server: the shelf shows their latest-tried climbs, so those attempts are the
 * most recent ones. That read waits until a row needs it, and with no signal
 * the row keeps its grade and tries and reads as an unknown climb.
 */
export function useProjectClimbs(projects: readonly Project[]): ReadonlyMap<string, ProjectClimbView> {
  const { userId: viewerId } = useStoredUserId(projects.length > 0);
  const refs = useMemo(
    () => projects.map(({ latest }) => ({ boardType: latest.boardType, climbUuid: latest.climbUuid })),
    [projects],
  );
  const refKeys = useMemo(() => refs.map((ref) => projectKey(ref.boardType, ref.climbUuid)), [refs]);

  const { data: localArt } = useQuery({
    queryKey: ['localClimbArt', viewerId ?? '', refKeys],
    enabled: refs.length > 0 && !!viewerId,
    // The board_climbs sync invalidates this key, so a board downloaded later
    // fills the rows in.
    staleTime: Infinity,
    networkMode: 'always',
    queryFn: async (): Promise<LocalClimbArt[]> => {
      const db = getDatabaseHandle();
      return db && viewerId ? readClimbArtLocal(db, refs, viewerId) : [];
    },
  });
  const localByKey = useMemo(
    () => new Map((localArt ?? []).map((art) => [projectKey(art.boardType, art.climbUuid), art])),
    [localArt],
  );
  const needsServer =
    localArt !== undefined &&
    projects.some(({ latest }) => !localByKey.has(projectKey(latest.boardType, latest.climbUuid)) || !latest.climbName);

  const { data: recentAttempts } = useQuery({
    queryKey: ['homeProjectAttempts', viewerId ?? ''],
    enabled: needsServer && !!viewerId,
    staleTime: RECENT_ATTEMPTS_STALE_MS,
    retry: false,
    queryFn: async (): Promise<AscentFeedItem[]> => {
      const response = await getHttpClient().request<GetUserAscentsFeedQueryResponse>(GET_USER_ASCENTS_FEED, {
        userId: viewerId,
        input: { statusMode: 'attempt', limit: RECENT_ATTEMPTS_LIMIT, offset: 0 },
      });
      return response.userAscentsFeed.items;
    },
  });

  return useMemo(() => {
    const serverByKey = new Map<string, AscentFeedItem>();
    for (const item of recentAttempts ?? []) {
      const key = projectKey(item.boardType, item.climbUuid);
      // The feed is newest first: the first ascent of a climb is its latest board.
      if (!serverByKey.has(key)) serverByKey.set(key, item);
    }
    const views = new Map<string, ProjectClimbView>();
    for (const { latest } of projects) {
      const key = projectKey(latest.boardType, latest.climbUuid);
      const local = localByKey.get(key);
      const server = serverByKey.get(key);
      const name = latest.climbName ?? server?.climbName ?? null;
      if (local) {
        views.set(key, {
          name,
          frames: local.frames,
          boardConfig: getBoardConfigForClimb(local.boardType, local.layoutId, local.compatibleSizeIds),
        });
      } else if (server) {
        views.set(key, { name, frames: server.frames ?? null, boardConfig: feedBoardConfig(server) });
      } else {
        views.set(key, { name, frames: null, boardConfig: null });
      }
    }
    return views;
  }, [projects, localByKey, recentAttempts]);
}
