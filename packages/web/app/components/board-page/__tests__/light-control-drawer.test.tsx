import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';

// Echo i18n keys so assertions can match on the key directly.
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en-US' } }),
}));

const mockShowMessage = vi.fn();
vi.mock('@/app/components/providers/snackbar-provider', () => ({
  useSnackbar: () => ({ showMessage: mockShowMessage }),
}));

// Keep the heavy drawer chrome out of the way — the failure-guard logic lives
// in the component's effects, not its rendered children.
vi.mock('@/app/components/swipeable-drawer/swipeable-drawer', () => ({
  default: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

vi.mock('@/app/lib/led-color-overrides-db', () => ({
  CUSTOMISABLE_LED_ROLES: ['HAND', 'FOOT', 'FINISH'],
}));

const mockSendFramesToBoard =
  vi.fn<(frames: string, mirrored?: boolean, signal?: unknown, ctx?: unknown) => Promise<boolean | undefined>>();
const mockSetPartyMode = vi.fn();
const mockClearBoard = vi.fn<() => Promise<boolean | undefined>>();
const mockDisconnect = vi.fn();
const mockReassertWall = vi.fn();

let mockBtContext: Record<string, unknown>;
vi.mock('../../board-bluetooth-control/bluetooth-context', () => ({
  useBluetoothContext: () => mockBtContext,
}));

// Mutable so disco tests can supply a climb with frames; null by default.
let mockCurrentClimbQueueItem: unknown = null;
vi.mock('../../graphql-queue', () => ({
  useCurrentClimb: () => ({ currentClimbQueueItem: mockCurrentClimbQueueItem }),
}));

import { LightControlDrawer } from '../light-control-drawer';
import type { BoardDetails } from '@/app/lib/types';

const boardDetails = {
  board_name: 'kilter',
  layout_id: 1,
  size_id: 1,
  set_ids: [1],
  holdsData: [],
  edge_left: 0,
  edge_right: 100,
  edge_top: 100,
  edge_bottom: 0,
} as unknown as BoardDetails;

const moonboardDetails = {
  board_name: 'moonboard',
  layout_id: 1,
  size_id: 1,
  set_ids: [1],
  holdsData: [],
  edge_left: 0,
  edge_right: 100,
  edge_top: 100,
  edge_bottom: 0,
} as unknown as BoardDetails;

// STARTING(42) + HAND(43) + FINISH(44) for kilter — the HAND segment is what
// the disco effect re-rolls, so a frames string needs at least one HAND hold
// or the effect bails before sending anything.
const discoClimbQueueItem = {
  climb: {
    uuid: 'climb-1',
    frames: 'p1000r42p1001r43p1002r44',
    mirrored: false,
    boardType: 'kilter',
    layoutId: 1,
  },
};

function baseContext(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    isConnected: true,
    sendFramesToBoard: mockSendFramesToBoard,
    clearBoard: mockClearBoard,
    disconnect: mockDisconnect,
    // boardDetails now comes in as a prop, not from the BLE context.
    partyMode: 'off',
    setPartyMode: mockSetPartyMode,
    ledColorOverrides: {},
    setLedColorOverrides: vi.fn(),
    moonboardLightAdjacentHolds: false,
    setMoonboardLightAdjacentHolds: vi.fn(),
    reassertWall: mockReassertWall,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockSendFramesToBoard.mockReset();
  mockSendFramesToBoard.mockResolvedValue(true);
  mockClearBoard.mockReset();
  mockClearBoard.mockResolvedValue(true);
  mockCurrentClimbQueueItem = null;
  mockBtContext = baseContext();
});

describe('LightControlDrawer light-show failure guard', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockBtContext = baseContext({ partyMode: 'glyphs' });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('stops the party show and warns after repeated failed writes', async () => {
    // Every write fails — a dead connection while the show is running.
    mockSendFramesToBoard.mockResolvedValue(false);

    render(<LightControlDrawer open onClose={() => {}} boardDetails={boardDetails} />);

    // Mount tick (failure 1) + one interval tick (failure 2) trips the guard.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1400);
    });

    expect(mockSetPartyMode).toHaveBeenCalledWith('off');
    expect(mockShowMessage).toHaveBeenCalledWith('lightControl.lightShowFailed', 'error');
  });

  it('keeps the show running while writes succeed', async () => {
    mockSendFramesToBoard.mockResolvedValue(true);

    render(<LightControlDrawer open onClose={() => {}} boardDetails={boardDetails} />);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1400);
    });

    expect(mockSetPartyMode).not.toHaveBeenCalled();
    expect(mockShowMessage).not.toHaveBeenCalledWith('lightControl.lightShowFailed', 'error');
    // It did keep sending frames each tick.
    expect(mockSendFramesToBoard.mock.calls.length).toBeGreaterThan(1);
  });
});

