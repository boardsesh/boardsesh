// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
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

// The active board, the board-LED link (the driver rule's gym-timer gate), the
// rest timer's pacing and the clock the provider reconciles against.
const scenario = vi.hoisted(() => ({
  timerName: null as string | null,
  boardConnected: false,
  targetSeconds: 60 as number | null,
  mode: 'afterTick' as 'afterTick' | 'onTheMinute',
  nowMs: Date.parse('2026-10-24T10:00:00.000Z'),
}));
vi.mock('../../lib/graphql/use-active-board', () => ({
  useActiveBoard: () => ({ data: scenario.timerName ? { timerName: scenario.timerName } : null }),
}));
vi.mock('../../hooks/use-session-timer-driver', () => ({
  useSessionTimerDriver: () => ({ canDriveGymTimer: scenario.boardConnected }),
}));
vi.mock('../../hooks/use-effective-rest-pacing', () => ({
  useEffectiveRestPacing: () => ({ targetSeconds: scenario.targetSeconds, mode: scenario.mode }),
}));
vi.mock('../queue-provider', () => ({ useQueueSessionId: () => ({ sessionId: null }) }));
vi.mock('../../lib/clock', () => ({ nowMs: () => scenario.nowMs }));

import { RogueTimerCommand } from '@boardsesh/ble-protocol/rogue-timer';
import { RogueTimerProvider } from '../rogue-timer-provider';
import { useRogueTimer } from '../rogue-timer-context';
import {
  armRestTimer,
  disarmRestTimer,
  getRestTimerState,
  noteRestTimerAutoAdvanceFired,
  noteRestTimerTick,
  resetRestTimerStoreForTests,
} from '../../lib/rest-timer-store';
import { noteSessionTimerTick } from '../../lib/session-timer/tick-events';

const wrapper = ({ children }: { children: ReactNode }) => <RogueTimerProvider>{children}</RogueTimerProvider>;

const T0 = scenario.nowMs;
const RESTART = [RogueTimerCommand.STOPWATCH, RogueTimerCommand.RESET, RogueTimerCommand.OK];
const nowIso = () => new Date(scenario.nowMs).toISOString();

/** A climb saved on this phone, in the tick saver's order: the session timer hears first, then the rest timer. */
function logClimb(climbedAt = nowIso()) {
  noteSessionTimerTick(climbedAt, scenario.nowMs);
  noteRestTimerTick(climbedAt, 'afterTick', scenario.nowMs);
}

function pressed(): number[] {
  return controllerMock.pressButton.mock.calls.map((call) => call[0]);
}

