import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { renderHook, act } from '@testing-library/react';
import React from 'react';
import { BluetoothProvider, useBluetoothContext } from '../bluetooth-context';
import type { BoardDetails } from '@/app/lib/types';
import type { BleSendFailureReason } from '@boardsesh/ble-protocol/connection-error';
import { tFromCatalog } from '@/app/__test-helpers__/i18n-mock';

vi.mock('react-i18next', () => ({
  useTranslation: (ns?: string) => ({
    t: (key: string, options?: Record<string, unknown>) => tFromCatalog(ns, key, options),
    i18n: { language: 'en-US' },
  }),
  Trans: ({ children }: { children?: React.ReactNode }) => children ?? null,
}));

// Mock dependencies before importing the module
const mockTrack = vi.fn();
vi.mock('@/app/lib/analytics', () => ({
  track: (...args: unknown[]) => mockTrack(...args),
}));

const mockSendFramesToBoard = vi.fn().mockResolvedValue(true);
const mockConnect = vi.fn().mockResolvedValue(true);
const mockDisconnect = vi.fn();
const mockPickerHandleSelect = vi.fn();
const mockPickerHandleCancel = vi.fn();

type PickerStateMock = {
  devices: Array<{ deviceId: string; name: string; rssi: number }>;
  handleSelect: (deviceId: string) => void;
  handleCancel: () => void;
} | null;

// Mirrors the ref the real hook returns. The hook sets `.current` synchronously
// on its failing path before resolving `false`; tests pre-set it to simulate
// that, since the AutoSender reads it right after the awaited send resolves.
const mockSendFailureReasonRef: { current: BleSendFailureReason | null } = { current: null };

let mockBluetoothState = {
  isConnected: false,
  loading: false,
  connect: mockConnect,
  disconnect: mockDisconnect,
  sendFramesToBoard: mockSendFramesToBoard,
  lastSendFailureReasonRef: mockSendFailureReasonRef,
};
let mockPickerState: PickerStateMock = null;

// Capture the `onConnectSuccess` callback passed by BluetoothProvider so
// tests can simulate "BLE connected with parsed serial" without rendering
// the real adapter or stubbing every other useBoardBluetooth dependency.
let lastUseBoardBluetoothOptions: {
  onConnectSuccess?: (serial: string | null) => void;
  onConnectionChange?: (connected: boolean) => void;
} | null = null;
vi.mock('../use-board-bluetooth', () => ({
  useBoardBluetooth: (options: {
    onConnectSuccess?: (serial: string | null) => void;
    onConnectionChange?: (connected: boolean) => void;
  }) => {
    lastUseBoardBluetoothOptions = options;
    return { ...mockBluetoothState, pickerState: mockPickerState };
  },
}));

let mockAuth: { token: string | null; isAuthenticated: boolean } = { token: null, isAuthenticated: false };
vi.mock('@/app/hooks/use-ws-auth-token', () => ({
  useWsAuthToken: () => mockAuth,
}));

const mockResolveSerialNumbers = vi.fn().mockResolvedValue(new Map());
vi.mock('@/app/lib/ble/resolve-serials', () => ({
  resolveSerialNumbers: (...args: unknown[]) => mockResolveSerialNumbers(...args),
}));

const mockParseSerialNumber = vi.fn();
vi.mock('../bluetooth-aurora', () => ({
  parseSerialNumber: (...args: unknown[]) => mockParseSerialNumber(...args),
}));

// Capture props the provider passes to the picker / mismatch dialog so tests
// can drive their callbacks without rendering MUI.
type PickerProps = {
  devices: Array<{ deviceId: string; name: string; rssi: number }>;
  onSelect: (deviceId: string) => void;
  onCancel: () => void;
  resolvedBoards?: Map<string, unknown>;
};
let lastPickerProps: PickerProps | null = null;
vi.mock('../device-picker-dialog', () => ({
  DevicePickerDialog: (props: PickerProps) => {
    lastPickerProps = props;
    return null;
  },
}));

type MismatchDialogProps = {
  open: boolean;
  onSwitch: () => void;
  onConnectAnyway: () => void;
  onCancel: () => void;
};
let lastMismatchProps: MismatchDialogProps | null = null;
vi.mock('../board-config-mismatch-dialog', () => ({
  BoardConfigMismatchDialog: (props: MismatchDialogProps) => {
    lastMismatchProps = props;
    return null;
  },
}));

vi.mock('../auto-connect-handler', () => ({
  AutoConnectHandler: () => null,
}));

const mockRouterPush = vi.fn();
const mockRouterReplace = vi.fn();
vi.mock('next/navigation', () => ({
  useParams: () => ({ angle: '40' }),
  useRouter: () => ({ push: mockRouterPush, replace: mockRouterReplace }),
}));

const mockShowMessage = vi.fn();
vi.mock('../../providers/snackbar-provider', () => ({
  useSnackbar: () => ({ showMessage: mockShowMessage }),
}));

vi.mock('../bluetooth-status-store', () => ({
  registerBluetoothConnection: vi.fn(() => vi.fn()),
}));

vi.mock('@/app/lib/ble/capacitor-utils', () => ({
  isCapacitor: vi.fn(() => false),
  isCapacitorWebView: vi.fn(() => false),
  isNativeApp: vi.fn(() => false),
  waitForCapacitor: vi.fn().mockResolvedValue(false),
  CAPACITOR_BRIDGE_TIMEOUT_MS: 2000,
}));

const mockConfirmClimbOnWall = vi.fn().mockResolvedValue(undefined);
const mockSetSessionBoardSerial = vi.fn().mockResolvedValue(undefined);
const mockReportWallDisconnect = vi.fn().mockResolvedValue(undefined);
let mockPersistentSessionState: { session: { id: string; lastConnectedBoardSerial?: string | null } | null } = {
  session: null,
};
vi.mock('@/app/components/persistent-session', () => ({
  usePersistentSessionActions: () => ({
    confirmClimbOnWall: mockConfirmClimbOnWall,
    setSessionBoardSerial: mockSetSessionBoardSerial,
    reportWallDisconnect: mockReportWallDisconnect,
  }),
  usePersistentSessionState: () => mockPersistentSessionState,
}));

