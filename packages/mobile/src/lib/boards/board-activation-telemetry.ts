import type { UserBoard } from '@boardsesh/shared-schema';
import { track } from '../analytics';
import type { BoardReturnTo } from './board-return-to';

export const BOARD_ACTIVATION_PHASE_EVENT = 'Mobile Board Activation Phase';

const BOARD_ACTIVATION_READY_TIMEOUT_MS = 6000;

type BoardActivationPhase =
  | 'tap'
  | 'persisted'
  | 'dismiss_requested'
  | 'active_board_published'
  | 'climbs_screen_ready'
  | 'timeout';

type BoardActivationSource = 'onboarding' | 'board_picker';

type PendingBoardActivation = {
  id: string;
  boardUuid: string;
  startedAt: number;
  returnTo: BoardReturnTo;
  timeout: ReturnType<typeof setTimeout> | null;
};

let pendingBoardActivation: PendingBoardActivation | null = null;

function buildBoardProps(board: UserBoard) {
  return {
    boardUuid: board.uuid,
    boardType: board.boardType,
    layoutId: board.layoutId,
    sizeId: board.sizeId,
    setIds: board.setIds,
    angle: board.angle,
  };
}

function trackPhase(phase: BoardActivationPhase, board: UserBoard, pending: PendingBoardActivation) {
  track(BOARD_ACTIVATION_PHASE_EVENT, {
    phase,
    activationId: pending.id,
    durationMs: Date.now() - pending.startedAt,
    returnTo: pending.returnTo,
    ...buildBoardProps(board),
  });
}

function clearPendingActivation(pending: PendingBoardActivation) {
  if (pending.timeout) clearTimeout(pending.timeout);
  if (pendingBoardActivation?.id === pending.id) {
    pendingBoardActivation = null;
  }
}

export function beginBoardActivationTelemetry(
  board: UserBoard,
  opts: { source: BoardActivationSource; returnTo: BoardReturnTo },
): string {
  if (pendingBoardActivation) clearPendingActivation(pendingBoardActivation);

  const startedAt = Date.now();
  const pending: PendingBoardActivation = {
    id: `${board.uuid}:${startedAt}`,
    boardUuid: board.uuid,
    startedAt,
    returnTo: opts.returnTo,
    timeout: null,
  };

  pendingBoardActivation = pending;
  track(BOARD_ACTIVATION_PHASE_EVENT, {
    phase: 'tap',
    activationId: pending.id,
    durationMs: 0,
    source: opts.source,
    returnTo: opts.returnTo,
    ...buildBoardProps(board),
  });

  if (opts.returnTo === '/(tabs)/climbs') {
    pending.timeout = setTimeout(() => {
      if (pendingBoardActivation?.id !== pending.id) return;
      trackPhase('timeout', board, pending);
      clearPendingActivation(pending);
    }, BOARD_ACTIVATION_READY_TIMEOUT_MS);
  }

  return pending.id;
}

export function markBoardActivationPhase(phase: Exclude<BoardActivationPhase, 'tap' | 'timeout'>, board: UserBoard) {
  const pending = pendingBoardActivation;
  if (!pending || pending.boardUuid !== board.uuid) return;

  trackPhase(phase, board, pending);

  if (
    phase === 'climbs_screen_ready' ||
    (phase === 'active_board_published' && pending.returnTo !== '/(tabs)/climbs')
  ) {
    clearPendingActivation(pending);
  }
}
