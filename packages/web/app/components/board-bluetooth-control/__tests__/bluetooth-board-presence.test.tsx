// Board-presence BLE wiring: on connect → resolveAndBindBoard, and on
// wall-confirm → reportClimb + Undo snackbar. Mirrors the mobile
// bluetooth-provider's presence coverage. The report/resolve paths are inert
// until a board is bound (boardId null), so the BLE flow behaves as today.

import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { render, waitFor } from '@testing-library/react';
import React from 'react';
import type { BoardDetails } from '@/app/lib/types';
import type { ClimbQueueItem } from '../../queue-control/types';
import type { BoardPresenceClimb } from '@boardsesh/shared-schema';
import { tFromCatalog } from '@/app/__test-helpers__/i18n-mock';

const mockTrack = vi.hoisted(() => vi.fn());
vi.mock('react-i18next', () => ({
  useTranslation: (ns?: string) => ({
    t: (key: string, options?: Record<string, unknown>) => tFromCatalog(ns, key, options),
    i18n: { language: 'en-US' },
  }),
  Trans: ({ children }: { children?: React.ReactNode }) => children ?? null,
}));

vi.mock('@/app/lib/analytics', () => ({ track: mockTrack }));

// Mutable BLE state + captured callbacks so the test can drive connect and the
// AutoSender without a real adapter.
const ble = vi.hoisted(() => ({ isConnected: false }));
let lastConnectSuccess: ((serial: string | null) => void) | null = null;
const mockSendFrames = vi.fn().mockResolvedValue(true);
vi.mock('../use-board-bluetooth', () => ({
  useBoardBluetooth: (options: { onConnectSuccess?: (serial: string | null) => void }) => {
    lastConnectSuccess = options.onConnectSuccess ?? null;
    return {
      isConnected: ble.isConnected,
      loading: false,
      connect: vi.fn(),
      disconnect: vi.fn(),
      sendFramesToBoard: mockSendFrames,
      lastSendFailureReasonRef: { current: null },
      pickerState: null,
      reconnectSerialForCurrentBoard: null,
    };
  },
}));

vi.mock('@/app/hooks/use-ws-auth-token', () => ({
  useWsAuthToken: () => ({ token: null, isAuthenticated: false, isLoading: false, error: null }),
}));

vi.mock('@/app/lib/ble/resolve-serials', () => ({ resolveSerialNumbers: vi.fn().mockResolvedValue(new Map()) }));
vi.mock('../bluetooth-aurora', () => ({ parseSerialNumber: (name: string) => name }));
vi.mock('../device-picker-dialog', () => ({ DevicePickerDialog: () => null }));
vi.mock('../board-config-mismatch-dialog', () => ({ BoardConfigMismatchDialog: () => null }));
vi.mock('../auto-connect-handler', () => ({ AutoConnectHandler: () => null }));
vi.mock('@/app/lib/i18n/use-locale-router', () => ({ useLocaleRouter: () => ({ push: vi.fn() }) }));
vi.mock('next/navigation', () => ({ useParams: () => ({ angle: '40' }) }));
vi.mock('../bluetooth-status-store', () => ({ registerBluetoothConnection: vi.fn(() => vi.fn()) }));
vi.mock('@/app/lib/ble/capacitor-utils', () => ({
  isCapacitor: vi.fn(() => false),
  isCapacitorWebView: vi.fn(() => false),
  isNativeApp: vi.fn(() => false),
  waitForCapacitor: vi.fn().mockResolvedValue(false),
  CAPACITOR_BRIDGE_TIMEOUT_MS: 2000,
}));
vi.mock('@/app/lib/led-color-overrides-db', () => ({ useLedColorOverrides: () => [{}, vi.fn()] }));

// frame helpers used by the AutoSender — return the frame verbatim.
vi.mock('@boardsesh/board-constants/hold-states', () => ({
  accumulateFramesToMaps: () => ({}),
  accumulatedMapsToFrameStrings: () => ['p1r1'],
}));

