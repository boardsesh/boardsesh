import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { UserBoard } from '@boardsesh/shared-schema';
import type { BoardReturnTo } from '../board-return-to';

const analytics = vi.hoisted(() => ({
  track: vi.fn(),
}));

vi.mock('../../analytics', () => ({
  track: analytics.track,
}));

type BoardActivationTelemetryModule = typeof import('../board-activation-telemetry');

let telemetry: BoardActivationTelemetryModule;

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
  telemetry.beginBoardActivationTelemetry(board, { source: 'board_picker', returnTo });
}

describe('board activation telemetry', () => {
  beforeEach(async () => {
    vi.resetModules();
    vi.useFakeTimers();
    analytics.track.mockClear();
    telemetry = await import('../board-activation-telemetry');
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('tracks timeout and clears the pending activation when Climbs never becomes ready', () => {
    const board = makeBoard('board-1');

    begin(board);
    vi.advanceTimersByTime(6000);
    telemetry.markBoardActivationPhase('persisted', board);

    expect(trackedPhases()).toEqual(['tap', 'timeout']);
    expect(analytics.track).toHaveBeenLastCalledWith(
      telemetry.BOARD_ACTIVATION_PHASE_EVENT,
      expect.objectContaining({ phase: 'timeout', boardUuid: board.uuid }),
    );
  });

  it('ignores phase marks for a stale board uuid', () => {
    const board = makeBoard('board-1');
    const staleBoard = makeBoard('board-2');

    begin(board);
    telemetry.markBoardActivationPhase('persisted', staleBoard);

    expect(trackedPhases()).toEqual(['tap']);
  });

  it('clears the pending activation after Climbs reports ready', () => {
    const board = makeBoard('board-1');

    begin(board);
    telemetry.markBoardActivationPhase('persisted', board);
    telemetry.markBoardActivationPhase('climbs_screen_ready', board);
    telemetry.markBoardActivationPhase('active_board_published', board);
    vi.advanceTimersByTime(6000);

    expect(trackedPhases()).toEqual(['tap', 'persisted', 'climbs_screen_ready']);
  });

  it('clears non-Climbs activations after active-board publish', () => {
    const board = makeBoard('board-1');

    begin(board, '/(tabs)/discover');
    telemetry.markBoardActivationPhase('active_board_published', board);
    telemetry.markBoardActivationPhase('dismiss_requested', board);

    expect(trackedPhases()).toEqual(['tap', 'active_board_published']);
  });

  it('clears the previous timeout when a second activation starts', () => {
    const firstBoard = makeBoard('board-1');
    const secondBoard = makeBoard('board-2');

    begin(firstBoard);
    begin(secondBoard);
    vi.advanceTimersByTime(6000);

    expect(trackedPhases()).toEqual(['tap', 'tap', 'timeout']);
    expect(analytics.track).toHaveBeenLastCalledWith(
      telemetry.BOARD_ACTIVATION_PHASE_EVENT,
      expect.objectContaining({ phase: 'timeout', boardUuid: secondBoard.uuid }),
    );
  });
});