/** Move the provider's clock and its timers together. */
async function advance(ms: number) {
  scenario.nowMs += ms;
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

/** Mount with a paired timer and the board LED held, wait for the link, then take over the timers. */
async function renderConnected() {
  scenario.timerName = 'Rogue Echo Gym Timer';
  scenario.boardConnected = true;
  const rendered = renderHook(() => useRogueTimer(), { wrapper });
  await waitFor(() => expect(rendered.result.current.status).toBe('connected'));
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  return rendered;
}

function deferred<T>() {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function resetScenario() {
  controllerMock.state.connected = false;
  controllerMock.state.disconnectCb = undefined;
  controllerMock.connectByName.mockClear();
  controllerMock.disconnect.mockClear();
  controllerMock.pressButton.mockClear();
  controllerMock.onDisconnect.mockClear();
  scenario.timerName = null;
  scenario.boardConnected = false;
  scenario.targetSeconds = 60;
  scenario.mode = 'afterTick';
  scenario.nowMs = T0;
  resetRestTimerStoreForTests();
}

beforeEach(resetScenario);
afterEach(() => {
  vi.useRealTimers();
});

describe('RogueTimerProvider', () => {
  it('does not connect while the board LED is disconnected (only the wall driver owns the timer)', async () => {
    scenario.timerName = 'Rogue Home Timer';
    scenario.boardConnected = false;
    const { result } = renderHook(() => useRogueTimer(), { wrapper });

    expect(controllerMock.connectByName).not.toHaveBeenCalled();
    expect(result.current.status).toBe('idle');

    // A tick while not driving the wall must not reach the timer.
    act(() => {
      noteSessionTimerTick(nowIso(), scenario.nowMs);
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

describe('RogueTimerProvider runs one connect at a time', () => {
  /** connectByName calls that are still scanning or connecting, and the most at once. */
  function trackConnects() {
    const pending: Array<{ name: string; resolve: () => void; reject: () => void }> = [];
    let inFlight = 0;
    let mostAtOnce = 0;
    controllerMock.connectByName.mockImplementation(
      (name: string) =>
        new Promise((resolve, reject) => {
          inFlight += 1;
          mostAtOnce = Math.max(mostAtOnce, inFlight);
          pending.push({
            name,
            resolve: () => {
              inFlight -= 1;
              controllerMock.state.connected = true;
              resolve({ deviceId: 'timer-1', deviceName: name });
            },
            reject: () => {
              inFlight -= 1;
              reject(new Error(`No Rogue timer matching "${name}"`));
            },
          });
        }),
    );
    return { pending, mostAtOnce: () => mostAtOnce };
  }

  afterEach(() => {
    controllerMock.connectByName.mockImplementation(async (name: string) => {
      controllerMock.state.connected = true;
      return { deviceId: 'timer-1', deviceName: name };
    });
  });

  it('waits for the connect in flight when the paired timer changes, then connects the new one', async () => {
    const connects = trackConnects();
    scenario.timerName = 'Rogue Echo Old';
    scenario.boardConnected = true;
    const { result, rerender } = renderHook(() => useRogueTimer(), { wrapper });
    await waitFor(() => expect(result.current.status).toBe('connecting'));

    // A new timer is saved while the old one is still being looked for.
    scenario.timerName = 'Rogue Echo New';
    rerender();
    expect(controllerMock.connectByName).toHaveBeenCalledTimes(1);
    expect(result.current.status).toBe('connecting');

    // The old one never turns up. Only then does the new one get a scan.
    await act(async () => {
      connects.pending[0].reject();
    });
    await waitFor(() => expect(controllerMock.connectByName).toHaveBeenCalledTimes(2));
    expect(controllerMock.connectByName).toHaveBeenLastCalledWith('Rogue Echo New');

    await act(async () => {
      connects.pending[1].resolve();
    });
    await waitFor(() => expect(result.current.status).toBe('connected'));
    expect(connects.mostAtOnce()).toBe(1);
  });

  it('drops the old link when it lands after the switch, before connecting the new timer', async () => {
    const connects = trackConnects();
    scenario.timerName = 'Rogue Echo Old';
    scenario.boardConnected = true;
    const { result, rerender } = renderHook(() => useRogueTimer(), { wrapper });
    await waitFor(() => expect(result.current.status).toBe('connecting'));

    scenario.timerName = 'Rogue Echo New';
    rerender();
    await act(async () => {
      connects.pending[0].resolve();
    });
    await waitFor(() => expect(controllerMock.connectByName).toHaveBeenCalledTimes(2));
    // The cancelled old link went first, so it cannot tear down the new one.
    expect(controllerMock.disconnect.mock.invocationCallOrder[0]).toBeLessThan(
      controllerMock.connectByName.mock.invocationCallOrder[1],
    );

    await act(async () => {
      connects.pending[1].resolve();
    });
    await waitFor(() => expect(result.current.status).toBe('connected'));
    expect(connects.mostAtOnce()).toBe(1);
  });

  it('connects again when the climber switches back to the timer still being looked for', async () => {
    const connects = trackConnects();
    scenario.timerName = 'Rogue Echo Old';
    scenario.boardConnected = true;
    const { result, rerender } = renderHook(() => useRogueTimer(), { wrapper });
    await waitFor(() => expect(result.current.status).toBe('connecting'));

    scenario.timerName = 'Rogue Echo New';
    rerender();
    scenario.timerName = 'Rogue Echo Old';
    rerender();
    await act(async () => {
      connects.pending[0].resolve();
    });
    // The first attempt was cancelled on the switch, so it can't count as the link.
    await waitFor(() => expect(controllerMock.connectByName).toHaveBeenCalledTimes(2));
    expect(controllerMock.connectByName).toHaveBeenLastCalledWith('Rogue Echo Old');

    await act(async () => {
      connects.pending[1].resolve();
    });
    await waitFor(() => expect(result.current.status).toBe('connected'));
    expect(connects.mostAtOnce()).toBe(1);
  });
});

describe('RogueTimerProvider driven by the session timer', () => {
  it('restarts the stopwatch when a tick starts a rest: STOPWATCH, RESET, OK with gaps', async () => {
    await renderConnected();
    act(() => {
      armRestTimer('afterTick', scenario.nowMs, null);
      logClimb();
    });
    expect(pressed()).toEqual([RogueTimerCommand.STOPWATCH]);
    await advance(180);
    expect(pressed()).toEqual([RogueTimerCommand.STOPWATCH, RogueTimerCommand.RESET]);
    await advance(180);
    expect(pressed()).toEqual(RESTART);
  });

  it('never restarts the clock on connect, whatever the rest timer is doing', async () => {
    armRestTimer('afterTick', scenario.nowMs, null);
    noteRestTimerTick(nowIso(), 'afterTick', scenario.nowMs);
    await renderConnected();
    await advance(1000);
    expect(pressed()).toEqual([]);
  });

  it('restarts on an auto-advance', async () => {
    armRestTimer('afterTick', scenario.nowMs, null);
    noteRestTimerTick(nowIso(), 'afterTick', scenario.nowMs);
    await renderConnected();
    await advance(60_000);
    act(() => {
      noteRestTimerAutoAdvanceFired(getRestTimerState().cycleId, 'afterTick', scenario.nowMs, scenario.nowMs);
    });
    await advance(400);
    expect(pressed()).toEqual(RESTART);
  });

  it('a tick and an auto-advance 100 ms apart press one clean STOPWATCH, RESET, OK, never a second OK', async () => {
    await renderConnected();
    act(() => {
      armRestTimer('afterTick', scenario.nowMs, null);
      logClimb();
    });
    await advance(100);
    act(() => {
      noteRestTimerAutoAdvanceFired(getRestTimerState().cycleId, 'afterTick', scenario.nowMs, scenario.nowMs);
    });
    await advance(2000);
    expect(pressed()).toEqual(RESTART);
  });

  it("gaps a reset queued behind a restart from the restart's OK", async () => {
    await renderConnected();
    act(() => {
      armRestTimer('afterTick', scenario.nowMs, null);
      logClimb();
    });
    expect(pressed()).toEqual([RogueTimerCommand.STOPWATCH]);
    // Switched off 100 ms into the restart: the reset waits its turn.
    await advance(100);
    act(() => {
      disarmRestTimer();
    });
    await advance(80);
    expect(pressed()).toEqual([RogueTimerCommand.STOPWATCH, RogueTimerCommand.RESET]);
    await advance(180);
    expect(pressed()).toEqual(RESTART);
    // No RESET straight after OK: the HM-10 drops back-to-back frames.
    await advance(179);
    expect(pressed()).toEqual(RESTART);
    await advance(1);
    expect(pressed()).toEqual([...RESTART, RogueTimerCommand.RESET]);
  });

  it('gaps a restart queued behind a reset from the RESET', async () => {
    armRestTimer('afterTick', scenario.nowMs, null);
    await renderConnected();
    act(() => {
      disarmRestTimer();
    });
    // Let the RESET go out at this instant.
    await act(async () => {});
    expect(pressed()).toEqual([RogueTimerCommand.RESET]);
    await advance(10);
    // The rest timer is off, so a fresh tick restarts the clock, 180 ms after the RESET.
    act(() => {
      noteSessionTimerTick(nowIso(), scenario.nowMs);
    });
    expect(pressed()).toEqual([RogueTimerCommand.RESET]);
    await advance(169);
    expect(pressed()).toEqual([RogueTimerCommand.RESET]);
    await advance(1);
    expect(pressed()).toEqual([RogueTimerCommand.RESET, RogueTimerCommand.STOPWATCH]);
  });

  it('a double tick within 0.3 s still ends with the clock counting', async () => {
    await renderConnected();
    act(() => {
      armRestTimer('afterTick', scenario.nowMs, null);
      logClimb();
    });
    await advance(250);
    act(() => {
      logClimb();
    });
    await advance(2000);
    expect(pressed()).toEqual(RESTART);
  });

  it('two restarts far enough apart each get their own sequence', async () => {
    await renderConnected();
    act(() => {
      armRestTimer('afterTick', scenario.nowMs, null);
      logClimb();
    });
    await advance(5000);
    act(() => {
      logClimb();
    });
    await advance(1000);
    expect(pressed()).toEqual([...RESTART, ...RESTART]);
  });

  it('restarts when a fixed window is armed, then on each beat with no store write between them', async () => {
    scenario.mode = 'onTheMinute';
    await renderConnected();
    act(() => {
      armRestTimer('onTheMinute', scenario.nowMs, null);
    });
    await advance(59_000);
    expect(pressed()).toEqual(RESTART);
    // The wake lands just after the beat; React renders it as the act ends, and
    // the next presses follow 180 ms apart.
    await advance(1_500);
    await advance(400);
    expect(pressed()).toEqual([...RESTART, ...RESTART]);
    await advance(60_000);
    await advance(400);
    expect(pressed()).toEqual([...RESTART, ...RESTART, ...RESTART]);
  });

  it('resets the clock when the rest timer is switched off', async () => {
    armRestTimer('afterTick', scenario.nowMs, null);
    await renderConnected();
    act(() => {
      disarmRestTimer();
    });
    await advance(10);
    expect(pressed()).toEqual([RogueTimerCommand.RESET]);
  });

  it('with the rest timer off, a fresh tick restarts the clock and a backdated one does not', async () => {
    await renderConnected();
    act(() => {
      noteSessionTimerTick(new Date(scenario.nowMs - 120_000).toISOString(), scenario.nowMs);
    });
    await advance(1000);
    expect(pressed()).toEqual([]);

    act(() => {
      noteSessionTimerTick(nowIso(), scenario.nowMs);
    });
    await advance(1000);
    expect(pressed()).toEqual(RESTART);
  });

  it('with the rest timer on, the tick bus leaves the restart to the snapshot (one sequence, not two)', async () => {
    await renderConnected();
    act(() => {
      armRestTimer('afterTick', scenario.nowMs, null);
    });
    // The tick saver's order: the session timer hears first, then the rest timer.
    act(() => {
      const climbedAt = nowIso();
      noteSessionTimerTick(climbedAt, scenario.nowMs);
      noteRestTimerTick(climbedAt, 'afterTick', scenario.nowMs);
    });
    await advance(2000);
    expect(pressed()).toEqual(RESTART);
  });

  it('a tick landing before React renders the arm reads the store, so the clock restarts once', async () => {
    await renderConnected();
    const climbedAt = nowIso();
    act(() => {
      armRestTimer('afterTick', scenario.nowMs, null);
      // The sink's last snapshot is still the one from before the arm: off.
      noteSessionTimerTick(climbedAt, scenario.nowMs);
    });
    await advance(1000);
    expect(pressed()).toEqual([]);
    // The rest timer hears of the tick a second later, past the window in which
    // a restart in flight would fold a second one into itself.
    act(() => {
      noteRestTimerTick(climbedAt, 'afterTick', scenario.nowMs);
    });
    await advance(1000);
    expect(pressed()).toEqual(RESTART);
  });

  it('a press that throws (the link going) does not stop the next command', async () => {
    await renderConnected();
    controllerMock.pressButton.mockRejectedValueOnce(new Error('Not connected to a Rogue timer'));
    act(() => {
      noteSessionTimerTick(nowIso(), scenario.nowMs);
    });
    await advance(1000);
    act(() => {
      noteSessionTimerTick(nowIso(), scenario.nowMs);
    });
    await advance(1000);
    expect(pressed()).toEqual([RogueTimerCommand.STOPWATCH, ...RESTART]);
  });

  it('stops driving the clock once the board LED drops', async () => {
    const { rerender } = await renderConnected();
    scenario.boardConnected = false;
    rerender();
    await advance(10);
    act(() => {
      armRestTimer('afterTick', scenario.nowMs, null);
      noteRestTimerTick(nowIso(), 'afterTick', scenario.nowMs);
      noteSessionTimerTick(nowIso(), scenario.nowMs);
    });
    await advance(2000);
    expect(pressed()).toEqual([]);
  });
});

describe('RogueTimerProvider and ticks read back from the session', () => {
  it('a climb read back when the rest timer is switched on leaves the running clock alone', async () => {
    await renderConnected();
    // Rest timer off: the saved climb restarts the clock from the tick bus.
    const climbedAt = nowIso();
    act(() => {
      logClimb(climbedAt);
    });
    await advance(30_000);
    expect(pressed()).toEqual(RESTART);
    // 30 s on the climber switches the rest timer on, and the session sync reads that climb back.
    act(() => {
      armRestTimer('afterTick', scenario.nowMs, null);
    });
    act(() => {
      noteRestTimerTick(climbedAt, 'afterTick', scenario.nowMs);
    });
    await advance(2000);
    expect(pressed()).toEqual(RESTART);
  });

  it('a climb saved after switching the rest timer on restarts the clock once', async () => {
    await renderConnected();
    act(() => {
      armRestTimer('afterTick', scenario.nowMs, null);
    });
    await advance(30_000);
    act(() => {
      logClimb();
    });
    await advance(2000);
    expect(pressed()).toEqual(RESTART);
  });

  it('a tick restored on a cold start leaves the clock alone, even seconds old', async () => {
    armRestTimer('afterTick', scenario.nowMs, null);
    await renderConnected();
    act(() => {
      noteRestTimerTick(new Date(scenario.nowMs - 3000).toISOString(), 'afterTick', scenario.nowMs);
    });
    await advance(2000);
    expect(pressed()).toEqual([]);
  });
});

describe('RogueTimerProvider pairing scans share the one scan slot', () => {
  it('starts at once when nothing else is scanning', () => {
    const { result } = renderHook(() => useRogueTimer(), { wrapper });
    const startScan = vi.fn(() => vi.fn());
    act(() => {
      result.current.schedulePairingScan(startScan);
    });
    expect(startScan).toHaveBeenCalledTimes(1);
  });

  it('waits for a reconnect in flight, which stops every scan when it settles', async () => {
    const pendingConnect = deferred<{ deviceId: string; deviceName: string }>();
    controllerMock.connectByName.mockImplementationOnce(() => pendingConnect.promise);
    scenario.timerName = 'Rogue Echo Gym Timer';
    scenario.boardConnected = true;
    const { result } = renderHook(() => useRogueTimer(), { wrapper });
    await waitFor(() => expect(result.current.status).toBe('connecting'));

    const startScan = vi.fn(() => vi.fn());
    act(() => {
      result.current.schedulePairingScan(startScan);
    });
    expect(startScan).not.toHaveBeenCalled();

    await act(async () => {
      pendingConnect.resolve({ deviceId: 'timer-1', deviceName: 'Rogue Echo Gym Timer' });
    });
    await waitFor(() => expect(startScan).toHaveBeenCalledTimes(1));
    expect(result.current.status).toBe('connected');
  });

  it('never starts a scan the climber already closed', async () => {
    const pendingConnect = deferred<{ deviceId: string; deviceName: string }>();
    controllerMock.connectByName.mockImplementationOnce(() => pendingConnect.promise);
    scenario.timerName = 'Rogue Echo Gym Timer';
    scenario.boardConnected = true;
    const { result } = renderHook(() => useRogueTimer(), { wrapper });
    await waitFor(() => expect(result.current.status).toBe('connecting'));

    const startScan = vi.fn(() => vi.fn());
    act(() => {
      const stop = result.current.schedulePairingScan(startScan);
      stop();
    });
    await act(async () => {
      pendingConnect.resolve({ deviceId: 'timer-1', deviceName: 'Rogue Echo Gym Timer' });
    });
    await waitFor(() => expect(result.current.status).toBe('connected'));
    expect(startScan).not.toHaveBeenCalled();
  });

  it('holds a reconnect back while a pairing scan runs, then reconnects when it stops', async () => {
    scenario.timerName = 'Rogue Echo Gym Timer';
    scenario.boardConnected = true;
    const { result } = renderHook(() => useRogueTimer(), { wrapper });
    await waitFor(() => expect(result.current.status).toBe('connected'));

    const stopScan = vi.fn();
    let stopPairing: () => void = () => {};
    act(() => {
      stopPairing = result.current.schedulePairingScan(() => stopScan);
    });

    // The timer drops while the climber is pairing: no reconnect scan yet.
    await act(async () => {
      controllerMock.state.connected = false;
      controllerMock.state.disconnectCb?.();
    });
    expect(controllerMock.connectByName).toHaveBeenCalledTimes(1);

    act(() => {
      stopPairing();
    });
    expect(stopScan).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(controllerMock.connectByName).toHaveBeenCalledTimes(2));
  });

  it('hands the slot back when the pairing scan stops by itself', async () => {
    scenario.timerName = 'Rogue Echo Gym Timer';
    scenario.boardConnected = true;
    const { result } = renderHook(() => useRogueTimer(), { wrapper });
    await waitFor(() => expect(result.current.status).toBe('connected'));

    let releaseSlot: () => void = () => {};
    act(() => {
      result.current.schedulePairingScan((release) => {
        releaseSlot = release;
        return vi.fn();
      });
    });
    await act(async () => {
      controllerMock.state.connected = false;
      controllerMock.state.disconnectCb?.();
    });
    expect(controllerMock.connectByName).toHaveBeenCalledTimes(1);

    act(() => {
      releaseSlot();
    });
    await waitFor(() => expect(controllerMock.connectByName).toHaveBeenCalledTimes(2));
  });

  it('keeps a live connection, and its drop listener, through a pairing sheet opening and closing', async () => {
    scenario.timerName = 'Rogue Echo Gym Timer';
    scenario.boardConnected = true;
    const { result } = renderHook(() => useRogueTimer(), { wrapper });
    await waitFor(() => expect(result.current.status).toBe('connected'));

    act(() => {
      result.current.schedulePairingScan(() => vi.fn())();
    });
    expect(controllerMock.connectByName).toHaveBeenCalledTimes(1);
    expect(result.current.status).toBe('connected');

    await act(async () => {
      controllerMock.state.connected = false;
      controllerMock.state.disconnectCb?.();
    });
    await waitFor(() => expect(controllerMock.connectByName).toHaveBeenCalledTimes(2));
  });
});