const mockShowMessage = vi.fn();
vi.mock('../../providers/snackbar-provider', () => ({ useSnackbar: () => ({ showMessage: mockShowMessage }) }));

const mockConfirmClimbOnWall = vi.fn().mockResolvedValue(undefined);
vi.mock('@/app/components/persistent-session', () => ({
  usePersistentSessionActions: () => ({
    confirmClimbOnWall: mockConfirmClimbOnWall,
    setSessionBoardSerial: vi.fn().mockResolvedValue(undefined),
  }),
  usePersistentSessionState: () => ({ session: null }),
}));

const queue = vi.hoisted(() => ({ current: null as ClimbQueueItem | null }));
vi.mock('../../graphql-queue', () => ({
  useCurrentClimb: () => ({ currentClimbQueueItem: queue.current, currentClimb: queue.current?.climb ?? null }),
}));

vi.mock('@boardsesh/play-view', () => ({ emitWallConfirm: vi.fn() }));

// The presence controls + wall report — the surface under test.
const presence = vi.hoisted(() => ({
  boardId: null as number | null,
  currentClimb: null as BoardPresenceClimb | null,
  resolveAndBindBoard: vi.fn().mockResolvedValue(null),
  reportClimb: vi.fn().mockResolvedValue(true),
  undo: vi.fn().mockResolvedValue(true),
}));
vi.mock('../../board-presence/board-presence-context', () => ({
  useBoardPresenceControls: () => ({
    boardId: presence.boardId,
    resolveAndBindBoard: presence.resolveAndBindBoard,
  }),
  useOptionalWallReport: () => ({
    currentClimb: presence.currentClimb,
    previousClimb: null,
    reportClimb: presence.reportClimb,
    undo: presence.undo,
  }),
}));

import { BluetoothProvider } from '../bluetooth-context';

function makeBoardDetails(overrides: Partial<BoardDetails> = {}): BoardDetails {
  return {
    board_name: 'kilter',
    layout_id: 1,
    size_id: 10,
    set_ids: [1, 2],
    images_to_holds: {},
    holdsData: {},
    edge_left: 0,
    edge_right: 100,
    edge_bottom: 0,
    edge_top: 100,
    boardHeight: 100,
    boardWidth: 100,
    layout_name: 'Original',
    ...overrides,
  } as unknown as BoardDetails;
}

function makeItem(uuid: string, overrides: Partial<ClimbQueueItem['climb']> = {}): ClimbQueueItem {
  return {
    uuid: `q-${uuid}`,
    climb: {
      uuid,
      name: `Climb ${uuid}`,
      frames: 'p1r1',
      angle: 45,
      mirrored: false,
      setter_username: 's',
      description: '',
      ascensionist_count: 0,
      difficulty: 'V5',
      quality_average: '4',
      stars: 4,
      difficulty_error: '',
      ...overrides,
    },
    addedBy: 'me',
  } as unknown as ClimbQueueItem;
}

function makePresenceClimb(climbUuid: string, overrides: Partial<BoardPresenceClimb> = {}): BoardPresenceClimb {
  return {
    climbUuid,
    queueItemUuid: `q-${climbUuid}`,
    name: `Wall ${climbUuid}`,
    grade: 'V4',
    frames: 'p9r1',
    angle: 40,
    setter: 'setter',
    sentAt: '2026-06-10T00:00:00.000Z',
    seq: 1,
    ...overrides,
  };
}

