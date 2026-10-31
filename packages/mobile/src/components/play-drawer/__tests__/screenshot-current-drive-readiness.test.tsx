// @vitest-environment jsdom
import { createElement, type ReactNode } from 'react';
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ScreenshotCurrentDriveReadiness } from '../ScreenshotCurrentDriveReadiness';
import { clearScreenshotDriveRequest, requestScreenshotDrive } from '../../../lib/screenshot-driving';

const state = vi.hoisted(() => ({
  board: { uuid: 'board-a', boardType: 'kilter', hasLeds: true },
  boardPending: false,
  boardAvailable: true,
  headAvailable: true,
  driveAvailable: true,
  head: { uuid: 'item-a', climb: { uuid: 'climb-a' } },
  boardId: 7 as number | null,
  connection: {
    localConnected: true,
    pending: false,
    sessionId: null as string | null,
    ledless: false,
    bluetooth: { staleCurrentHold: null as { queueItemUuid: string } | null },
  },
  drive: { phase: 'live' as 'arming' | 'live', sessionId: null as string | null, boardId: 7 as number | null },
  wall: { uuid: 'climb-a' },
  clearedClimbUuid: null as string | null,
  writing: false,
}));
vi.mock('react-native', () => ({
  View: ({ testID, children }: { testID?: string; children?: ReactNode }) =>
    createElement('div', { 'data-testid': testID }, children),
  StyleSheet: { create: (styles: unknown) => styles },
}));
vi.mock('../../../lib/graphql/use-active-board', () => ({
  useActiveBoard: () => ({ data: state.boardAvailable ? state.board : null, isPending: state.boardPending }),
}));
vi.mock('../../../providers/queue-provider', () => ({
  useQueueData: () => ({ currentClimbQueueItem: state.headAvailable ? state.head : null }),
}));
vi.mock('../../../providers/board-presence-provider', () => ({
  useBoardPresenceControls: () => ({ boardId: state.boardId }),
}));
vi.mock('../../../providers/bluetooth-write-activity', () => ({ useBluetoothWriteInProgress: () => state.writing }));
vi.mock('../../ble/use-board-connection-state', () => ({ useBoardConnectionState: () => state.connection }));
vi.mock('../../ble/wall-cleared-store', () => ({ useWallClearedClimbUuid: () => state.clearedClimbUuid }));
vi.mock('../drive-mode-store', () => ({ useDriveMode: () => (state.driveAvailable ? state.drive : null) }));
vi.mock('../use-wall-climb', () => ({ useWallClimb: () => state.wall }));

const readyId = 'store-current-driving-board-a-climb-a';
beforeEach(() => {
  for (const name of [
    'EXPO_PUBLIC_SCREENSHOT_MODE',
    'EXPO_PUBLIC_SCREENSHOT_DRIVING',
    'EXPO_PUBLIC_SCREENSHOT_FAKE_BLE',
  ])
    vi.stubEnv(name, '1');
  Object.assign(state, {
    board: { uuid: 'board-a', boardType: 'kilter', hasLeds: true },
    boardPending: false,
    boardAvailable: true,
    headAvailable: true,
    driveAvailable: true,
    head: { uuid: 'item-a', climb: { uuid: 'climb-a' } },
    boardId: 7,
    connection: {
      localConnected: true,
      pending: false,
      sessionId: null,
      ledless: false,
      bluetooth: { staleCurrentHold: null },
    },
    drive: { phase: 'live', sessionId: null, boardId: 7 },
    wall: { uuid: 'climb-a' },
    clearedClimbUuid: null,
    writing: false,
  });
  clearScreenshotDriveRequest();
});
afterEach(() => {
  cleanup();
  clearScreenshotDriveRequest();
  vi.unstubAllEnvs();
});

