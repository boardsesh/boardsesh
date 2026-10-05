// The read-only climbs preview Climbs shows a climber who has no board at all.
//
// A preview is not a board. Nothing here binds, creates or follows one: it only
// names a setup to search, so a newcomer sees real climbs before they pick a
// wall. The climb search takes a (board, layout, size, sets, angle) tuple and no
// board uuid, which is the whole reason this is cheap.
//
// Pure on purpose: which setups to offer and whether to show the preview at all
// are decisions a test can state without mounting a screen.

import type { BoardName, PopularBoardConfig } from '@boardsesh/shared-schema';
import { toBoardName } from '@boardsesh/board-config';
import { presetBoardConfig } from './board-config-preset';
import { defaultAngle } from './default-angle';

/** One setup the preview can list climbs for. */
export type NoBoardPreviewConfig = {
  boardName: BoardName;
  layoutId: number;
  sizeId: number;
  /** Comma-joined, the form the climb search and the rows take. */
  setIds: string;
  angle: number;
};

/**
 * One previewable setup per board type, in the order the popular list first
 * names each type. The server orders that list by how many boards use each
 * setup, so the first entry is the most common wall on Boardsesh.
 *
 * Each type gets its most used setup that this build's catalogue can draw
 * (`presetBoardConfig`, the rule the board builder's preset already follows)
 * at the angle most climbers set it to (`defaultAngle`). A type the list does
 * not carry gets no entry: a guessed layout would show a MoonBoard owner the
 * wrong hold set under a confident heading. That is every MoonBoard while the
 * popular list holds only Kilter and Tension setups.
 */
export function resolvePreviewConfigs(
  popularConfigs: readonly PopularBoardConfig[] | null | undefined,
): NoBoardPreviewConfig[] {
  const previewConfigs: NoBoardPreviewConfig[] = [];
  const seenBoardNames = new Set<BoardName>();
  for (const popularConfig of popularConfigs ?? []) {
    const boardName = toBoardName(popularConfig.boardType);
    if (!boardName || seenBoardNames.has(boardName)) continue;
    seenBoardNames.add(boardName);
    const preset = presetBoardConfig(boardName, popularConfigs ?? []);
    if (!preset) continue;
    previewConfigs.push({
      boardName,
      layoutId: preset.layoutId,
      sizeId: preset.sizeId,
      setIds: preset.setIds.join(','),
      angle: defaultAngle(boardName),
    });
  }
  return previewConfigs;
}

/**
 * Why the climber got the "Pick your board" placard instead of the preview.
 * Carried on `Climbs No Board State Viewed` as `fallback_reason`.
 *
 * - `kill_switch`: `no-board-preview-kill` is on.
 * - `signed_out`: nobody is signed in, so there is no board list to count.
 * - `offline`: no usable connection; the preview is a network read.
 * - `boards_unknown`: the board list failed to load.
 * - `has_boards`: the account has boards and only its active one was cleared
 *   (a sign-out, an unfollow). Their own list is one tap away.
 * - `no_config`: the popular list failed, or carried nothing this build can draw.
 * - `search_error` / `no_climbs`: the preview mounted and its search failed or
 *   came back empty.
 */
export type NoBoardFallbackReason =
  | 'kill_switch'
  | 'signed_out'
  | 'offline'
  | 'boards_unknown'
  | 'has_boards'
  | 'no_config'
  | 'search_error'
  | 'no_climbs';

/** A query the decision waits on, reduced to what it needs to know. */
export type NoBoardQueryStatus = 'pending' | 'error' | 'ready';

export type NoBoardStateInput = {
  /** The stored session has been read; `isAuthenticated` is not a guess. */
  authSettled: boolean;
  isAuthenticated: boolean;
  isOffline: boolean;
  /** `useFeatureFlagsResolved()`: a kill switch flipped in PostHog has landed. */
  flagsResolved: boolean;
  /** `useNoBoardPreviewEnabled()`. */
  previewEnabled: boolean;
  boardsStatus: NoBoardQueryStatus;
  /** How many boards the account has. Only read when `boardsStatus` is ready. */
  ownedBoardCount: number;
  /**
   * Whether the profile read behind `account_age_hours` has finished, either
   * way. Waited on so the exposure event carries the account's age.
   */
  profileSettled: boolean;
  popularStatus: NoBoardQueryStatus;
  /** `resolvePreviewConfigs` over the popular list. */
  previewConfigs: readonly NoBoardPreviewConfig[];
};

