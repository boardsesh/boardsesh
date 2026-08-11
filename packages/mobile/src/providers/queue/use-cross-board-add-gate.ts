import { useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { useQueryClient } from '@tanstack/react-query';
import { router } from 'expo-router';
import { formatBoardDisplayName } from '@boardsesh/board-config';
import { SHARED_EVENTS } from '@boardsesh/analytics';
import type { UserBoard } from '@boardsesh/shared-schema';
import { boardLooselyMatches } from '../../lib/boards/board-matches';
import { useSetActiveBoard } from '../../lib/graphql/use-active-board';
import { myBoardsQueryKey } from '../../lib/graphql/query-keys';
import type { GetMyBoardsQueryResponse } from '../../lib/graphql/operations';
import { track } from '../../lib/analytics';
import { reportHandledError } from '../../lib/error-reporting';
import { useToast } from '../toast-provider';
import { useChoose } from '../dialog-provider';

/** What the climber picked, plus what the app has to do about it. */
export type CrossBoardAddResult =
  /** Queue it on the board they're already on — the queue goes mixed. */
  | { outcome: 'add' }
  /** The active board is now `board`; queue the climb on it. */
  | { outcome: 'switch'; board: UserBoard }
  /** Don't queue anything (also covers "they were sent to the board picker"). */
  | { outcome: 'cancel' };

export type CrossBoardAddRequest = {
  /** From `decideAdd` — the in-flight key, so one prompt covers a bulk add. */
  climbConfigKey: string;
  climbBoardName: string;
  climbLayoutId: number;
  /** For analytics only: the board the queue is currently on. */
  activeBoardName?: string;
};

type ChoiceValue = 'add' | 'switch' | 'cancel';

// The roster drawer-host-provider keeps warm is `useMyBoards()` — no input. Key
// it through the same helper that hook keys its query with, so the two can't
// drift. Read at tap time rather than subscribed, so QueueProvider doesn't
// re-render on roster churn.
const MY_BOARDS_QUERY_KEY = myBoardsQueryKey();

/**
 * The prompt behind a cross-board queue add: "this climb is on another board —
 * add it anyway, switch to that board, or cancel?"
 *
 * Three things live here rather than in QueueProvider:
 *
 * - **One prompt per board, not per climb.** Adds are keyed by
 *   `climbConfigKey` while a prompt is open, so queueing eight climbs from the
 *   same foreign board raises one dialog and all eight awaiters settle on its
 *   answer.
 * - **Board names are trademark-correct.** `formatBoardDisplayName` renders
 *   "MoonBoard", never the `charAt(0).toUpperCase()` "Moonboard".
 * - **Switching keeps the board's own angle.** It mirrors
 *   `handleSwitchBoardFromDrawer`: activate the owned board as stored (never a
 *   synthesised angle 0), or route to the board picker when the climber doesn't
 *   own that board yet — which resolves `cancel`, since nothing can be queued
 *   against a board they haven't set up.
 */
export function useCrossBoardAddGate(): (request: CrossBoardAddRequest) => Promise<CrossBoardAddResult> {
  const { t } = useTranslation('climbs');
  const choose = useChoose();
  const { showToast } = useToast();
  const setActiveBoard = useSetActiveBoard();
  const queryClient = useQueryClient();
  const inFlightRef = useRef<Map<string, Promise<CrossBoardAddResult>>>(new Map());

  const runPrompt = useCallback(
    async (request: CrossBoardAddRequest): Promise<CrossBoardAddResult> => {
      const boardLabel = formatBoardDisplayName(request.climbBoardName);
      const picked = await choose<ChoiceValue>({
        title: t('mobile.crossBoardAdd.title', { board: boardLabel }),
        message: t('mobile.crossBoardAdd.message', { board: boardLabel }),
        options: [
          { value: 'add', label: t('mobile.crossBoardAdd.addAnyway') },
          { value: 'switch', label: t('mobile.crossBoardAdd.switchBoard', { board: boardLabel }) },
          { value: 'cancel', label: t('mobile.crossBoardAdd.cancel'), cancel: true },
        ],
        cancelValue: 'cancel',
      });

      const trackOutcome = (outcome: ChoiceValue) => {
        track(SHARED_EVENTS.CrossBoardQueueAddPrompted, {
          outcome,
          activeBoardName: request.activeBoardName,
          climbBoardName: request.climbBoardName,
          climbLayoutId: request.climbLayoutId,
        });
      };

      if (picked !== 'switch') {
        trackOutcome(picked);
        return picked === 'add' ? { outcome: 'add' } : { outcome: 'cancel' };
      }

      const owned = queryClient
        .getQueryData<GetMyBoardsQueryResponse>(MY_BOARDS_QUERY_KEY)
        ?.myBoards.boards.find((board) =>
          boardLooselyMatches(
            { boardName: board.boardType, layoutId: board.layoutId },
            { boardName: request.climbBoardName, layoutId: request.climbLayoutId },
          ),
        );

      if (!owned) {
        // They don't have that board set up (or the roster hasn't loaded).
        // Send them to the picker; there's nothing to queue against yet.
        trackOutcome('cancel');
        router.push('/boards');
        return { outcome: 'cancel' };
      }

      try {
        await setActiveBoard(owned);
      } catch (error) {
        // The activation mutation failed, so the queue is still on the old
        // board. Queueing the climb now would drop a foreign climb onto it —
        // exactly what the prompt exists to prevent — and letting the rejection
        // through would surface as an unhandled rejection, because every add
        // path fires this as `void addToQueue(...)`. Back out and say so; the
        // switch is theirs to retry.
        reportHandledError(error, { tags: { source: 'queue-sync', op: 'cross-board-switch' } });
        showToast(t('mobile.crossBoardAdd.switchFailed', { board: boardLabel }), 'error');
        trackOutcome('cancel');
        return { outcome: 'cancel' };
      }

      trackOutcome('switch');
      return { outcome: 'switch', board: owned };
    },
    [choose, queryClient, setActiveBoard, showToast, t],
  );

  return useCallback(
    (request: CrossBoardAddRequest) => {
      const existing = inFlightRef.current.get(request.climbConfigKey);
      if (existing) return existing;
      const pending = runPrompt(request).finally(() => {
        inFlightRef.current.delete(request.climbConfigKey);
      });
      inFlightRef.current.set(request.climbConfigKey, pending);
      return pending;
    },
    [runPrompt],
  );
}