// Board-presence controls. Default inert (boardId null), matching the real
// DISABLED_CONTROLS fallback when no provider is mounted, so existing tests are
// unaffected. A test can set mockPresenceBoardId to assert the BLE-drop holder
// release. `useOptionalWallReport` stays inert (no wall reports in these tests).
let mockPresenceBoardId: number | null = null;
const mockReportBoardDisconnect = vi.fn().mockResolvedValue(true);
const mockResolveAndBindBoard = vi.fn().mockResolvedValue(null);
vi.mock('../../board-presence/board-presence-context', () => ({
  useBoardPresenceControls: () => ({
    boardId: mockPresenceBoardId,
    resolveAndBindBoard: mockResolveAndBindBoard,
    reportDisconnect: mockReportBoardDisconnect,
  }),
  useOptionalWallReport: () => ({ currentClimb: null, previousClimb: null, reportClimb: vi.fn() }),
}));

let mockCurrentClimbQueueItem: {
  climb: { uuid: string; frames: string; mirrored: boolean };
} | null = null;

vi.mock('../../graphql-queue', () => ({
  useQueueContext: () => ({
    currentClimbQueueItem: mockCurrentClimbQueueItem,
  }),
  useCurrentClimb: () => ({
    currentClimbQueueItem: mockCurrentClimbQueueItem,
    currentClimb: mockCurrentClimbQueueItem?.climb ?? null,
  }),
}));

function createTestBoardDetails(overrides?: Partial<BoardDetails>): BoardDetails {
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
    size_name: '12x12',
    size_description: 'Full Size',
    set_names: ['Standard', 'Extended'],
    ...overrides,
  } as BoardDetails;
}

function createWrapper(boardDetails?: BoardDetails) {
  const details = boardDetails ?? createTestBoardDetails();
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return <BluetoothProvider boardDetails={details}>{children}</BluetoothProvider>;
  };
}

