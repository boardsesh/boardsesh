import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { UserBoard } from '@boardsesh/shared-schema';
import type { BoardReturnTo } from '../board-return-to';

const analytics = vi.hoisted(() => ({
  track: vi.fn(),
}));

vi.mock('../../analytics', () => ({
  track: analytics.track,
}));

import {
  beginBoardActivationTelemetry,
  BOARD_ACTIVATION_PHASE_EVENT,
  markBoardActivationPhase,
  resetBoardActivationTelemetryForTests,
} from '../board-activation-telemetry';

function makeBoard(uuid: string): UserBoard {
  return {
    uuid,
    boardType: 'kilter',
    layoutId: 1,
    sizeId: 10,
    setIds: '1,2',
    angle: 40,
  } as unknown as UserBoard;
}

function trackedPhases(): Array<string | undefined> {
  return analytics.track.mock.calls.map((call) => {
    const props = call[1] as { phase?: string };
    return props.phase;
  });
}

function begin(board: UserBoard, returnTo: BoardReturnTo = '/(tabs)/climbs') {
  beginBoardActivationTelemetry(board, { source: 'board_picker', returnTo });
}

describe('board activation telemetry', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    analytics.track.mockClear();
    resetBoardActivationTelemetryForTests();
  });

  afterEach(() => {
    resetBoardActivationTelemetryForTests();
    vi.useRealTimers();
  });

  it('tracks timeout and clears the pending activation when Climbs never becomes ready', () => {
    const board = makeBoard('board-1');

    begin(board);
    vi.advanceTimersByTime(6000);
    markBoardActivationPhase('persisted', board);

    expect(trackedPhases()).toEqual(['tap', 'timeout']);
    expect(analytics.track).toHaveBeenLastCalledWith(
      BOARD_ACTIVATION_PHASE_EVENT,
      expect.objectContaining({ phase: 'timeout', boardUuid: board.uuid }),
    );
  });

  it('ignores phase marks for a stale board uuid', () => {
    const board = makeBoard('board-1');
    const staleBoard = makeBoard('board-2');

    begin(board);
    markBoardActivationPhase('persisted', staleBoard);

    expect(trackedPhases()).toEqual(['tap']);
  });

  it('clears the pending activation after Climbs reports ready', () => {
    const board = makeBoard('board-1');

    begin(board);
    markBoardActivationPhase('persisted', board);
    markBoardActivationPhase('climbs_screen_ready', board);
    markBoardActivationPhase('active_board_published', board);
    vi.advanceTimersByTime(6000);

    expect(trackedPhases()).toEqual(['tap', 'persisted', 'climbs_screen_ready']);
  });

  it('clears non-Climbs activations after active-board publish', () => {
    const board = makeBoard('board-1');

    begin(board, '/(tabs)/discover');
    markBoardActivationPhase('active_board_published', board);
    markBoardActivationPhase('dismiss_requested', board);

    expect(trackedPhases()).toEqual(['tap', 'active_board_published']);
  });
});