describe('LightControlDrawer party-loop lifecycle', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('sends a frame immediately when the glyph show activates', () => {
    mockBtContext = baseContext({ partyMode: 'glyphs' });
    mockSendFramesToBoard.mockResolvedValue(true);

    render(<LightControlDrawer open onClose={() => {}} boardDetails={boardDetails} />);

    // The mount-time `void sendCurrentLetter()` fires one write before any
    // interval tick — no timer advance needed.
    expect(mockSendFramesToBoard).toHaveBeenCalledTimes(1);
  });

  it('does not run the glyph show on a MoonBoard', async () => {
    mockBtContext = baseContext({ partyMode: 'glyphs' });

    render(<LightControlDrawer open onClose={() => {}} boardDetails={moonboardDetails} />);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1400);
    });

    expect(mockSendFramesToBoard).not.toHaveBeenCalled();
  });

  it('does not run the glyph show while disconnected', async () => {
    mockBtContext = baseContext({ partyMode: 'glyphs', isConnected: false });

    render(<LightControlDrawer open onClose={() => {}} boardDetails={boardDetails} />);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1400);
    });

    expect(mockSendFramesToBoard).not.toHaveBeenCalled();
  });

  it('clears the wall once when the show stops', async () => {
    mockBtContext = baseContext({ partyMode: 'glyphs' });
    mockSendFramesToBoard.mockResolvedValue(true);

    const { rerender } = render(<LightControlDrawer open onClose={() => {}} boardDetails={boardDetails} />);

    // Flip the show off — the one-shot clear effect should fire a single
    // clearBoard() as partyMode transitions glyphs → off.
    mockBtContext = baseContext({ partyMode: 'off' });
    await act(async () => {
      rerender(<LightControlDrawer open onClose={() => {}} boardDetails={boardDetails} />);
    });

    expect(mockClearBoard).toHaveBeenCalledTimes(1);
  });

  it('stops sending after unmount', async () => {
    mockBtContext = baseContext({ partyMode: 'glyphs' });
    mockSendFramesToBoard.mockResolvedValue(true);

    const { unmount } = render(<LightControlDrawer open onClose={() => {}} boardDetails={boardDetails} />);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1400);
    });
    const callsBeforeUnmount = mockSendFramesToBoard.mock.calls.length;

    unmount();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });

    expect(mockSendFramesToBoard.mock.calls.length).toBe(callsBeforeUnmount);
  });

  it('stops the disco show and warns after repeated failed writes', async () => {
    mockBtContext = baseContext({ partyMode: 'disco' });
    mockCurrentClimbQueueItem = discoClimbQueueItem;
    mockSendFramesToBoard.mockResolvedValue(false);

    render(<LightControlDrawer open onClose={() => {}} boardDetails={boardDetails} />);

    // Mount tick (failure 1) + one interval tick (failure 2) trips the guard.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });

    expect(mockSetPartyMode).toHaveBeenCalledWith('off');
    expect(mockShowMessage).toHaveBeenCalledWith('lightControl.lightShowFailed', 'error');
  });
});

