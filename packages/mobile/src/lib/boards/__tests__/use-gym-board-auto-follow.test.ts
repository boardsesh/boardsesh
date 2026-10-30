// @vitest-environment jsdom
// Following a solo climber who drives a wall onto a climb from another board at
// their gym (#7076): only on a change of current climb, only when it can't
// surprise anyone, one move at a time, and quietly.
import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { UserBoard } from '@boardsesh/shared-schema';

const trackBoardConnectTapped = vi.hoisted(() => vi.fn());
vi.mock('../../analytics-board-connect', () => ({ trackBoardConnectTapped }));

import {
  resolveGymBoardAutoFollow,
  useGymBoardAutoFollow,
  type GymBoardAutoFollowInput,
  type UseGymBoardAutoFollowOptions,
} from '../use-gym-board-auto-follow';
import type { ClimbBoardMove } from '../climb-board-connect-context';
import type { ClimbBoardModel } from '../gym-board-for-climb';

function makeBoard(overrides: Partial<UserBoard>): UserBoard {
  return {
    uuid: 'board',
    slug: 'board',
    ownerId: 'owner-1',
    boardType: 'kilter',
    layoutId: 1,
    sizeId: 10,
    setIds: '1,20',
    name: 'Board',
    isPublic: true,
    isUnlisted: false,
    hideLocation: false,
    isOwned: false,
    angle: 40,
    isAngleAdjustable: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    totalAscents: 0,
    uniqueClimbers: 0,
    followerCount: 0,
    commentCount: 0,
    isFollowedByMe: false,
    canEdit: false,
    ...overrides,
  };
}

// A gym with a Kilter and a MoonBoard side by side.
const KILTER = makeBoard({ uuid: 'gym-kilter', boardType: 'kilter', layoutId: 1, name: 'Gym Kilter' });
const MOONBOARD = makeBoard({ uuid: 'gym-moon', boardType: 'moonboard', layoutId: 2, sizeId: 1, name: 'Gym Moon' });
const GYM = [KILTER, MOONBOARD];

const CLIMBS: Record<string, ClimbBoardModel> = {
  'moon-1': { boardType: 'moonboard', layoutId: 2 },
  'moon-2': { boardType: 'moonboard', layoutId: 2 },
  'kilter-1': { boardType: 'kilter', layoutId: 1 },
  'kilter-2': { boardType: 'kilter', layoutId: 1 },
};

describe('resolveGymBoardAutoFollow', () => {
  const FOLLOW: GymBoardAutoFollowInput = {
    climb: CLIMBS['kilter-1'],
    activeBoard: MOONBOARD,
    gymBoards: GYM,
    connected: true,
    sharedSession: false,
    hasRememberedDeviceForBoard: () => true,
  };

  it('follows a connected solo climber to a remembered board that draws the climb', () => {
    expect(resolveGymBoardAutoFollow(FOLLOW)).toBe(KILTER);
  });

  it.each([
    ['not connected', { connected: false }],
    ['in a shared session', { sharedSession: true }],
    ['the board is not remembered', { hasRememberedDeviceForBoard: () => false }],
    ['the active board draws the climb', { climb: CLIMBS['moon-1'] }],
    ['the target board has no lights', { gymBoards: [{ ...KILTER, hasLeds: false }, MOONBOARD] }],
    ['no gym roster', { gymBoards: null }],
  ] as const)('stays put when %s', (_case, override) => {
    expect(resolveGymBoardAutoFollow({ ...FOLLOW, ...override })).toBeNull();
  });
});

type Deferred = { promise: Promise<ClimbBoardMove>; resolve: (move: ClimbBoardMove) => void };

