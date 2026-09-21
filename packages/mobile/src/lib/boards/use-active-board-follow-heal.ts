// One-time follow for the board a climber is already on.
//
// Until #5654, picking a board someone else built never followed it: adoption
// read `UserBoard.isOwned` (the creator's "a real wall" flag, true for every
// board built in the app) as "yours". Those climbers are still bound to the
// board on this phone, but it is missing from Your boards, so the picker says
// "No boards yet" and the obvious next tap builds a duplicate (#5272).
//
// Fixing adoption only helps the next pick. This follows the board the app
// launched on, once, when the server says it is neither the climber's own nor
// followed. It is deliberately narrow:
//
// - Only the board this process launched on. A board picked during the session
//   already went through adoption, and healing it too would race that follow.
// - Signed in only, and never across an account boundary: the sign-out reset of
//   the self-heal validation epoch cancels a heal that is still in flight.
// - Once per user and board, remembered on the device. A climber who unfollows
//   the board later is not followed back on the next launch.
// - Silent. No toast: nothing on screen changed, the board just shows up in
//   Your boards the next time they look.

import { useEffect } from 'react';
import { SHARED_EVENTS } from '@boardsesh/analytics';
import { fetchBoardByUuid, useFollowBoard } from '../graphql/hooks';
import { useActiveBoard } from '../graphql/use-active-board';
import { useAuth } from '../../providers/auth-provider';
import { useStoredUserId } from '../../hooks/use-current-user-id';
import { getPreference, setPreference } from '../preference-store';
import { track } from '../analytics';
import { boardOwnershipForViewer, shouldFollowBoard } from '../board-discovery/adopt-found-board-decision';
import {
  captureActiveBoardSelfHealValidationEpoch,
  isActiveBoardSelfHealValidationEpochCurrent,
} from './active-board-self-heal-validation-cache';

/** `${userId}:${boardUuid}` for every heal that reached a definitive answer. */
export const ACTIVE_BOARD_FOLLOW_HEAL_STORAGE_KEY = 'activeBoardFollowHealed';

// A climber is bound to one board at a time, so this only grows by one per board
// they launch the app on. The cap keeps a shared device from accumulating keys.
const MAX_REMEMBERED_HEALS = 20;

// `undefined` until the first settled active-board read of this process: the
// board the app launched on. Module-level because the root hook can remount
// during provider churn, and a remount must not promote an in-session pick.
let launchBoardUuid: string | null | undefined;
// Heals started in this process, so a re-render or remount never sends a second
// request while the first is still settling.
const startedHealKeys = new Set<string>();

/** Test-only reset for the per-process state. */
export function resetActiveBoardFollowHealForTests(): void {
  launchBoardUuid = undefined;
  startedHealKeys.clear();
}

/**
 * A read error answers "already healed": the follow is a nicety, and a flaky
 * store must never turn a one-time repair into one that runs on every launch.
 */
async function hasHealed(healKey: string): Promise<boolean> {
  try {
    const healedKeys = await getPreference<string[]>(ACTIVE_BOARD_FOLLOW_HEAL_STORAGE_KEY);
    return Array.isArray(healedKeys) && healedKeys.includes(healKey);
  } catch {
    return true;
  }
}

async function markHealed(healKey: string): Promise<void> {
  try {
    const healedKeys = (await getPreference<string[]>(ACTIVE_BOARD_FOLLOW_HEAL_STORAGE_KEY)) ?? [];
    const remembered = [...(Array.isArray(healedKeys) ? healedKeys : []).filter((key) => key !== healKey), healKey];
    await setPreference(ACTIVE_BOARD_FOLLOW_HEAL_STORAGE_KEY, remembered.slice(-MAX_REMEMBERED_HEALS));
  } catch {
    // Unremembered means the next launch asks the server again, which answers
    // "followed" by then. Nothing to surface.
  }
}

export function useActiveBoardFollowHeal(): void {
  const { isAuthenticated } = useAuth();
  const { data: activeBoard, isPending } = useActiveBoard();
  const { userId: viewerId } = useStoredUserId(isAuthenticated);
  // No callbacks: a silent follow. It still invalidates `myBoards` on success.
  const followBoard = useFollowBoard();
  const followBoardAsync = followBoard.mutateAsync;

  const boardUuid = activeBoard?.uuid ?? null;
  // The stored snapshot answers the common case with no request: your own board,
  // or one you followed when you picked it. `ownerId` compared directly, not
  // through `boardIsOwnedBy`, whose `isOwned` fallback for a snapshot with no
  // `ownerId` is the very misreading this repairs. Such a snapshot asks the
  // server instead.
  const snapshotIsTheirs =
    activeBoard != null &&
    viewerId !== undefined &&
    (activeBoard.ownerId === viewerId || activeBoard.isFollowedByMe === true);

  useEffect(() => {
    if (isPending) return;
    if (launchBoardUuid === undefined) launchBoardUuid = boardUuid;
    if (!isAuthenticated || viewerId === undefined || boardUuid === null) return;
    if (boardUuid !== launchBoardUuid || snapshotIsTheirs) return;
    // Screenshot builds drive the active board to stage captures; following it
    // would change the store-shot account's board list between runs. Inlined so
    // it dead-strips from normal builds.
    if (process.env.EXPO_PUBLIC_SCREENSHOT_MODE === '1') return;

    const healKey = `${viewerId}:${boardUuid}`;
    if (startedHealKeys.has(healKey)) return;
    startedHealKeys.add(healKey);
    const accountEpoch = captureActiveBoardSelfHealValidationEpoch();

    void (async () => {
      try {
        if (await hasHealed(healKey)) return;
        // Fresh from the server: follow state, privacy and merges may all have
        // changed since the snapshot was stored.
        const board = await fetchBoardByUuid(boardUuid);
        if (!isActiveBoardSelfHealValidationEpochCurrent(accountEpoch)) return;
        // Deleted or merged away: the tombstone self-heal owns that board, and a
        // merge's survivor becomes the launch board on the next start.
        if (board === null || board.uuid !== boardUuid) return;

        if (shouldFollowBoard(boardOwnershipForViewer(board, viewerId))) {
          await followBoardAsync(board);
          track(SHARED_EVENTS.ActiveBoardFollowHealed, {
            boardType: board.boardType,
            hasGym: board.gymUuid != null,
          });
        }
        if (!isActiveBoardSelfHealValidationEpochCurrent(accountEpoch)) return;
        await markHealed(healKey);
      } catch {
        // Offline, or the follow was refused: leave it unremembered so the next
        // launch tries again, and let a later run in this process retry too.
        startedHealKeys.delete(healKey);
        if (__DEV__) console.warn('[ActiveBoardFollowHeal] follow heal failed; will retry next launch');
      }
    })();
  }, [isPending, isAuthenticated, viewerId, boardUuid, snapshotIsTheirs, followBoardAsync]);
}