describe('current driving screenshot proof', () => {
  it('requires an explicit exact intent even while a real drive is already live', () => {
    const view = render(<ScreenshotCurrentDriveReadiness />);
    expect(view.queryByTestId(readyId)).toBeNull();
    act(() => requestScreenshotDrive('board-a', 'climb-a'));
    expect(view.getByTestId(readyId)).toBeTruthy();
    act(() => requestScreenshotDrive('board-b', 'climb-a'));
    expect(view.queryByTestId(readyId)).toBeNull();
    act(() => requestScreenshotDrive('board-a', 'other-climb'));
    expect(view.queryByTestId(readyId)).toBeNull();
    act(() => clearScreenshotDriveRequest());
    expect(view.queryByTestId(readyId)).toBeNull();
  });

  it.each(['EXPO_PUBLIC_SCREENSHOT_MODE', 'EXPO_PUBLIC_SCREENSHOT_DRIVING', 'EXPO_PUBLIC_SCREENSHOT_FAKE_BLE'])(
    'withdraws proof when %s is disabled',
    (flag) => {
      act(() => requestScreenshotDrive('board-a', 'climb-a'));
      const view = render(<ScreenshotCurrentDriveReadiness />);
      expect(view.getByTestId(readyId)).toBeTruthy();
      vi.stubEnv(flag, '0');
      view.rerender(<ScreenshotCurrentDriveReadiness />);
      expect(view.queryByTestId(readyId)).toBeNull();
    },
  );

  it.each([
    [
      'drive stopped',
      () => {
        state.driveAvailable = false;
      },
    ],
    [
      'no active board',
      () => {
        state.boardAvailable = false;
      },
    ],
    [
      'empty queue',
      () => {
        state.headAvailable = false;
      },
    ],
    [
      'board loading',
      () => {
        state.boardPending = true;
      },
    ],
    [
      'other active board',
      () => {
        state.board.uuid = 'board-b';
      },
    ],
    [
      'spray wall',
      () => {
        state.board.boardType = 'spray';
      },
    ],
    [
      'wall without LEDs',
      () => {
        state.board.hasLeds = false;
      },
    ],
    [
      'ledless connection',
      () => {
        state.connection.ledless = true;
      },
    ],
    [
      'link dropped',
      () => {
        state.connection.localConnected = false;
      },
    ],
    [
      'connect pending',
      () => {
        state.connection.pending = true;
      },
    ],
    [
      'write pending',
      () => {
        state.writing = true;
      },
    ],
    [
      'joined crew',
      () => {
        state.connection.sessionId = 'crew';
      },
    ],
    [
      'shared drive',
      () => {
        state.drive.sessionId = 'crew';
      },
    ],
    [
      'drive arming',
      () => {
        state.drive.phase = 'arming';
      },
    ],
    [
      'unbound board',
      () => {
        state.boardId = null;
      },
    ],
    [
      'unknown driven board',
      () => {
        state.drive.boardId = null;
      },
    ],
    [
      'drive on other board',
      () => {
        state.drive.boardId = 8;
      },
    ],
    [
      'queue head changed',
      () => {
        state.head.climb.uuid = 'climb-b';
      },
    ],
    [
      'wall changed',
      () => {
        state.wall.uuid = 'climb-b';
      },
    ],
    [
      'current lights turned off',
      () => {
        state.clearedClimbUuid = 'climb-a';
      },
    ],
    [
      'stale dark current hold',
      () => {
        state.connection.bluetooth.staleCurrentHold = { queueItemUuid: 'item-a' };
      },
    ],
  ] as const)('withdraws proof after player dismissal on %s', (_name, change) => {
    act(() => requestScreenshotDrive('board-a', 'climb-a'));
    const view = render(<ScreenshotCurrentDriveReadiness />);
    expect(view.getByTestId(readyId)).toBeTruthy();
    change();
    view.rerender(<ScreenshotCurrentDriveReadiness />);
    expect(view.queryByTestId(readyId)).toBeNull();
  });

  it('survives observer remounts only while the actual exact drive remains live', () => {
    act(() => requestScreenshotDrive('board-a', 'climb-a'));
    const first = render(<ScreenshotCurrentDriveReadiness />);
    expect(first.getByTestId(readyId)).toBeTruthy();
    first.unmount();
    const next = render(<ScreenshotCurrentDriveReadiness />);
    expect(next.getByTestId(readyId)).toBeTruthy();
    state.drive.phase = 'arming';
    next.rerender(<ScreenshotCurrentDriveReadiness />);
    expect(next.queryByTestId(readyId)).toBeNull();
  });
});