describe('BluetoothProvider', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCurrentClimbQueueItem = null;
    mockSendFailureReasonRef.current = null;
    mockBluetoothState = {
      isConnected: false,
      loading: false,
      connect: mockConnect,
      disconnect: mockDisconnect,
      sendFramesToBoard: mockSendFramesToBoard,
      lastSendFailureReasonRef: mockSendFailureReasonRef,
    };
    mockPickerState = null;
    lastPickerProps = null;
    lastMismatchProps = null;
    mockAuth = { token: null, isAuthenticated: false };
    mockResolveSerialNumbers.mockResolvedValue(new Map());
    mockPresenceBoardId = null;
    mockReportBoardDisconnect.mockResolvedValue(true);
    mockPersistentSessionState = { session: null };
    mockConfirmClimbOnWall.mockResolvedValue(undefined);
    mockSetSessionBoardSerial.mockResolvedValue(undefined);
    mockReportWallDisconnect.mockResolvedValue(undefined);
    lastUseBoardBluetoothOptions = null;
  });

  describe('useBluetoothContext', () => {
    it('throws when used outside BluetoothProvider', () => {
      // Suppress React error boundary console output
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      expect(() => {
        renderHook(() => useBluetoothContext());
      }).toThrow('useBluetoothContext must be used within a BluetoothProvider');
      consoleSpy.mockRestore();
    });

    it('returns context values when used inside BluetoothProvider', () => {
      const { result } = renderHook(() => useBluetoothContext(), {
        wrapper: createWrapper(),
      });

      expect(result.current).toHaveProperty('isConnected');
      expect(result.current).toHaveProperty('loading');
      expect(result.current).toHaveProperty('connect');
      expect(result.current).toHaveProperty('disconnect');
      expect(result.current).toHaveProperty('sendFramesToBoard');
      expect(result.current).toHaveProperty('isBluetoothSupported');
      expect(result.current).toHaveProperty('isIOS');
    });

    it('provides correct initial connection state', () => {
      const { result } = renderHook(() => useBluetoothContext(), {
        wrapper: createWrapper(),
      });

      expect(result.current.isConnected).toBe(false);
      expect(result.current.loading).toBe(false);
    });

    it('renders an inert context with null boardDetails (off-board route)', () => {
      // The single root-level provider spans every route; off a board route it
      // gets null boardDetails and must still provide a usable (inert) context
      // rather than throwing for any stray consumer.
      const NullWrapper = ({ children }: { children: React.ReactNode }) => (
        <BluetoothProvider boardDetails={null}>{children}</BluetoothProvider>
      );
      const { result } = renderHook(() => useBluetoothContext(), { wrapper: NullWrapper });

      expect(result.current.boardDetails).toBeNull();
      expect(result.current.isConnected).toBe(false);
      expect(typeof result.current.sendFramesToBoard).toBe('function');
    });
  });

  describe('auto-send on climb change', () => {
    it('does not send when not connected', () => {
      mockCurrentClimbQueueItem = {
        climb: { uuid: 'climb-1', frames: 'p1r12p2r13', mirrored: false },
      };
      mockBluetoothState.isConnected = false;

      renderHook(() => useBluetoothContext(), {
        wrapper: createWrapper(),
      });

      expect(mockSendFramesToBoard).not.toHaveBeenCalled();
    });

    it('does not send when connected but no current climb', () => {
      mockCurrentClimbQueueItem = null;
      mockBluetoothState.isConnected = true;

      renderHook(() => useBluetoothContext(), {
        wrapper: createWrapper(),
      });

      expect(mockSendFramesToBoard).not.toHaveBeenCalled();
    });

    it('sends frames when connected and climb is available', async () => {
      mockCurrentClimbQueueItem = {
        climb: { uuid: 'climb-1', frames: 'p1r12p2r13', mirrored: false },
      };
      mockBluetoothState.isConnected = true;

      renderHook(() => useBluetoothContext(), {
        wrapper: createWrapper(),
      });

      // The useEffect triggers async sendClimb
      await act(async () => {
        await vi.waitFor(() => {
          expect(mockSendFramesToBoard).toHaveBeenCalledWith('p1r12p2r13', false, expect.any(AbortSignal), 'climb-1');
        });
      });
    });

    it('sends with mirrored=true when climb is mirrored', async () => {
      mockCurrentClimbQueueItem = {
        climb: { uuid: 'climb-2', frames: 'p3r14p4r15', mirrored: true },
      };
      mockBluetoothState.isConnected = true;

      renderHook(() => useBluetoothContext(), {
        wrapper: createWrapper(),
      });

      await act(async () => {
        await vi.waitFor(() => {
          expect(mockSendFramesToBoard).toHaveBeenCalledWith('p3r14p4r15', true, expect.any(AbortSignal), 'climb-2');
        });
      });
    });

    it('tracks success analytics when send succeeds', async () => {
      mockSendFramesToBoard.mockResolvedValue(true);
      mockCurrentClimbQueueItem = {
        climb: { uuid: 'climb-1', frames: 'p1r12', mirrored: false },
      };
      mockBluetoothState.isConnected = true;

      renderHook(() => useBluetoothContext(), {
        wrapper: createWrapper(),
      });

      await act(async () => {
        await vi.waitFor(() => {
          expect(mockTrack).toHaveBeenCalledWith('Climb Sent to Board Success', {
            climbUuid: 'climb-1',
            boardLayout: 'Original',
            boardId: undefined,
          });
        });
      });
    });

    // The hook reports the precise cause via the ref; the AutoSender must label
    // the failure with that reason — not the retired catch-all
    // `characteristic_unavailable`, which hid the dominant mid-session drop.
    // These are the reasons the hook sets synchronously on a `return false`. The
    // throw-path reasons (`missing_mirror_mapping`, `dom_*`) come from the hook's
    // catch via `classifyBleFailureReason` and are unit-tested directly in
    // connection-error.test.ts; from the AutoSender's side they read identically
    // through the same ref, so they aren't re-parametrized here.
    const failureReasons: BleSendFailureReason[] = [
      'disconnected',
      'incompatible_climb',
      'missing_led_placements',
      'missing_mirror_data',
      'write_failed',
    ];
    for (const reason of failureReasons) {
      it(`tracks failure with the hook-reported reason: ${reason}`, async () => {
        mockSendFailureReasonRef.current = reason;
        mockSendFramesToBoard.mockResolvedValue(false);
        mockCurrentClimbQueueItem = {
          climb: { uuid: 'climb-1', frames: 'p1r12', mirrored: false },
        };
        mockBluetoothState.isConnected = true;

        renderHook(() => useBluetoothContext(), {
          wrapper: createWrapper(),
        });

        await act(async () => {
          await vi.waitFor(() => {
            expect(mockTrack).toHaveBeenCalledWith('Climb Sent to Board Failure', {
              climbUuid: 'climb-1',
              boardLayout: 'Original',
              boardId: undefined,
              failureReason: reason,
              climbHoldCount: 1,
            });
          });
        });

        // The misnomer must be gone for good.
        expect(mockTrack).not.toHaveBeenCalledWith(
          'Climb Sent to Board Failure',
          expect.objectContaining({ failureReason: 'characteristic_unavailable' }),
        );
      });
    }

    it('reads the reason the hook set at resolution time (not a hardcoded label)', async () => {
      // Faithful to the real hook: set the ref synchronously on the failing path
      // right before resolving false. The AutoSender reads it in the same
      // microtask the await resolves in.
      mockSendFramesToBoard.mockImplementation(async () => {
        mockSendFailureReasonRef.current = 'disconnected';
        return false;
      });
      mockCurrentClimbQueueItem = {
        climb: { uuid: 'climb-1', frames: 'p1r12', mirrored: false },
      };
      mockBluetoothState.isConnected = true;

      renderHook(() => useBluetoothContext(), {
        wrapper: createWrapper(),
      });

      await act(async () => {
        await vi.waitFor(() => {
          expect(mockTrack).toHaveBeenCalledWith(
            'Climb Sent to Board Failure',
            expect.objectContaining({ failureReason: 'disconnected' }),
          );
        });
      });
    });

    it('falls back to "unknown" when the hook left no reason', async () => {
      mockSendFailureReasonRef.current = null;
      mockSendFramesToBoard.mockResolvedValue(false);
      mockCurrentClimbQueueItem = {
        climb: { uuid: 'climb-1', frames: 'p1r12', mirrored: false },
      };
      mockBluetoothState.isConnected = true;

      renderHook(() => useBluetoothContext(), {
        wrapper: createWrapper(),
      });

      await act(async () => {
        await vi.waitFor(() => {
          expect(mockTrack).toHaveBeenCalledWith(
            'Climb Sent to Board Failure',
            expect.objectContaining({ failureReason: 'unknown' }),
          );
        });
      });
    });

    it('does not track analytics when send returns undefined (not attempted)', async () => {
      mockSendFramesToBoard.mockResolvedValue(undefined);
      mockCurrentClimbQueueItem = {
        climb: { uuid: 'climb-1', frames: 'p1r12', mirrored: false },
      };
      mockBluetoothState.isConnected = true;

      renderHook(() => useBluetoothContext(), {
        wrapper: createWrapper(),
      });

      await act(async () => {
        await vi.waitFor(() => {
          expect(mockSendFramesToBoard).toHaveBeenCalled();
        });
      });

      expect(mockTrack).not.toHaveBeenCalled();
    });

    it('catches exception and tracks failure when sendFramesToBoard throws', async () => {
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      mockSendFramesToBoard.mockRejectedValue(new Error('Bluetooth write failed'));
      mockCurrentClimbQueueItem = {
        climb: { uuid: 'climb-1', frames: 'p1r12', mirrored: false },
      };
      mockBluetoothState.isConnected = true;

      renderHook(() => useBluetoothContext(), {
        wrapper: createWrapper(),
      });

      await act(async () => {
        await vi.waitFor(() => {
          expect(mockTrack).toHaveBeenCalledWith('Climb Sent to Board Failure', {
            climbUuid: 'climb-1',
            boardLayout: 'Original',
            boardId: undefined,
            failureReason: 'write_aborted',
            climbHoldCount: 1,
          });
        });
      });

      expect(consoleSpy).toHaveBeenCalledWith('Error sending climb to board:', expect.any(Error));
      consoleSpy.mockRestore();
    });

    // Part B regression: after a mid-session drop the AutoSender unmounts
    // (isConnected → false), and on the take-back reconnect it remounts with a
    // fresh dedup signature — which re-sends the queued climb on its own. This
    // is the silent-drop recovery; it must fire EXACTLY ONCE per reconnect (no
    // explicit reassert stacked on top, which would double-send and double-count
    // analytics).
    it('re-sends the current climb exactly once after a drop and take-back reconnect', async () => {
      mockSendFramesToBoard.mockResolvedValue(true);
      mockCurrentClimbQueueItem = {
        climb: { uuid: 'climb-1', frames: 'p1r12', mirrored: false },
      };
      mockBluetoothState.isConnected = true;

      const { rerender, result } = renderHook(() => useBluetoothContext(), {
        wrapper: createWrapper(),
      });

      // Initial connection: AutoSender mounts and sends the climb once.
      await act(async () => {
        await vi.waitFor(() => expect(mockSendFramesToBoard).toHaveBeenCalledTimes(1));
      });

      // Board dropped: AutoSender unmounts, no further sends.
      await act(async () => {
        mockBluetoothState.isConnected = false;
        rerender();
      });
      expect(result.current.isConnected).toBe(false);
      expect(mockSendFramesToBoard).toHaveBeenCalledTimes(1);

      // Take-back reconnect: commit the remount (fresh dedup signature) inside
      // act, then poll OUTSIDE act for the remount's async send — polling rather
      // than a fixed delay so the assertion holds under slow CI. (vi.waitFor
      // nested inside act doesn't advance the drain here.)
      await act(async () => {
        mockBluetoothState.isConnected = true;
        rerender();
      });
      await vi.waitFor(() => expect(mockSendFramesToBoard).toHaveBeenCalledTimes(2));

      // Exactly one re-send for the unchanged climb — never a double.
      expect(mockSendFramesToBoard).toHaveBeenCalledTimes(2);
      expect(mockTrack).toHaveBeenCalledWith(
        'Climb Sent to Board Success',
        expect.objectContaining({ climbUuid: 'climb-1' }),
      );
    });
  });

  describe('rapid-swiping serialization', () => {
    it('queues the latest climb while a write is in flight and sends it after current completes', async () => {
      // Web BT on Android can't actually cancel an in-flight GATT operation,
      // so the AutoSender serializes writes via a latest-wins queue instead
      // of abort-and-restart. While one write is in flight, the most recent
      // pending climb is stored and sent when the current write resolves.
      // Intermediate climbs are skipped.
      let resolveFirstSend: (value: boolean) => void = () => {};
      mockSendFramesToBoard.mockImplementationOnce(
        () =>
          new Promise<boolean>((resolve) => {
            resolveFirstSend = resolve;
          }),
      );
      mockSendFramesToBoard.mockResolvedValue(true);
      mockCurrentClimbQueueItem = {
        climb: { uuid: 'climb-1', frames: 'p1r12', mirrored: false },
      };
      mockBluetoothState.isConnected = true;

      const { rerender } = renderHook(() => useBluetoothContext(), {
        wrapper: createWrapper(),
      });

      // Wait for the first send to start
      await act(async () => {
        await vi.waitFor(() => {
          expect(mockSendFramesToBoard).toHaveBeenCalledTimes(1);
        });
      });

      // Swap in a new climb while the first is in flight — should queue
      mockCurrentClimbQueueItem = {
        climb: { uuid: 'climb-2', frames: 'p3r14', mirrored: false },
      };
      rerender();

      // And another — should overwrite the queued climb (latest wins)
      mockCurrentClimbQueueItem = {
        climb: { uuid: 'climb-3', frames: 'p5r16', mirrored: false },
      };
      rerender();

      // Still only one in-flight write so far
      expect(mockSendFramesToBoard).toHaveBeenCalledTimes(1);

      // Resolve the first send — drain loop picks up climb-3 (climb-2 skipped)
      resolveFirstSend(true);
      await act(async () => {
        await vi.waitFor(() => {
          expect(mockSendFramesToBoard).toHaveBeenCalledTimes(2);
        });
      });
      expect(mockSendFramesToBoard).toHaveBeenLastCalledWith('p5r16', false, expect.any(AbortSignal), 'climb-3');
    });

    it('deduplicates the WRITE for byte-identical re-broadcasts but re-confirms the wall', async () => {
      // The reducer lets duplicate CurrentClimbChanged events through (so the
      // BLE phone reacts to every event, including a peer's takeControl
      // re-broadcast of the same climb). The AutoSender skips the physical
      // re-WRITE (no double GATT write, no double "Climb Sent" analytics) — but
      // still re-emits the wall-confirm so a non-BLE hand-off taker's 2-second
      // timer clears even though the wall already shows the climb.
      mockPersistentSessionState = { session: { id: 'session-1' } };
      mockSendFramesToBoard.mockResolvedValue(true);
      mockCurrentClimbQueueItem = {
        climb: { uuid: 'climb-1', frames: 'p1r12', mirrored: false },
      };
      mockBluetoothState.isConnected = true;

      const { rerender } = renderHook(() => useBluetoothContext(), {
        wrapper: createWrapper(),
      });

      // Wait for the first send + confirm.
      await act(async () => {
        await vi.waitFor(() => {
          expect(mockSendFramesToBoard).toHaveBeenCalledTimes(1);
          expect(mockConfirmClimbOnWall).toHaveBeenCalledTimes(1);
        });
      });

      // Same uuid + frames + mirror re-broadcast (new object identity).
      mockCurrentClimbQueueItem = {
        climb: { uuid: 'climb-1', frames: 'p1r12', mirrored: false },
      };
      rerender();

      // Let any pending microtasks / drain iterations run.
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });

      // No additional physical write or success analytics for the duplicate...
      expect(mockSendFramesToBoard).toHaveBeenCalledTimes(1);
      expect(
        mockTrack.mock.calls.filter(
          (call) => call[0] === 'Climb Sent to Board Success' && call[1]?.climbUuid === 'climb-1',
        ),
      ).toHaveLength(1);
      // ...but the wall-confirm re-fires so a hand-off taker's timer clears.
      expect(mockConfirmClimbOnWall).toHaveBeenCalledTimes(2);
    });

    it('reassertWall() forces a physical re-send of the byte-identical current climb', async () => {
      // The solo lightbulb "re-take" path bumps a reassert nonce so re-tapping
      // on an unchanged climb actually re-lights the wall, bypassing the
      // byte-identical dedup that otherwise skips the write.
      mockSendFramesToBoard.mockResolvedValue(true);
      mockCurrentClimbQueueItem = {
        climb: { uuid: 'climb-1', frames: 'p1r12', mirrored: false },
      };
      mockBluetoothState.isConnected = true;

      const { result } = renderHook(() => useBluetoothContext(), {
        wrapper: createWrapper(),
      });

      await act(async () => {
        await vi.waitFor(() => expect(mockSendFramesToBoard).toHaveBeenCalledTimes(1));
      });

      // Re-take: same climb, no broadcast. A plain re-render would dedup; the
      // reassert nonce punches through it exactly once.
      act(() => {
        result.current.reassertWall();
      });

      await act(async () => {
        await vi.waitFor(() => expect(mockSendFramesToBoard).toHaveBeenCalledTimes(2));
      });
      expect(mockSendFramesToBoard).toHaveBeenLastCalledWith('p1r12', false, expect.any(AbortSignal), 'climb-1');
    });

    it('re-sends when the same climb is mirrored (same uuid, mirror flipped)', async () => {
      // Regression: the old uuid-only dedup swallowed mirror toggles, so the
      // board only mirrored after a disconnect/reconnect.
      mockSendFramesToBoard.mockResolvedValue(true);
      mockCurrentClimbQueueItem = {
        climb: { uuid: 'climb-1', frames: 'p1r12', mirrored: false },
      };
      mockBluetoothState.isConnected = true;

      const { rerender } = renderHook(() => useBluetoothContext(), {
        wrapper: createWrapper(),
      });

      await act(async () => {
        await vi.waitFor(() => expect(mockSendFramesToBoard).toHaveBeenCalledTimes(1));
      });
      expect(mockSendFramesToBoard).toHaveBeenLastCalledWith('p1r12', false, expect.any(AbortSignal), 'climb-1');

      // Mirror the current climb: same uuid + frames, mirrored now true.
      mockCurrentClimbQueueItem = {
        climb: { uuid: 'climb-1', frames: 'p1r12', mirrored: true },
      };
      rerender();

      await act(async () => {
        await vi.waitFor(() => expect(mockSendFramesToBoard).toHaveBeenCalledTimes(2));
      });
      expect(mockSendFramesToBoard).toHaveBeenLastCalledWith('p1r12', true, expect.any(AbortSignal), 'climb-1');
    });

    it('re-sends when the same climb uuid gets edited frames (create-form live preview)', async () => {
      // Regression: building a climb reuses a stable uuid while the frames
      // change on every hold edit; the uuid-only dedup froze the wall.
      mockSendFramesToBoard.mockResolvedValue(true);
      mockCurrentClimbQueueItem = {
        climb: { uuid: 'draft-1', frames: 'p1r12', mirrored: false },
      };
      mockBluetoothState.isConnected = true;

      const { rerender } = renderHook(() => useBluetoothContext(), {
        wrapper: createWrapper(),
      });

      await act(async () => {
        await vi.waitFor(() => expect(mockSendFramesToBoard).toHaveBeenCalledTimes(1));
      });

      // Edit a hold: same uuid, new frames.
      mockCurrentClimbQueueItem = {
        climb: { uuid: 'draft-1', frames: 'p1r12p2r13', mirrored: false },
      };
      rerender();

      await act(async () => {
        await vi.waitFor(() => expect(mockSendFramesToBoard).toHaveBeenCalledTimes(2));
      });
      expect(mockSendFramesToBoard).toHaveBeenLastCalledWith('p1r12p2r13', false, expect.any(AbortSignal), 'draft-1');
    });
  });

  describe('disconnect', () => {
    it('exposes disconnect from the hook', () => {
      const { result } = renderHook(() => useBluetoothContext(), {
        wrapper: createWrapper(),
      });

      result.current.disconnect();

      expect(mockDisconnect).toHaveBeenCalledOnce();
    });
  });

  describe('connect', () => {
    it('exposes connect from the hook', async () => {
      const { result } = renderHook(() => useBluetoothContext(), {
        wrapper: createWrapper(),
      });

      await act(async () => {
        const success = await result.current.connect('p1r12', false);
        expect(success).toBe(true);
      });

      expect(mockConnect).toHaveBeenCalledWith('p1r12', false);
    });

    it('returns false when connect fails', async () => {
      mockConnect.mockResolvedValue(false);

      const { result } = renderHook(() => useBluetoothContext(), {
        wrapper: createWrapper(),
      });

      await act(async () => {
        const success = await result.current.connect();
        expect(success).toBe(false);
      });
    });
  });

  describe('context value stability', () => {
    it('exposes connect and disconnect functions from the hook', () => {
      const { result } = renderHook(() => useBluetoothContext(), {
        wrapper: createWrapper(),
      });

      expect(result.current.connect).toBe(mockConnect);
      expect(result.current.disconnect).toBe(mockDisconnect);
      expect(result.current.sendFramesToBoard).toBe(mockSendFramesToBoard);
    });
  });

  describe('mismatch interception', () => {
    // The picker discovers one device whose serial maps to a saved board with
    // a layout that intentionally doesn't match the provider's boardDetails —
    // handlePickerSelect should setMismatch instead of forwarding.
    async function setupMismatchScenario(opts: { withSlug?: boolean } = {}) {
      const serial = 'KB-99';
      mockAuth = { token: 'tok', isAuthenticated: true };
      mockPickerState = {
        devices: [{ deviceId: 'dev-1', name: `Kilter Board#${serial}@3`, rssi: -55 }],
        handleSelect: mockPickerHandleSelect,
        handleCancel: mockPickerHandleCancel,
      };
      mockParseSerialNumber.mockReturnValue(serial);
      mockResolveSerialNumbers.mockResolvedValue(
        new Map([
          [
            serial,
            {
              kind: 'saved',
              board: {
                boardType: 'kilter',
                layoutId: 99, // mismatches the test boardDetails (layoutId=1)
                sizeId: 10,
                setIds: '1,2',
                slug: opts.withSlug ? 'my-other-kilter' : undefined,
              },
            },
          ],
        ]),
      );

      const wrapper = createWrapper();
      const rendered = renderHook(() => useBluetoothContext(), { wrapper });

      // Wait for the resolveSerialNumbers effect to settle and the provider
      // to re-render with the resolved map.
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });

      // Drive the provider's handlePickerSelect that DevicePickerDialog received.
      expect(lastPickerProps).not.toBeNull();
      await act(async () => {
        lastPickerProps?.onSelect('dev-1');
      });

      return rendered;
    }

    it('picker select is a no-op when boardDetails is null (off-board inert provider)', async () => {
      // The single root-level provider is mounted off board routes too, where
      // boardDetails is null. handlePickerSelect must bail before forwarding the
      // selection or opening the mismatch dialog (decidePickerSelection needs a
      // real board to compare against).
      mockAuth = { token: 'tok', isAuthenticated: true };
      mockPickerState = {
        devices: [{ deviceId: 'dev-1', name: 'Kilter Board#KB-99@3', rssi: -55 }],
        handleSelect: mockPickerHandleSelect,
        handleCancel: mockPickerHandleCancel,
      };
      mockParseSerialNumber.mockReturnValue('KB-99');

      const NullWrapper = ({ children }: { children: React.ReactNode }) => (
        <BluetoothProvider boardDetails={null}>{children}</BluetoothProvider>
      );
      renderHook(() => useBluetoothContext(), { wrapper: NullWrapper });

      expect(lastPickerProps).not.toBeNull();
      await act(async () => {
        lastPickerProps?.onSelect('dev-1');
      });

      // Guard returned early: no forward to the adapter, no mismatch dialog.
      expect(mockPickerHandleSelect).not.toHaveBeenCalled();
      expect(lastMismatchProps).toBeNull();
    });

    it('Switch to correct config: pushes the slug-based URL with autoConnect serial', async () => {
      await setupMismatchScenario({ withSlug: true });

      expect(lastMismatchProps).not.toBeNull();
      expect(lastMismatchProps?.open).toBe(true);

      act(() => {
        lastMismatchProps?.onSwitch();
      });

      // Provider cancels the in-flight picker promise and pushes the
      // slug-based switch URL with the autoConnect serial appended.
      expect(mockPickerHandleCancel).toHaveBeenCalledTimes(1);
      expect(mockRouterPush).toHaveBeenCalledTimes(1);
      const target = mockRouterPush.mock.calls[0][0] as string;
      expect(target).toContain('/b/my-other-kilter/40/list');
      expect(target).toContain('autoConnect=KB-99');
    });

    it('Switch with unresolvable URL: shows snackbar and keeps picker open', async () => {
      // No slug + unknown layout → buildSwitchUrl returns null.
      await setupMismatchScenario({ withSlug: false });

      act(() => {
        lastMismatchProps?.onSwitch();
      });

      expect(mockShowMessage).toHaveBeenCalledTimes(1);
      expect(mockShowMessage.mock.calls[0][0]).toMatch(/Couldn't switch/i);
      expect(mockRouterPush).not.toHaveBeenCalled();
      expect(mockPickerHandleCancel).not.toHaveBeenCalled();
    });

    it('Connect anyway: forwards to the original picker handleSelect', async () => {
      await setupMismatchScenario({ withSlug: true });

      act(() => {
        lastMismatchProps?.onConnectAnyway();
      });

      expect(mockPickerHandleSelect).toHaveBeenCalledTimes(1);
      expect(mockPickerHandleSelect).toHaveBeenCalledWith('dev-1');
      expect(mockRouterPush).not.toHaveBeenCalled();
    });

    it('Cancel: drops the mismatch without touching the picker promise or router', async () => {
      await setupMismatchScenario({ withSlug: true });

      act(() => {
        lastMismatchProps?.onCancel();
      });

      expect(mockPickerHandleSelect).not.toHaveBeenCalled();
      expect(mockPickerHandleCancel).not.toHaveBeenCalled();
      expect(mockRouterPush).not.toHaveBeenCalled();
    });
  });

  describe('session mutations', () => {
    it('fires confirmClimbOnWall once per successful send with the climb uuid', async () => {
      mockPersistentSessionState = { session: { id: 'session-1' } };
      mockSendFramesToBoard.mockResolvedValue(true);
      mockCurrentClimbQueueItem = {
        climb: { uuid: 'climb-1', frames: 'p1r12', mirrored: false },
      };
      mockBluetoothState.isConnected = true;

      renderHook(() => useBluetoothContext(), {
        wrapper: createWrapper(),
      });

      await act(async () => {
        await vi.waitFor(() => {
          expect(mockConfirmClimbOnWall).toHaveBeenCalledTimes(1);
        });
      });
      expect(mockConfirmClimbOnWall).toHaveBeenCalledWith('climb-1');
    });

    it('does not call confirmClimbOnWall when no session exists (solo)', async () => {
      // The local wall-confirm bus still receives the signal (drawer timer
      // dismisses), but the WS mutation is skipped — solo has no peers.
      mockPersistentSessionState = { session: null };
      mockSendFramesToBoard.mockResolvedValue(true);
      mockCurrentClimbQueueItem = {
        climb: { uuid: 'climb-1', frames: 'p1r12', mirrored: false },
      };
      mockBluetoothState.isConnected = true;

      renderHook(() => useBluetoothContext(), {
        wrapper: createWrapper(),
      });

      await act(async () => {
        await vi.waitFor(() => {
          expect(mockSendFramesToBoard).toHaveBeenCalledTimes(1);
        });
      });

      expect(mockConfirmClimbOnWall).not.toHaveBeenCalled();
    });

    it('does not call confirmClimbOnWall when send returns false', async () => {
      mockPersistentSessionState = { session: { id: 'session-1' } };
      mockSendFramesToBoard.mockResolvedValue(false);
      mockCurrentClimbQueueItem = {
        climb: { uuid: 'climb-1', frames: 'p1r12', mirrored: false },
      };
      mockBluetoothState.isConnected = true;

      renderHook(() => useBluetoothContext(), {
        wrapper: createWrapper(),
      });

      await act(async () => {
        await vi.waitFor(() => {
          expect(mockTrack).toHaveBeenCalledWith('Climb Sent to Board Failure', expect.any(Object));
        });
      });

      expect(mockConfirmClimbOnWall).not.toHaveBeenCalled();
    });

    it('does not call confirmClimbOnWall when send throws a non-Abort error', async () => {
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      mockPersistentSessionState = { session: { id: 'session-1' } };
      mockSendFramesToBoard.mockRejectedValue(new Error('Bluetooth write failed'));
      mockCurrentClimbQueueItem = {
        climb: { uuid: 'climb-1', frames: 'p1r12', mirrored: false },
      };
      mockBluetoothState.isConnected = true;

      renderHook(() => useBluetoothContext(), {
        wrapper: createWrapper(),
      });

      await act(async () => {
        await vi.waitFor(() => {
          expect(mockTrack).toHaveBeenCalledWith('Climb Sent to Board Failure', expect.any(Object));
        });
      });

      expect(mockConfirmClimbOnWall).not.toHaveBeenCalled();
      consoleSpy.mockRestore();
    });

    it('fires setSessionBoardSerial when connect resolves with a parsed serial in a session', async () => {
      mockPersistentSessionState = { session: { id: 'session-1' } };

      renderHook(() => useBluetoothContext(), {
        wrapper: createWrapper(),
      });

      expect(lastUseBoardBluetoothOptions?.onConnectSuccess).toBeDefined();
      await act(async () => {
        lastUseBoardBluetoothOptions?.onConnectSuccess?.('KB-12345');
        await Promise.resolve();
      });

      expect(mockSetSessionBoardSerial).toHaveBeenCalledTimes(1);
      expect(mockSetSessionBoardSerial).toHaveBeenCalledWith('KB-12345');
    });

    it('does not call setSessionBoardSerial when no session exists (solo)', async () => {
      mockPersistentSessionState = { session: null };

      renderHook(() => useBluetoothContext(), {
        wrapper: createWrapper(),
      });

      await act(async () => {
        lastUseBoardBluetoothOptions?.onConnectSuccess?.('KB-12345');
        await Promise.resolve();
      });

      expect(mockSetSessionBoardSerial).not.toHaveBeenCalled();
    });

    it('does not call setSessionBoardSerial for a null serial (e.g. moonboard)', async () => {
      mockPersistentSessionState = { session: { id: 'session-1' } };

      renderHook(() => useBluetoothContext(), {
        wrapper: createWrapper(),
      });

      await act(async () => {
        lastUseBoardBluetoothOptions?.onConnectSuccess?.(null);
        await Promise.resolve();
      });

      expect(mockSetSessionBoardSerial).not.toHaveBeenCalled();
    });

    it('skips setSessionBoardSerial when the new serial matches the session value (Open Q5 defensive clear: no churn on idempotent reconnect)', async () => {
      mockPersistentSessionState = { session: { id: 'session-1', lastConnectedBoardSerial: 'KB-12345' } };

      renderHook(() => useBluetoothContext(), {
        wrapper: createWrapper(),
      });

      await act(async () => {
        lastUseBoardBluetoothOptions?.onConnectSuccess?.('KB-12345');
        await Promise.resolve();
      });

      expect(mockSetSessionBoardSerial).not.toHaveBeenCalled();
      expect(mockTrack.mock.calls.find((args) => args[0] === 'Session Board Serial Set')).toBeUndefined();
    });

    it('overwrites a stale serial when reconnect resolves a different board (Open Q5 defensive clear)', async () => {
      mockPersistentSessionState = { session: { id: 'session-1', lastConnectedBoardSerial: 'KB-OLD' } };

      renderHook(() => useBluetoothContext(), {
        wrapper: createWrapper(),
      });

      await act(async () => {
        lastUseBoardBluetoothOptions?.onConnectSuccess?.('KB-NEW');
        await Promise.resolve();
      });

      expect(mockSetSessionBoardSerial).toHaveBeenCalledWith('KB-NEW');
    });

    it('does not re-fire setSessionBoardSerial on a back-to-back reconnect to the same board (cache updated synchronously)', async () => {
      // Reproduces the race the in-memory ref guards against: session state
      // still holds the old serial because SessionBoardSerialChanged hasn't
      // landed yet, but the user disconnects + reconnects to the same board.
      // Without the synchronous ref update, the second onConnectSuccess would
      // see previousSerial=null and re-fire the mutation + analytics event.
      mockPersistentSessionState = { session: { id: 'session-1', lastConnectedBoardSerial: null } };

      renderHook(() => useBluetoothContext(), {
        wrapper: createWrapper(),
      });

      await act(async () => {
        lastUseBoardBluetoothOptions?.onConnectSuccess?.('KB-12345');
        await Promise.resolve();
      });
      // Second reconnect to the same board before the WS event lands.
      await act(async () => {
        lastUseBoardBluetoothOptions?.onConnectSuccess?.('KB-12345');
        await Promise.resolve();
      });

      expect(mockSetSessionBoardSerial).toHaveBeenCalledTimes(1);
      expect(mockTrack.mock.calls.filter((args) => args[0] === 'Session Board Serial Set')).toHaveLength(1);
    });

    it("fires Session Board Serial Set with previousSerialKnown=false on the session's first pairing", async () => {
      mockPersistentSessionState = { session: { id: 'session-1', lastConnectedBoardSerial: null } };

      renderHook(() => useBluetoothContext(), {
        wrapper: createWrapper(),
      });

      await act(async () => {
        lastUseBoardBluetoothOptions?.onConnectSuccess?.('KB-12345');
        await Promise.resolve();
      });

      const call = mockTrack.mock.calls.find((args) => args[0] === 'Session Board Serial Set');
      expect(call).toBeTruthy();
      expect(call?.[1]).toMatchObject({
        mode: 'party',
        previousSerialKnown: false,
      });
    });

    it('fires Session Board Serial Set with previousSerialKnown=true on a board swap', async () => {
      mockPersistentSessionState = { session: { id: 'session-1', lastConnectedBoardSerial: 'KB-OLD' } };

      renderHook(() => useBluetoothContext(), {
        wrapper: createWrapper(),
      });

      await act(async () => {
        lastUseBoardBluetoothOptions?.onConnectSuccess?.('KB-NEW');
        await Promise.resolve();
      });

      const call = mockTrack.mock.calls.find((args) => args[0] === 'Session Board Serial Set');
      expect(call).toBeTruthy();
      expect(call?.[1]).toMatchObject({
        mode: 'party',
        previousSerialKnown: true,
      });
    });

    it('routes confirmClimbOnWall through the live session when a session is joined mid-send', async () => {
      // The session-id mirror ref in BluetoothProvider lets the post-send
      // callback read the *live* sessionId rather than a snapshot captured
      // at render time. Start solo, kick off a long-running send, join a
      // session before the send resolves, and assert the confirm fires.
      mockPersistentSessionState = { session: null };
      let resolveSend: (value: boolean) => void = () => {};
      mockSendFramesToBoard.mockImplementationOnce(
        () =>
          new Promise<boolean>((resolve) => {
            resolveSend = resolve;
          }),
      );
      mockCurrentClimbQueueItem = {
        climb: { uuid: 'climb-1', frames: 'p1r12', mirrored: false },
      };
      mockBluetoothState.isConnected = true;

      const { rerender } = renderHook(() => useBluetoothContext(), {
        wrapper: createWrapper(),
      });

      await act(async () => {
        await vi.waitFor(() => {
          expect(mockSendFramesToBoard).toHaveBeenCalledTimes(1);
        });
      });

      // Join a session while the BLE write is in flight.
      mockPersistentSessionState = { session: { id: 'session-late' } };
      rerender();

      // Resolve the send — confirmClimbOnWall should fire against the joined session.
      await act(async () => {
        resolveSend(true);
        await Promise.resolve();
        await Promise.resolve();
      });

      await vi.waitFor(() => {
        expect(mockConfirmClimbOnWall).toHaveBeenCalledTimes(1);
      });
      expect(mockConfirmClimbOnWall).toHaveBeenCalledWith('climb-1');
    });
  });

  describe('wall disconnect on BLE drop', () => {
    it('reports wall disconnect to the session when the BLE link drops in a party', async () => {
      mockPersistentSessionState = { session: { id: 'session-1' } };

      renderHook(() => useBluetoothContext(), { wrapper: createWrapper() });

      expect(lastUseBoardBluetoothOptions?.onConnectionChange).toBeDefined();
      await act(async () => {
        lastUseBoardBluetoothOptions?.onConnectionChange?.(false);
        await Promise.resolve();
      });

      expect(mockReportWallDisconnect).toHaveBeenCalledTimes(1);
    });

    it('does not report wall disconnect on (re)connect', async () => {
      mockPersistentSessionState = { session: { id: 'session-1' } };

      renderHook(() => useBluetoothContext(), { wrapper: createWrapper() });

      await act(async () => {
        lastUseBoardBluetoothOptions?.onConnectionChange?.(true);
        await Promise.resolve();
      });

      expect(mockReportWallDisconnect).not.toHaveBeenCalled();
    });

    it('does not report wall disconnect when solo (no session)', async () => {
      mockPersistentSessionState = { session: null };

      renderHook(() => useBluetoothContext(), { wrapper: createWrapper() });

      await act(async () => {
        lastUseBoardBluetoothOptions?.onConnectionChange?.(false);
        await Promise.resolve();
      });

      expect(mockReportWallDisconnect).not.toHaveBeenCalled();
    });

    it('releases the board-presence holder on BLE drop when bound to a board (even solo)', async () => {
      // Independent of session membership: a dropped BLE link must free the
      // board-presence holder, or the lightbulb's holder OR keeps it lit.
      mockPersistentSessionState = { session: null };
      mockPresenceBoardId = 123;

      renderHook(() => useBluetoothContext(), { wrapper: createWrapper() });

      await act(async () => {
        lastUseBoardBluetoothOptions?.onConnectionChange?.(false);
        await Promise.resolve();
      });

      expect(mockReportBoardDisconnect).toHaveBeenCalledWith(123);
    });

    it('does not release the board-presence holder when no board is bound', async () => {
      mockPresenceBoardId = null;

      renderHook(() => useBluetoothContext(), { wrapper: createWrapper() });

      await act(async () => {
        lastUseBoardBluetoothOptions?.onConnectionChange?.(false);
        await Promise.resolve();
      });

      expect(mockReportBoardDisconnect).not.toHaveBeenCalled();
    });
  });

  describe('unmount mid-send', () => {
    it('does not fire confirmClimbOnWall or success analytics when provider unmounts mid-send', async () => {
      // The AutoSender abort-controller cleanup runs on unmount. The
      // in-flight write must NOT fire `confirmClimbOnWall` (party) or the
      // success analytic for a climb the user has navigated away from.
      mockPersistentSessionState = { session: { id: 'session-1' } };
      let resolveSend: (value: boolean) => void = () => {};
      mockSendFramesToBoard.mockImplementation(
        () =>
          new Promise<boolean>((resolve) => {
            resolveSend = resolve;
          }),
      );
      mockCurrentClimbQueueItem = {
        climb: { uuid: 'climb-1', frames: 'p1r12', mirrored: false },
      };
      mockBluetoothState.isConnected = true;

      const { unmount } = renderHook(() => useBluetoothContext(), {
        wrapper: createWrapper(),
      });

      // Wait for the drain loop to invoke sendFramesToBoard.
      await act(async () => {
        await vi.waitFor(() => {
          expect(mockSendFramesToBoard).toHaveBeenCalledTimes(1);
        });
      });

      // Unmount the provider mid-send (e.g. user navigated away).
      unmount();

      // Resolve the in-flight write as if the OS-level GATT write completed
      // after the JS abort. The drain loop must bail before firing the
      // post-send side effects.
      await act(async () => {
        resolveSend(true);
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(mockConfirmClimbOnWall).not.toHaveBeenCalled();
      expect(mockTrack.mock.calls.find((call) => call[0] === 'Climb Sent to Board Success')).toBeUndefined();
    });
  });
});