function deferredMove(): Deferred {
  let resolve!: (move: ClimbBoardMove) => void;
  const promise = new Promise<ClimbBoardMove>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

type HookProps = Pick<UseGymBoardAutoFollowOptions, 'currentClimbUuid' | 'activeBoard' | 'connected' | 'sharedSession'>;

function setup(initial: Partial<HookProps> = {}, remembered: (board: UserBoard) => boolean = () => true) {
  const moveToClimbBoard = vi.fn<(climb: ClimbBoardModel | null) => Promise<ClimbBoardMove>>(async () => ({
    kind: 'switched',
    board: KILTER,
  }));
  const connectAfterBoardSwitch = vi.fn<(board: UserBoard, options: { quiet: true }) => Promise<boolean>>(
    async () => true,
  );
  const hasRememberedDeviceForBoard = vi.fn(remembered);
  const state = { currentClimbUuid: 'moon-1' as string | null };
  const getCurrentClimb = () => (state.currentClimbUuid ? (CLIMBS[state.currentClimbUuid] ?? null) : null);
  const initialProps: HookProps = {
    currentClimbUuid: 'moon-1',
    activeBoard: MOONBOARD,
    connected: true,
    sharedSession: false,
    ...initial,
  };
  state.currentClimbUuid = initialProps.currentClimbUuid;
  const hook = renderHook(
    (props: HookProps) => {
      state.currentClimbUuid = props.currentClimbUuid;
      useGymBoardAutoFollow({
        ...props,
        gymBoards: GYM,
        getCurrentClimb,
        hasRememberedDeviceForBoard,
        moveToClimbBoard,
        connectAfterBoardSwitch,
      });
    },
    { initialProps },
  );
  let props = initialProps;
  const rerender = async (next: Partial<HookProps>) => {
    props = { ...props, ...next };
    await act(async () => {
      hook.rerender(props);
    });
  };
  return { rerender, moveToClimbBoard, connectAfterBoardSwitch, hasRememberedDeviceForBoard };
}

describe('useGymBoardAutoFollow', () => {
  beforeEach(() => {
    trackBoardConnectTapped.mockClear();
  });

  it('follows a connected solo climber to the Kilter on Next, quietly', async () => {
    const { rerender, moveToClimbBoard, connectAfterBoardSwitch } = setup();

    await rerender({ currentClimbUuid: 'kilter-1' });

    expect(moveToClimbBoard).toHaveBeenCalledOnce();
    expect(moveToClimbBoard).toHaveBeenCalledWith(CLIMBS['kilter-1']);
    expect(connectAfterBoardSwitch).toHaveBeenCalledOnce();
    expect(connectAfterBoardSwitch).toHaveBeenCalledWith(KILTER, { quiet: true });
    expect(trackBoardConnectTapped).toHaveBeenCalledWith({
      surface: 'auto_follow',
      boardName: 'kilter',
      reconnect: true,
    });
  });

  it('leaves a launch onto another board’s climb to the climber', async () => {
    const { rerender, moveToClimbBoard } = setup({ currentClimbUuid: 'kilter-1' });
    // A re-render with nothing changed is not a climb change either.
    await rerender({});
    expect(moveToClimbBoard).not.toHaveBeenCalled();
  });

  it('never follows a change of board alone', async () => {
    // On a Kilter climb while the MoonBoard is active (the climber picked it by
    // hand); the Kilter's link may still be coming down.
    const { rerender, moveToClimbBoard } = setup({ currentClimbUuid: 'kilter-1', activeBoard: KILTER });
    await rerender({ activeBoard: MOONBOARD });
    await rerender({ connected: false });
    await rerender({ connected: true });
    expect(moveToClimbBoard).not.toHaveBeenCalled();
  });

  it('never moves a shared session', async () => {
    const { rerender, moveToClimbBoard } = setup({ sharedSession: true });
    await rerender({ currentClimbUuid: 'kilter-1' });
    expect(moveToClimbBoard).not.toHaveBeenCalled();
  });

  it('never follows without a live link', async () => {
    const { rerender, moveToClimbBoard } = setup({ connected: false });
    await rerender({ currentClimbUuid: 'kilter-1' });
    expect(moveToClimbBoard).not.toHaveBeenCalled();
  });

  it('never follows to a board this phone has not connected to', async () => {
    const { rerender, moveToClimbBoard, hasRememberedDeviceForBoard } = setup({}, () => false);
    await rerender({ currentClimbUuid: 'kilter-1' });
    expect(hasRememberedDeviceForBoard).toHaveBeenCalledWith(KILTER);
    expect(moveToClimbBoard).not.toHaveBeenCalled();
  });

  it('does not connect when the move did not happen', async () => {
    const { rerender, moveToClimbBoard, connectAfterBoardSwitch } = setup();
    moveToClimbBoard.mockResolvedValueOnce({ kind: 'failed' });
    await rerender({ currentClimbUuid: 'kilter-1' });
    expect(moveToClimbBoard).toHaveBeenCalledOnce();
    expect(connectAfterBoardSwitch).not.toHaveBeenCalled();
    expect(trackBoardConnectTapped).not.toHaveBeenCalled();
  });

  it('runs one move at a time, and looks at a climb that changed meanwhile once it settles', async () => {
    const { rerender, moveToClimbBoard, connectAfterBoardSwitch } = setup();
    const toKilter = deferredMove();
    moveToClimbBoard.mockReturnValueOnce(toKilter.promise);

    await rerender({ currentClimbUuid: 'kilter-1' });
    expect(moveToClimbBoard).toHaveBeenCalledOnce();

    // The climber bounces back to a MoonBoard climb while the move runs.
    await rerender({ currentClimbUuid: 'moon-2' });
    expect(moveToClimbBoard).toHaveBeenCalledOnce();

    // The move lands on the Kilter; the app follows the climber back.
    moveToClimbBoard.mockResolvedValueOnce({ kind: 'switched', board: MOONBOARD });
    await rerender({ activeBoard: KILTER });
    await act(async () => {
      toKilter.resolve({ kind: 'switched', board: KILTER });
    });

    expect(moveToClimbBoard).toHaveBeenCalledTimes(2);
    expect(moveToClimbBoard).toHaveBeenLastCalledWith(CLIMBS['moon-2']);
    expect(connectAfterBoardSwitch).toHaveBeenNthCalledWith(1, KILTER, { quiet: true });
    expect(connectAfterBoardSwitch).toHaveBeenNthCalledWith(2, MOONBOARD, { quiet: true });
  });

  it('does not move again once a move settles on the same climb', async () => {
    const { rerender, moveToClimbBoard } = setup();
    await rerender({ currentClimbUuid: 'kilter-1' });
    await rerender({ activeBoard: KILTER });
    expect(moveToClimbBoard).toHaveBeenCalledOnce();
  });
});