describe('Bluetooth board-presence: connect → resolve', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    ble.isConnected = false;
    queue.current = null;
    presence.boardId = null;
    presence.currentClimb = null;
    presence.resolveAndBindBoard.mockResolvedValue(null);
    lastConnectSuccess = null;
  });

  it('resolves + binds the board on connect, with the route board config', () => {
    render(
      <BluetoothProvider boardDetails={makeBoardDetails()}>
        <div />
      </BluetoothProvider>,
    );
    lastConnectSuccess?.('SERIAL-123');
    expect(presence.resolveAndBindBoard).toHaveBeenCalledWith({
      serial: 'SERIAL-123',
      boardType: 'kilter',
      layoutId: 1,
      sizeId: 10,
      setIds: '1,2',
    });
  });

  it('resolves serial-less boards through the route config fallback', () => {
    render(
      <BluetoothProvider boardDetails={makeBoardDetails({ board_name: 'moonboard' })}>
        <div />
      </BluetoothProvider>,
    );
    lastConnectSuccess?.(null);
    expect(presence.resolveAndBindBoard).toHaveBeenCalledWith({
      serial: null,
      boardType: 'moonboard',
      layoutId: 1,
      sizeId: 10,
      setIds: '1,2',
    });
  });

  it('catches board resolution rejection on connect', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    presence.resolveAndBindBoard.mockRejectedValueOnce(new Error('resolve failed'));
    render(
      <BluetoothProvider boardDetails={makeBoardDetails()}>
        <div />
      </BluetoothProvider>,
    );
    lastConnectSuccess?.('SERIAL-123');

    await waitFor(() => {
      expect(warnSpy).toHaveBeenCalledWith(
        '[board-presence] failed to resolve board on BLE connect',
        expect.any(Error),
      );
    });
    warnSpy.mockRestore();
  });
});

