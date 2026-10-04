import type { MyBoardsInput } from '@boardsesh/shared-schema';

/**
 * React Query keys that more than one module has to agree on.
 *
 * A key that only its own hook uses stays next to that hook (see
 * `ACTIVE_BOARD_QUERY_KEY` in `use-active-board.ts`). A key lands here once
 * something reads the cache imperatively — `queryClient.getQueryData(...)` from
 * a tap handler that must not subscribe — because that reader has no compiler
 * link to the hook that wrote the entry, and a key change would leave it
 * silently resolving `undefined` forever.
 *
 * This file is a leaf on purpose: types only, no hooks, no providers. The
 * imperative readers live deep in provider land, and pulling the `hooks` barrel
 * in for a key would drag half the app's module graph with it.
 */

/** Key `useMyBoards(input)` writes under; call with no argument for the plain roster. */
export const myBoardsQueryKey = (input?: MyBoardsInput) => ['myBoards', input] as const;

/**
 * The boards linked to one gym, and the root every gym's list hangs off.
 *
 * Both live here because two modules that never import each other have to agree
 * on them: `useGymBoards` writes under `gymBoardsQueryKey(gymUuid)`, while
 * `useLinkBoardToGym` invalidates the root once a board joins or leaves a gym —
 * that mutation doesn't know which gym's list is cached, so it drops all of
 * them. A key change on one side only would leave the board switcher listing a
 * board that has since moved.
 */
export const GYM_BOARDS_QUERY_KEY = ['gymBoards'] as const;
export const gymBoardsQueryKey = (gymUuid: string | null) => [...GYM_BOARDS_QUERY_KEY, gymUuid] as const;

/**
 * Root keys for the climb reads a moderation verdict changes.
 *
 * `useClimb`, `useSearchClimbs`, `useSearchClimbsCount` and
 * `useInfiniteSearchClimbs` append their input to these roots; the proposal
 * mutations invalidate the roots. They live here rather than next to those
 * hooks because the invalidating side is `proposal-cache.ts`, which must not
 * pull the `hooks` barrel in for a key — an approved hide flips `is_hidden` and
 * an approved grade rewrites the community grade, both baked into rows the
 * lists already hold, so the two sides have to name the same arrays.
 */
export const CLIMB_QUERY_KEY = ['climb'] as const;
export const SEARCH_CLIMBS_QUERY_KEY = ['searchClimbs'] as const;
export const INFINITE_SEARCH_CLIMBS_QUERY_KEY = ['infiniteSearchClimbs'] as const;
export const SEARCH_CLIMBS_COUNT_QUERY_KEY = ['searchClimbsCount'] as const;

/**
 * Live sessions ("Climbing now" on Home, "Climbing here now" in the board sheet).
 *
 * Here because Home's pull-to-refresh invalidates the rail's query without
 * rendering it: the rail is a self-subscribing component in the list header, so
 * the screen has no query result of its own to call `refetch` on.
 */
export const LIVE_SESSIONS_QUERY_KEY = ['liveSessions'] as const;
export const FOLLOWED_LIVE_SESSIONS_QUERY_KEY = [...LIVE_SESSIONS_QUERY_KEY, 'followed'] as const;
export const followedLiveSessionsQueryKey = (boardUuid: string | null) =>
  [...FOLLOWED_LIVE_SESSIONS_QUERY_KEY, boardUuid] as const;
export const boardLiveSessionsQueryKey = (boardId: number | null) =>
  [...LIVE_SESSIONS_QUERY_KEY, 'board', boardId] as const;

/**
 * Logs from climbers the viewer follows, for one climb (the play drawer's
 * "Climber logs" card and its full list).
 *
 * Here because `use-followed-authors.ts` invalidates the root on every follow
 * and unfollow without importing the hook that writes under it. The root is a
 * bare string, like the other entries in `AUTHOR_QUERY_KEYS`.
 *
 * The viewer id is part of the key so one account's rows can never answer for
 * another. The angle is not: the server returns every angle in one answer, so
 * turning the board refetches nothing.
 */
export const FOLLOWING_CLIMB_LOGS_QUERY_KEY = 'followingClimbLogs';
export const followingClimbLogsQueryKey = (viewerId: string | undefined, boardName: string, climbUuid: string | null) =>
  [FOLLOWING_CLIMB_LOGS_QUERY_KEY, viewerId, boardName, climbUuid] as const;

/**
 * Everyone's logs on one climb: the paged "Everyone" section of the Climber
 * logs list, and the few rows the card falls back to when nobody followed has
 * logged the climb.
 *
 * Both roots are in `AUTHOR_QUERY_KEYS` too. The server leaves out the people
 * the viewer follows, so a follow or unfollow changes the answer.
 *
 * The list key carries everything the server filters on, so each chip
 * combination is its own set of pages. The preview key has no angle: it asks
 * for every angle, so turning the board refetches nothing.
 */
export const CLIMB_LOGS_QUERY_KEY = 'climbLogs';
export const CLIMB_LOGS_PREVIEW_QUERY_KEY = 'climbLogsPreview';
export const climbLogsQueryKey = (
  viewerId: string | undefined,
  boardName: string,
  climbUuid: string | null,
  filters: { angle: number | undefined; withNotes: boolean; sendsOnly: boolean; excludeFollowed: boolean },
) =>
  [
    CLIMB_LOGS_QUERY_KEY,
    viewerId,
    boardName,
    climbUuid,
    filters.angle ?? null,
    filters.withNotes,
    filters.sendsOnly,
    filters.excludeFollowed,
  ] as const;
export const climbLogsPreviewQueryKey = (viewerId: string | undefined, boardName: string, climbUuid: string | null) =>
  [CLIMB_LOGS_PREVIEW_QUERY_KEY, viewerId, boardName, climbUuid] as const;
