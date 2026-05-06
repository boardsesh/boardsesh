import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { renderHook, act } from '@testing-library/react';
import React from 'react';
import { BluetoothProvider, useBluetoothContext } from '../bluetooth-context';
import type { BoardDetails } from '@/app/lib/types';
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

let mockBluetoothState = {
  isConnected: false,
  loading: false,
  connect: mockConnect,
  disconnect: mockDisconnect,
  sendFramesToBoard: mockSendFramesToBoard,
};
let mockPickerState: PickerStateMock = null;

vi.mock('../use-board-bluetooth', () => ({
  useBoardBluetooth: () => ({ ...mockBluetoothState, pickerState: mockPickerState }),
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
  waitForCapacitor: vi.fn().mockResolvedValue(false),
  CAPACITOR_BRIDGE_TIMEOUT_MS: 2000,
}));

let mockCurrentClimbQueueItem: {
  climb: { uuid: string; frames: string; mirrored: boolean };
} | null = null;

vi.mock('../../graphql-queue', () => ({
  useQueueContext: () => ({
    currentClimbQueueItem: mockCurrentClimbQueueItem,
  }),
  useQueueData: () => ({
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
    set_ids: '1,2',
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
    mockBluetoothState = {
      isConnected: false,
      loading: false,
      connect: mockConnect,
      disconnect: mockDisconnect,
      sendFramesToBoard: mockSendFramesToBoard,
    };
    mockPickerState = null;
    lastPickerProps = null;
    lastMismatchProps = null;
    mockAuth = { token: null, isAuthenticated: false };
    mockResolveSerialNumbers.mockResolvedValue(new Map());
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
          });
        });
      });
    });

    it('tracks failure analytics when send fails', async () => {
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
          });
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
          });
        });
      });

      expect(consoleSpy).toHaveBeenCalledWith('Error sending climb to board:', expect.any(Error));
      consoleSpy.mockRestore();
    });
  });

  describe('rapid-swiping cancellation', () => {
    it('passes AbortSignal to sendFramesToBoard and aborts on unmount', async () => {
      // Simulate a slow send that doesn't resolve
      let resolveFirstSend: (value: boolean) => void;
      mockSendFramesToBoard.mockImplementationOnce(
        () =>
          new Promise<boolean>((resolve) => {
            resolveFirstSend = resolve;
          }),
      );
      mockCurrentClimbQueueItem = {
        climb: { uuid: 'climb-1', frames: 'p1r12', mirrored: false },
      };
      mockBluetoothState.isConnected = true;

      const { unmount } = renderHook(() => useBluetoothContext(), {
        wrapper: createWrapper(),
      });

      // Wait for the first send to start
      await act(async () => {
        await vi.waitFor(() => {
          expect(mockSendFramesToBoard).toHaveBeenCalledTimes(1);
        });
      });

      // Verify an AbortSignal was passed as the third argument
      const signal = mockSendFramesToBoard.mock.calls[0][2] as AbortSignal;
      expect(signal).toBeInstanceOf(AbortSignal);
      expect(signal.aborted).toBe(false);

      // Unmount triggers effect cleanup which aborts the controller
      unmount();
      expect(signal.aborted).toBe(true);

      // Resolve the send — since signal is aborted, analytics should not be tracked
      resolveFirstSend!(true);
      // Give microtasks a chance to flush
      await act(async () => {
        await new Promise((r) => setTimeout(r, 10));
      });
      expect(mockTrack).not.toHaveBeenCalled();
    });

    it('does not track analytics when send throws after abort', async () => {
      // When signal is already aborted, the send throws AbortError
      // The catch block should check signal.aborted and skip analytics
      mockSendFramesToBoard.mockImplementation((_frames: string, _mirrored: boolean, signal?: AbortSignal) => {
        if (signal?.aborted) {
          return Promise.reject(new DOMException('Write aborted', 'AbortError'));
        }
        return Promise.resolve(true);
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
          expect(mockSendFramesToBoard).toHaveBeenCalledTimes(1);
        });
      });

      // The signal was NOT aborted, so analytics should track success
      await act(async () => {
        await vi.waitFor(() => {
          expect(mockTrack).toHaveBeenCalledWith('Climb Sent to Board Success', {
            climbUuid: 'climb-1',
            boardLayout: 'Original',
          });
        });
      });
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
});