describe('Bluetooth board-presence: wall-confirm → report + Undo', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    queue.current = makeItem('c1');
    ble.isConnected = true;
    mockSendFrames.mockResolvedValue(true);
    presence.boardId = 77;
    presence.currentClimb = makePresenceClimb('previous');
    presence.reportClimb.mockResolvedValue(true);
    presence.undo.mockResolvedValue(true);
  });

  it('reports the lit climb and Undo re-lights the captured previous wall climb before re-reporting', async () => {
    render(
      <BluetoothProvider boardDetails={makeBoardDetails()}>
        <div />
      </BluetoothProvider>,
    );

    // The AutoSender (mounted because isConnected) sends the current climb and
    // calls onWallConfirmed, which reports to the wall feed for a bound board.
    await waitFor(() => {
      expect(presence.reportClimb).toHaveBeenCalledTimes(1);
    });
    const [climbInput, angle] = presence.reportClimb.mock.calls[0];
    expect(climbInput.uuid).toBe('q-c1');
    expect(climbInput.climb.uuid).toBe('c1');
    expect(angle).toBe(45);

    // The accidental-takeover Undo snackbar fires after the report is accepted.
    await waitFor(() => {
      expect(mockShowMessage).toHaveBeenCalledTimes(1);
    });
    const [text, severity, action, duration] = mockShowMessage.mock.calls[0];
    expect(text).toBe(tFromCatalog('session', 'boardPresence.wallChanged'));
    expect(severity).toBe('info');
    expect(action.label).toBe(tFromCatalog('session', 'boardPresence.undo'));
    expect(duration).toBe(8000);

    action.onClick();
    await waitFor(() => {
      expect(mockSendFrames).toHaveBeenCalledTimes(2);
      expect(presence.reportClimb).toHaveBeenCalledTimes(2);
    });
    expect(mockSendFrames.mock.calls[1][0]).toBe('p9r1');
    expect(mockSendFrames.mock.calls[1][1]).toBe(false);
    const [restoredInput, restoredAngle] = presence.reportClimb.mock.calls[1];
    expect(restoredInput.climb.uuid).toBe('previous');
    expect(restoredAngle).toBe(40);
    expect(mockSendFrames.mock.invocationCallOrder[1]).toBeLessThan(presence.reportClimb.mock.invocationCallOrder[1]);
  });

  it('does NOT report when no board is bound (boardId null)', async () => {
    presence.boardId = null;
    render(
      <BluetoothProvider boardDetails={makeBoardDetails()}>
        <div />
      </BluetoothProvider>,
    );
    await waitFor(() => {
      expect(mockSendFrames).toHaveBeenCalled();
    });
    expect(presence.reportClimb).not.toHaveBeenCalled();
  });

  it('does not commit report dedup when the server returns false, so the same send can retry', async () => {
    presence.reportClimb.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const rendered = render(
      <BluetoothProvider boardDetails={makeBoardDetails()}>
        <div />
      </BluetoothProvider>,
    );

    await waitFor(() => {
      expect(presence.reportClimb).toHaveBeenCalledTimes(1);
    });
    expect(mockShowMessage).not.toHaveBeenCalled();

    queue.current = makeItem('c1');
    rendered.rerender(
      <BluetoothProvider boardDetails={makeBoardDetails()}>
        <div />
      </BluetoothProvider>,
    );

    await waitFor(() => {
      expect(presence.reportClimb).toHaveBeenCalledTimes(2);
      expect(mockShowMessage).toHaveBeenCalledTimes(1);
    });
  });

  it('catches rejected reports and allows the same send to retry', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    presence.reportClimb.mockRejectedValueOnce(new Error('report failed')).mockResolvedValueOnce(true);
    const rendered = render(
      <BluetoothProvider boardDetails={makeBoardDetails()}>
        <div />
      </BluetoothProvider>,
    );

    await waitFor(() => {
      expect(warnSpy).toHaveBeenCalledWith('[board-presence] failed to report lit climb', expect.any(Error));
    });

    queue.current = makeItem('c1');
    rendered.rerender(
      <BluetoothProvider boardDetails={makeBoardDetails()}>
        <div />
      </BluetoothProvider>,
    );

    await waitFor(() => {
      expect(presence.reportClimb).toHaveBeenCalledTimes(2);
    });
    warnSpy.mockRestore();
  });

  it('reports same-uuid re-lights when the rendered frame signature changes', async () => {
    const rendered = render(
      <BluetoothProvider boardDetails={makeBoardDetails()}>
        <div />
      </BluetoothProvider>,
    );

    await waitFor(() => {
      expect(presence.reportClimb).toHaveBeenCalledTimes(1);
    });

    queue.current = makeItem('c1', { frames: 'p2r1' });
    rendered.rerender(
      <BluetoothProvider boardDetails={makeBoardDetails()}>
        <div />
      </BluetoothProvider>,
    );

    await waitFor(() => {
      expect(presence.reportClimb).toHaveBeenCalledTimes(2);
    });
    expect(presence.reportClimb.mock.calls[1][0].climb.frames).toBe('p2r1');
  });

  it('resets report dedup after a board change', async () => {
    const rendered = render(
      <BluetoothProvider boardDetails={makeBoardDetails()}>
        <div />
      </BluetoothProvider>,
    );

    await waitFor(() => {
      expect(presence.reportClimb).toHaveBeenCalledTimes(1);
    });

    presence.boardId = 88;
    queue.current = null;
    rendered.rerender(
      <BluetoothProvider boardDetails={makeBoardDetails()}>
        <div />
      </BluetoothProvider>,
    );

    await waitFor(() => {
      expect(mockSendFrames).toHaveBeenCalledTimes(1);
    });

    queue.current = makeItem('c1');
    rendered.rerender(
      <BluetoothProvider boardDetails={makeBoardDetails()}>
        <div />
      </BluetoothProvider>,
    );

    await waitFor(() => {
      expect(presence.reportClimb).toHaveBeenCalledTimes(2);
    });
  });

  it('never sends the raw BLE serial to analytics from presence reporting', async () => {
    render(
      <BluetoothProvider boardDetails={makeBoardDetails()}>
        <div />
      </BluetoothProvider>,
    );

    lastConnectSuccess?.('SERIAL-SECRET');
    await waitFor(() => {
      expect(presence.reportClimb).toHaveBeenCalledTimes(1);
      expect(mockTrack).toHaveBeenCalled();
    });

    for (const trackCall of mockTrack.mock.calls) {
      expect(JSON.stringify(trackCall)).not.toContain('SERIAL-SECRET');
    }
  });
});
