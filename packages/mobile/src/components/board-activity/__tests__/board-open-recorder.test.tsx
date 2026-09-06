// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import { createElement } from 'react';

const recordMock = vi.hoisted(() => vi.fn());
const state = vi.hoisted(() => ({
  activeBoard: undefined as { uuid: string; angle?: number } | undefined,
  isPending: false,
  isAuthenticated: true,
  userId: 'user-1' as string | undefined,
}));

vi.mock('../../../lib/graphql/use-active-board', () => ({
  useActiveBoard: () => ({ data: state.activeBoard, isPending: state.isPending }),
}));

vi.mock('../../../lib/graphql/hooks', () => ({
  useRecordBoardOpened: () => ({ mutate: recordMock }),
}));

vi.mock('../../../providers/auth-provider', () => ({
  useAuth: () => ({ isAuthenticated: state.isAuthenticated }),
}));

vi.mock('../../../hooks/use-current-user-id', () => ({
  useStoredUserId: () => ({ userId: state.userId }),
}));

const { BoardOpenRecorder, resetBoardOpenRecorderForTests } = await import('../BoardOpenRecorder');

beforeEach(() => {
  vi.clearAllMocks();
  resetBoardOpenRecorderForTests();
  state.activeBoard = { uuid: 'board-a' };
  state.isPending = false;
  state.isAuthenticated = true;
  state.userId = 'user-1';
});

afterEach(cleanup);

describe('BoardOpenRecorder', () => {
  it('records the board that is already active on a cold start', () => {
    render(createElement(BoardOpenRecorder));
    expect(recordMock).toHaveBeenCalledWith('board-a', expect.anything());
  });

  it('records again when the climber switches board', () => {
    const { rerender } = render(createElement(BoardOpenRecorder));
    expect(recordMock).toHaveBeenCalledTimes(1);

    state.activeBoard = { uuid: 'board-b' };
    rerender(createElement(BoardOpenRecorder));
    expect(recordMock).toHaveBeenCalledTimes(2);
    expect(recordMock).toHaveBeenLastCalledWith('board-b', expect.anything());
  });

  // The reason this watches the uuid rather than living in useSetActiveBoard:
  // the angle controls rewrite the active board for an angle change, handing
  // back a NEW object with the SAME uuid. That is not a board open.
  it('stays silent when only the angle changed', () => {
    const { rerender } = render(createElement(BoardOpenRecorder));
    expect(recordMock).toHaveBeenCalledTimes(1);

    state.activeBoard = { uuid: 'board-a', angle: 45 };
    rerender(createElement(BoardOpenRecorder));
    expect(recordMock).toHaveBeenCalledTimes(1);
  });

  it('waits for the stored board to resolve', () => {
    state.isPending = true;
    state.activeBoard = undefined;
    const { rerender } = render(createElement(BoardOpenRecorder));
    expect(recordMock).not.toHaveBeenCalled();

    state.isPending = false;
    state.activeBoard = { uuid: 'board-a' };
    rerender(createElement(BoardOpenRecorder));
    expect(recordMock).toHaveBeenCalledTimes(1);
  });

  it('records nothing when signed out', () => {
    state.isAuthenticated = false;
    render(createElement(BoardOpenRecorder));
    expect(recordMock).not.toHaveBeenCalled();
  });

  it('records nothing with no board', () => {
    state.activeBoard = undefined;
    render(createElement(BoardOpenRecorder));
    expect(recordMock).not.toHaveBeenCalled();
  });

  // Fast Refresh and an OTA reload both remount this. A useRef would forget and
  // re-record; the dedupe is at module scope precisely so it does not.
  it('does not re-record the same board across a remount', () => {
    const first = render(createElement(BoardOpenRecorder));
    expect(recordMock).toHaveBeenCalledTimes(1);
    first.unmount();

    render(createElement(BoardOpenRecorder));
    expect(recordMock).toHaveBeenCalledTimes(1);
  });

  // Two accounts on one device must not dedupe against each other.
  it('records the same board again for a different user', () => {
    const { rerender } = render(createElement(BoardOpenRecorder));
    expect(recordMock).toHaveBeenCalledTimes(1);

    state.userId = 'user-2';
    rerender(createElement(BoardOpenRecorder));
    expect(recordMock).toHaveBeenCalledTimes(2);
  });
});