describe('LightControlDrawer handleClearAll', () => {
  // Real timers: these assertions ride on the clearBoard() promise resolving,
  // not on an interval, so waitFor is the reliable drain.
  const clickTurnOffAll = () => fireEvent.click(screen.getByText('lightControl.turnOffAll'));

  it('does not warn when the clear succeeds', async () => {
    mockClearBoard.mockResolvedValue(true);
    render(<LightControlDrawer open onClose={() => {}} boardDetails={boardDetails} />);

    await act(async () => {
      clickTurnOffAll();
    });

    expect(mockClearBoard).toHaveBeenCalledTimes(1);
    expect(mockShowMessage).not.toHaveBeenCalledWith('lightControl.clearFailed', 'error');
  });

  it('warns when the clear returns false', async () => {
    mockClearBoard.mockResolvedValue(false);
    render(<LightControlDrawer open onClose={() => {}} boardDetails={boardDetails} />);

    clickTurnOffAll();

    await waitFor(() => expect(mockShowMessage).toHaveBeenCalledWith('lightControl.clearFailed', 'error'));
  });

  it('warns when the clear returns undefined (adapter momentarily gone)', async () => {
    // clearBoard() returns undefined when the adapter is null under a still-true
    // isConnected — the `!success` guard now surfaces that instead of === false
    // swallowing it.
    mockClearBoard.mockResolvedValue(undefined);
    render(<LightControlDrawer open onClose={() => {}} boardDetails={boardDetails} />);

    clickTurnOffAll();

    await waitFor(() => expect(mockShowMessage).toHaveBeenCalledWith('lightControl.clearFailed', 'error'));
  });

  it('warns and logs when the clear rejects mid-write', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockClearBoard.mockRejectedValue(new Error('GATT disconnected mid-write'));
    render(<LightControlDrawer open onClose={() => {}} boardDetails={boardDetails} />);

    clickTurnOffAll();

    await waitFor(() => expect(mockShowMessage).toHaveBeenCalledWith('lightControl.clearFailed', 'error'));
    expect(consoleSpy).toHaveBeenCalled();
    consoleSpy.mockRestore();
  });

  it('stops the light show instead of double-clearing while a show is running', async () => {
    mockBtContext = baseContext({ partyMode: 'glyphs' });
    render(<LightControlDrawer open onClose={() => {}} boardDetails={boardDetails} />);

    await act(async () => {
      clickTurnOffAll();
    });

    // The stop effect owns the clearBoard() when partyMode flips off — tapping
    // "turn off all" during a show must not issue its own clear.
    expect(mockSetPartyMode).toHaveBeenCalledWith('off');
    expect(mockClearBoard).not.toHaveBeenCalled();
  });
});

describe('LightControlDrawer MoonBoard light-adjacent-holds toggle', () => {
  it('shows the toggle only for a MoonBoard', () => {
    render(<LightControlDrawer open onClose={() => {}} boardDetails={boardDetails} />);
    expect(screen.queryByText('lightControl.lightAdjacentHolds')).toBeNull();
  });

  it('reflects the persisted preference and toggles it', () => {
    const setMoonboardLightAdjacentHolds = vi.fn();
    mockBtContext = baseContext({ setMoonboardLightAdjacentHolds });
    render(<LightControlDrawer open onClose={() => {}} boardDetails={moonboardDetails} />);

    const toggle = screen.getByLabelText('lightControl.lightAdjacentHolds') as HTMLInputElement;
    expect(toggle.checked).toBe(false);

    fireEvent.click(toggle);
    expect(setMoonboardLightAdjacentHolds).toHaveBeenCalledWith(true);
    expect(mockReassertWall).toHaveBeenCalledTimes(1);
  });

  it('starts checked when the preference is already enabled', () => {
    mockBtContext = baseContext({ moonboardLightAdjacentHolds: true });
    render(<LightControlDrawer open onClose={() => {}} boardDetails={moonboardDetails} />);

    const toggle = screen.getByLabelText('lightControl.lightAdjacentHolds') as HTMLInputElement;
    expect(toggle.checked).toBe(true);
  });
});
