// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import type { Climb, ClimbQueueItem } from '@boardsesh/queue';
import type { WorkoutRun } from '@boardsesh/playlist-generator';
import type { BoardConfig } from '../../../providers/drawer-host-provider';
import type { ClimbRenderBoardResult } from '../../../lib/boards/climb-render-board';
import { WALL_MOVED_GRACE_MS } from '../../play-drawer/workout-outcome';

// The MiniPlayer's gate for one-tap Fell / Sent (#6940): the player's own rule
// (`shouldShowWorkoutOutcome`) for the climb on the wall, and its 2 s hold after
// the wall leaves the block.

const state = vi.hoisted(() => ({
  sessionId: 'session-1' as string | null,
  head: null as ClimbQueueItem | null,
  signedIn: true,
  run: null as WorkoutRun | null,
}));

vi.mock('../../../providers/queue-provider', () => ({
  useQueueSessionId: () => ({ sessionId: state.sessionId }),
  useQueueData: () => ({ currentClimbQueueItem: state.head }),
}));
vi.mock('../../../providers/auth-provider', () => ({ useAuth: () => ({ isAuthenticated: state.signedIn }) }));
vi.mock('../../../lib/workout-run-store', () => ({ useWorkoutRun: () => state.run }));

const { useMiniPlayerWorkoutOutcome } = await import('../use-mini-player-workout-outcome');

const START_MS = 1_760_000_000_000;
const LIMIT_ITEM = 'item-1';
const COOL_DOWN_ITEM = 'item-3';

const RUN: WorkoutRun = {
  stages: [
    {
      id: 'limit',
      kind: 'limitBouldering',
      itemUuids: [LIMIT_ITEM, 'item-2'],
      pacing: { mode: 'onTheMinute', restSeconds: 60 },
    },
    { id: 'volume', kind: 'volume', itemUuids: [COOL_DOWN_ITEM] },
  ],
};

const BOARD: BoardConfig = {
  boardName: 'kilter',
  layoutId: 1,
  sizeId: 10,
  setIds: '1,20',
  angle: 40,
} as BoardConfig;

function climb(uuid: string, overrides: Partial<Climb> = {}): Climb {
  return { uuid, name: `Climb ${uuid}`, ...overrides } as unknown as Climb;
}

function item(uuid: string, climbOverrides: Partial<Climb> = {}): ClimbQueueItem {
  return { uuid, climb: climb(`climb-${uuid}`, climbOverrides) } as unknown as ClimbQueueItem;
}

const exact: ClimbRenderBoardResult = { boardConfig: BOARD, fit: 'exact', incompatible: false };

type HookInput = {
  barClimb: Climb;
  climbBoard?: ClimbRenderBoardResult | null;
  reachable?: ReadonlySet<string>;
  playerRouteUp?: boolean;
};

function renderOutcome(initial: HookInput) {
  return renderHook(
    ({ barClimb, climbBoard = exact, reachable, playerRouteUp = false }: HookInput) =>
      useMiniPlayerWorkoutOutcome({ climb: barClimb, climbBoard, reachableBoardKeys: reachable, playerRouteUp }),
    { initialProps: initial },
  );
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(START_MS);
  state.sessionId = 'session-1';
  state.head = item(LIMIT_ITEM);
  state.signedIn = true;
  state.run = RUN;
});

afterEach(() => {
  vi.useRealTimers();
});

describe('useMiniPlayerWorkoutOutcome', () => {
  it('offers Fell / Sent for the climb on the wall, on the board the bar draws it on', () => {
    const { result } = renderOutcome({ barClimb: state.head!.climb });
    expect(result.current.inTimedBlock).toBe(true);
    expect(result.current.shown?.wallLeftAtMs).toBeNull();
    expect(result.current.shown?.target).toMatchObject({
      queueItemUuid: LIMIT_ITEM,
      sessionId: 'session-1',
      boardName: 'kilter',
      layoutId: 1,
      sizeId: 10,
      setIds: '1,20',
      angle: 40,
      isMirror: false,
    });
  });

  it('needs a session, and logs the orientation the session shows', () => {
    state.sessionId = null;
    const { result, rerender } = renderOutcome({ barClimb: state.head!.climb });
    // No session, no run to log to, as in the player.
    expect(result.current.shown).toBeNull();
    state.sessionId = 'session-1';
    state.head = item(LIMIT_ITEM, { mirrored: true });
    rerender({ barClimb: state.head.climb });
    expect(result.current.shown?.target.isMirror).toBe(true);
  });

  it('offers none while the player route is up, which has its own Fell / Sent', () => {
    const { result } = renderOutcome({ barClimb: state.head!.climb, playerRouteUp: true });
    expect(result.current).toEqual({ inTimedBlock: true, shown: null });
  });

  it('is off outside a timed block, and ⏮ ⏭ come back', () => {
    state.head = item(COOL_DOWN_ITEM);
    const { result } = renderOutcome({ barClimb: state.head.climb });
    expect(result.current).toEqual({ inTimedBlock: false, shown: null });
  });

  it("keeps ⏮ ⏭ off but offers no Fell / Sent where the climber can't log: signed out, a draft", () => {
    state.signedIn = false;
    const signedOut = renderOutcome({ barClimb: state.head!.climb });
    expect(signedOut.result.current).toEqual({ inTimedBlock: true, shown: null });
    state.signedIn = true;
    state.head = item(LIMIT_ITEM, { is_draft: true });
    const draft = renderOutcome({ barClimb: state.head.climb });
    expect(draft.result.current).toEqual({ inTimedBlock: true, shown: null });
  });

  it("offers none on another board's climb, unless that board stands at this gym", () => {
    const elsewhere: ClimbRenderBoardResult = {
      boardConfig: { ...BOARD, boardName: 'tension', layoutId: 9 },
      fit: 'incompatible',
      incompatible: true,
    };
    const away = renderOutcome({ barClimb: state.head!.climb, climbBoard: elsewhere });
    expect(away.result.current.shown).toBeNull();
    const nearby = renderOutcome({
      barClimb: state.head!.climb,
      climbBoard: elsewhere,
      reachable: new Set(['tension:9']),
    });
    expect(nearby.result.current.shown?.target.boardName).toBe('tension');
  });

  it('offers none while the bar still names a climb the wall has left (a retained climb)', () => {
    const { result } = renderOutcome({ barClimb: climb('climb-somewhere-else') });
    expect(result.current.shown).toBeNull();
  });

  it('holds the pair for the climb the wall left for 2 s, then lets it go', () => {
    const { result, rerender } = renderOutcome({ barClimb: state.head!.climb });
    const limitTarget = result.current.shown?.target;
    state.head = item(COOL_DOWN_ITEM);
    rerender({ barClimb: state.head.climb });
    expect(result.current.inTimedBlock).toBe(false);
    expect(result.current.shown?.target).toBe(limitTarget);
    expect(result.current.shown?.wallLeftAtMs).toBe(START_MS);
    act(() => {
      vi.advanceTimersByTime(WALL_MOVED_GRACE_MS);
    });
    expect(result.current.shown).toBeNull();
  });

  it('drops the hold at once on a sign-out', () => {
    const { result, rerender } = renderOutcome({ barClimb: state.head!.climb });
    state.head = item(COOL_DOWN_ITEM);
    rerender({ barClimb: state.head.climb });
    expect(result.current.shown).not.toBeNull();
    state.signedIn = false;
    rerender({ barClimb: state.head.climb });
    expect(result.current.shown).toBeNull();
  });
});
