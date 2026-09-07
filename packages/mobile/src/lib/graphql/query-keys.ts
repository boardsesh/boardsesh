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
