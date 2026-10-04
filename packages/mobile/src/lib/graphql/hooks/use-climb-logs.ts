import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import {
  GET_CLIMB_LOGS,
  type ClimbLogsQueryItem,
  type GetClimbLogsQueryResponse,
  type GetClimbLogsQueryVariables,
} from '@boardsesh/graphql/operations';
import type { ClimbLogsInput } from '@boardsesh/shared-schema';
import { useStoredUserId } from '../../../hooks/use-current-user-id';
import { getHttpClient } from '../client';
import { screenshotModeNextPageParam } from '../../screenshot-mode';
import { climbLogsPreviewQueryKey, climbLogsQueryKey } from '../query-keys';

type ClimbLogsPage = GetClimbLogsQueryResponse['climbLogs'];

const PAGE_SIZE = 20;
/**
 * A few more than the card shows, so dropping the viewer's own row (the server
 * already does, this is the belt to its braces) still leaves a full card.
 */
const PREVIEW_SIZE = 6;
const EMPTY_PAGE: ClimbLogsPage = { items: [], cursor: null, hasMore: false };

/**
 * True when the server does not know `climbLogs` at all: this build reached a
 * backend from before the resolver shipped. GraphQL rejects the whole document
 * in validation, so the message names the field.
 */
function isUnknownClimbLogsField(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return /Cannot query field "climbLogs"|Unknown type "ClimbLogsInput"/.test(error.message);
}

/**
 * One page of everyone's logs. An older server answers with an empty page
 * rather than an error: the section is extra, and the list above it still
 * works. Every other failure propagates.
 */
async function requestClimbLogs(input: ClimbLogsInput): Promise<ClimbLogsPage> {
  try {
    const response = await getHttpClient().request<GetClimbLogsQueryResponse, GetClimbLogsQueryVariables>(
      GET_CLIMB_LOGS,
      { input },
    );
    return response.climbLogs;
  } catch (error) {
    if (isUnknownClimbLogsField(error)) return EMPTY_PAGE;
    throw error;
  }
}

/**
 * Everyone's logs on one climb, one row per climber, newest first, a page of 20
 * per end-reach.
 *
 * Network only, for the same reason as `useFollowingClimbLogs`: other climbers'
 * logs are never synced to the phone, and whether the viewer may see a spray
 * wall's logs is the server's call on every request. Never goes through
 * `offlineAwareRequest`, has no local reader.
 *
 * The filters go to the server, not over the pages on the phone: filtering 20
 * rows down to 3 locally would leave end-reach with a page that adds nothing.
 *
 * Waits for a viewer id on purpose, here and in the preview below. The server
 * answers signed-out callers too, but the card these feed is only mounted for
 * a signed-in climber, and the id scopes the cache key so one account's rows
 * never answer for another. A signed-out card would drop this gate.
 */
export function useClimbLogs({
  boardName,
  climbUuid,
  angle,
  withNotes,
  sendsOnly,
  excludeFollowed,
  enabled,
}: {
  boardName: string;
  climbUuid: string | null;
  /** Only logs at this angle. Left out means every angle. */
  angle?: number;
  withNotes: boolean;
  sendsOnly: boolean;
  /** Leave out the viewer's own logs and the people they follow. */
  excludeFollowed: boolean;
  enabled: boolean;
}) {
  const { userId: viewerId } = useStoredUserId(true);
  return useInfiniteQuery({
    queryKey: climbLogsQueryKey(viewerId, boardName, climbUuid, { angle, withNotes, sendsOnly, excludeFollowed }),
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) =>
      requestClimbLogs({
        boardType: boardName,
        climbUuid: climbUuid!,
        ...(angle === undefined ? {} : { angle }),
        withNotes,
        sendsOnly,
        excludeFollowed,
        latestPerClimber: true,
        limit: PAGE_SIZE,
        cursor: pageParam,
      }),
    getNextPageParam: (lastPage, allPages) =>
      screenshotModeNextPageParam(lastPage.hasMore ? (lastPage.cursor ?? undefined) : undefined, allPages.length),
    enabled: enabled && !!viewerId && !!climbUuid,
    staleTime: 60_000,
  });
}

/**
 * The newest few logs from everyone but the viewer and the people they follow,
 * at every angle. Feeds the card's fall-through rows when nobody followed has
 * logged the climb.
 *
 * Off in screenshot mode, so store captures need no recorded response for it.
 */
export function useClimbLogsPreview({
  boardName,
  climbUuid,
  enabled,
}: {
  boardName: string;
  climbUuid: string | null;
  enabled: boolean;
}) {
  const { userId: viewerId } = useStoredUserId(true);
  return useQuery({
    queryKey: climbLogsPreviewQueryKey(viewerId, boardName, climbUuid),
    queryFn: () =>
      requestClimbLogs({
        boardType: boardName,
        climbUuid: climbUuid!,
        excludeFollowed: true,
        latestPerClimber: true,
        limit: PREVIEW_SIZE,
      }),
    select: (page) => page.items,
    enabled: enabled && !!viewerId && !!climbUuid && process.env.EXPO_PUBLIC_SCREENSHOT_MODE !== '1',
    staleTime: 5 * 60_000,
  });
}

/**
 * Every loaded page as one array, in server order. A log is kept once: a
 * climber who logs between two requests can shift the pages under the cursor.
 */
export function flattenClimbLogPages(pages: readonly ClimbLogsPage[] | undefined): ClimbLogsQueryItem[] {
  const seen = new Set<string>();
  const logs: ClimbLogsQueryItem[] = [];
  for (const page of pages ?? []) {
    for (const log of page.items) {
      if (seen.has(log.uuid)) continue;
      seen.add(log.uuid);
      logs.push(log);
    }
  }
  return logs;
}
