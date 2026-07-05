// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';

// A stateful fake for the BLE controller so we can assert the provider's
// connect/disconnect reconciliation and drive an unsolicited-drop callback,
// without pulling in react-native-ble-plx. `vi.hoisted` so the mock factory
// (hoisted above top-level consts) can see it.
const controllerMock = vi.hoisted(() => {
  const state = { connected: false, disconnectCb: undefined as undefined | (() => void) };
  return {
    state,
    connectByName: vi.fn(async (name: string) => {
      state.connected = true;
      return { deviceId: 'timer-1', deviceName: name };
    }),
    disconnect: vi.fn(async () => {
      state.connected = false;
    }),
    pressButton: vi.fn(async (_code: number) => {}),
    onDisconnect: vi.fn((cb: () => void) => {
      state.disconnectCb = cb;
      return () => {
        state.disconnectCb = undefined;
      };
    }),
    isConnected: vi.fn(() => state.connected),
  };
});

vi.mock('../../lib/ble/rogue-timer-ble', () => ({
  RogueTimerController: class {
    connectByName = controllerMock.connectByName;
    disconnect = controllerMock.disconnect;
    pressButton = controllerMock.pressButton;
    onDisconnect = controllerMock.onDisconnect;
    isConnected = controllerMock.isConnected;
  },
}));

// The active board + board-LED-connection state the provider reconciles against.
const scenario = vi.hoisted(() => ({ timerName: null as string | null, boardConnected: false }));
vi.mock('../../lib/graphql/use-active-board', () => ({
  useActiveBoard: () => ({ data: scenario.timerName ? { timerName: scenario.timerName } : null }),
}));
vi.mock('../bluetooth-provider', () => ({
  useOptionalBluetoothContext: () => ({ isConnected: scenario.boardConnected }),
}));

import { RogueTimerProvider, useRogueTimer } from '../rogue-timer-provider';

const wrapper = ({ children }: { children: ReactNode }) => <RogueTimerProvider>{children}</RogueTimerProvider>;

describe('RogueTimerProvider', () => {
  beforeEach(() => {
    controllerMock.state.connected = false;
    controllerMock.state.disconnectCb = undefined;
    controllerMock.connectByName.mockClear();
    controllerMock.disconnect.mockClear();
    controllerMock.pressButton.mockClear();
    controllerMock.onDisconnect.mockClear();
    scenario.timerName = null;
    scenario.boardConnected = false;
  });

  it('does not connect while the board LED is disconnected (only the wall driver owns the timer)', async () => {
    scenario.timerName = 'Rogue Home Timer';
    scenario.boardConnected = false;
    const { result } = renderHook(() => useRogueTimer(), { wrapper });

    expect(controllerMock.connectByName).not.toHaveBeenCalled();
    expect(result.current.status).toBe('idle');

    // A tick while not driving the wall must not reach the timer.
    await act(async () => {
      await result.current.startStopwatch();
    });
    expect(controllerMock.pressButton).not.toHaveBeenCalled();
  });

  it('connects when the board LED is held and a timer is paired', async () => {
    scenario.timerName = 'Rogue Home Timer';
    scenario.boardConnected = true;
    const { result } = renderHook(() => useRogueTimer(), { wrapper });

    await waitFor(() => expect(result.current.status).toBe('connected'));
    expect(controllerMock.connectByName).toHaveBeenCalledWith('Rogue Home Timer');
    expect(result.current.isConnected).toBe(true);
  });

  it('startStopwatch fires STOPWATCH → RESET → OK when connected', async () => {
    scenario.timerName = 'Rogue Home Timer';
    scenario.boardConnected = true;
    const { result } = renderHook(() => useRogueTimer(), { wrapper });
    await waitFor(() => expect(result.current.isConnected).toBe(true));

    await act(async () => {
      await result.current.startStopwatch();
    });
    // STOPWATCH (0x04), RESET (0x0A), OK (0x0C).
    expect(controllerMock.pressButton.mock.calls.map((call) => call[0])).toEqual([0x04, 0x0a, 0x0c]);
  });

  it('disconnects the timer when the board LED drops', async () => {
    scenario.timerName = 'Rogue Home Timer';
    scenario.boardConnected = true;
    const { result, rerender } = renderHook(() => useRogueTimer(), { wrapper });
    await waitFor(() => expect(result.current.isConnected).toBe(true));

    scenario.boardConnected = false;
    rerender();
    await waitFor(() => expect(controllerMock.disconnect).toHaveBeenCalled());
    expect(result.current.status).toBe('idle');
  });

  it('reacts to an unsolicited timer drop instead of showing a stale "connected" badge', async () => {
    scenario.timerName = 'Rogue Home Timer';
    scenario.boardConnected = true;
    const { result } = renderHook(() => useRogueTimer(), { wrapper });
    await waitFor(() => expect(result.current.isConnected).toBe(true));
    expect(controllerMock.connectByName).toHaveBeenCalledTimes(1);

    // Simulate the peripheral dropping: the controller clears its refs and
    // invokes the disconnect callback the provider registered.
    await act(async () => {
      controllerMock.state.connected = false;
      controllerMock.state.disconnectCb?.();
    });

    // The provider clears status (no stale badge) and re-attempts a reconnect
    // while the board LED is still held.
    await waitFor(() => expect(controllerMock.connectByName).toHaveBeenCalledTimes(2));
  });

  it('recovers from a failed connect: error → LED off resets to idle → LED on reconnects', async () => {
    // First connect attempt fails.
    controllerMock.connectByName.mockRejectedValueOnce(new Error('timer powered off'));
    scenario.timerName = 'Rogue Home Timer';
    scenario.boardConnected = true;
    const { result, rerender } = renderHook(() => useRogueTimer(), { wrapper });

    await waitFor(() => expect(result.current.status).toBe('error'));

    // Turning off the board LED must clear the lingering error, not leave the
    // badge stuck on 'error'.
    scenario.boardConnected = false;
    rerender();
    await waitFor(() => expect(result.current.status).toBe('idle'));

    // Driving the wall again reconnects (the mock now resolves).
    scenario.boardConnected = true;
    rerender();
    await waitFor(() => expect(result.current.isConnected).toBe(true));
  });

  it('gives up after repeated flaps instead of reconnecting forever', async () => {
    scenario.timerName = 'Rogue Home Timer';
    scenario.boardConnected = true;
    const { result } = renderHook(() => useRogueTimer(), { wrapper });
    await waitFor(() => expect(result.current.isConnected).toBe(true));

    // MAX_RECONNECT_ATTEMPTS is 4: the first 4 drops each trigger a reconnect,
    // and each reconnect re-registers the disconnect callback.
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      await act(async () => {
        controllerMock.state.connected = false;
        controllerMock.state.disconnectCb?.();
      });
      // initial connect (1) + `attempt` reconnects.
      await waitFor(() => expect(controllerMock.connectByName).toHaveBeenCalledTimes(attempt + 1));
    }

    expect(controllerMock.connectByName).toHaveBeenCalledTimes(5);

    // The 5th drop exceeds the cap: give up (status 'error'), no more reconnects.
    await act(async () => {
      controllerMock.state.connected = false;
      controllerMock.state.disconnectCb?.();
    });
    await waitFor(() => expect(result.current.status).toBe('error'));
    expect(controllerMock.connectByName).toHaveBeenCalledTimes(5);
  });
});