export type NoBoardDecision =
  | { status: 'pending' }
  | { status: 'placard'; fallbackReason: NoBoardFallbackReason; ownedBoardCount: number | null }
  | { status: 'preview'; configs: readonly NoBoardPreviewConfig[]; ownedBoardCount: 0 };

/**
 * Placard or preview. The preview is only for an account with zero boards, on a
 * working connection, with a setup to show. Everything else keeps the placard.
 *
 * `pending` means "ask again": a value this depends on has not arrived. The
 * caller keeps the placard up meanwhile.
 *
 * Offline is checked ahead of the flags and the board list, because none of
 * those reads can finish without a connection.
 */
export function decideNoBoardState(input: NoBoardStateInput): NoBoardDecision {
  const knownBoardCount = input.boardsStatus === 'ready' ? input.ownedBoardCount : null;
  if (!input.authSettled) return { status: 'pending' };
  if (!input.isAuthenticated) {
    return { status: 'placard', fallbackReason: 'signed_out', ownedBoardCount: null };
  }
  if (input.isOffline) {
    return { status: 'placard', fallbackReason: 'offline', ownedBoardCount: knownBoardCount };
  }
  if (!input.flagsResolved || input.boardsStatus === 'pending' || !input.profileSettled) {
    return { status: 'pending' };
  }
  if (!input.previewEnabled) {
    return { status: 'placard', fallbackReason: 'kill_switch', ownedBoardCount: knownBoardCount };
  }
  if (input.boardsStatus === 'error') {
    return { status: 'placard', fallbackReason: 'boards_unknown', ownedBoardCount: null };
  }
  if (input.ownedBoardCount > 0) {
    return { status: 'placard', fallbackReason: 'has_boards', ownedBoardCount: input.ownedBoardCount };
  }
  if (input.popularStatus === 'pending') return { status: 'pending' };
  if (input.popularStatus === 'error' || input.previewConfigs.length === 0) {
    return { status: 'placard', fallbackReason: 'no_config', ownedBoardCount: 0 };
  }
  return { status: 'preview', configs: input.previewConfigs, ownedBoardCount: 0 };
}

export type SettledNoBoardDecision = Exclude<NoBoardDecision, { status: 'pending' }>;

/**
 * Whether a settled answer is kept for as long as the no-board state is
 * mounted. Climbs stays mounted for the whole app session, so only an answer
 * that later reads cannot make wrong is kept:
 *
 * - a preview, so a refetch never pulls the list out from under its reader;
 * - `has_boards` and `kill_switch`, which are facts about the account and the
 *   build's flags, not about this moment.
 *
 * `offline`, `boards_unknown`, `no_config` and `signed_out` describe a moment.
 * A climber who opened the app in a signal gap must get the preview once the
 * connection is back, not after a relaunch, so those are decided again.
 */
export function holdsNoBoardDecision(decision: SettledNoBoardDecision): boolean {
  if (decision.status === 'preview') return true;
  return decision.fallbackReason === 'has_boards' || decision.fallbackReason === 'kill_switch';
}

/**
 * Whether the profile read behind `account_age_hours` has an answer. A sign-in
 * invalidates a profile query that cached `null` for the signed-out tree, so
 * that query is not pending while the real profile is still on its way: a
 * refetch over nothing counts as not settled.
 */
export function isProfileSettled(profileQuery: {
  hasProfile: boolean;
  isPending: boolean;
  isFetching: boolean;
}): boolean {
  if (profileQuery.isPending) return false;
  return profileQuery.hasProfile || !profileQuery.isFetching;
}
