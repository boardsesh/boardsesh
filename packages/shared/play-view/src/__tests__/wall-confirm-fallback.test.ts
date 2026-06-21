import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createWallConfirmFallbackController,
  WALL_CONFIRM_TIMEOUT_MS,
  type WallConfirmControllerCallbacks,
  type WallConfirmControllerDeps,
} from '../wall-confirm-fallback';

const baseClimb = {
  climbUuid: 'climb-1',
  mode: 'solo' as const,
  boardLayout: 'Original',
};

type LocalWallConfirmBus = {
  emit: (climbUuid: string) => void;
  subscribe: (callback: (climbUuid: string) => void) => () => void;
  listenerCount: () => number;
};

function createLocalWallConfirmBus(): LocalWallConfirmBus {
  const listeners = new Set<(climbUuid: string) => void>();

  return {
    emit: (climbUuid) => {
      for (const listener of listeners) {
        listener(climbUuid);
      }
    },
    subscribe: (callback) => {
      listeners.add(callback);
      return () => {
        listeners.delete(callback);
      };
    },
    listenerCount: () => listeners.size,
  };
}

function createDeps(
  wallConfirmBus: LocalWallConfirmBus,
  overrides: Partial<WallConfirmControllerDeps> = {},
): WallConfirmControllerDeps {
  return {
    isBluetoothConnected: () => false,
    isBluetoothSupported: () => true,
    lastConnectedBoardSerial: () => null,
    isPersistentSessionActive: () => false,
    bluetoothConnect: vi.fn().mockResolvedValue(true),
    isNativeApp: () => false,
    subscribeToWallConfirm: wallConfirmBus.subscribe,
    ...overrides,
  };
}

function createCallbacks(): Required<WallConfirmControllerCallbacks> {
  return {
    onConfirmed: vi.fn(),
    onTimeout: vi.fn(),
    onTrackConfirmed: vi.fn(),
    onTrackTimeout: vi.fn(),
  };
}

describe('createWallConfirmFallbackController', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('confirms the armed climb and cancels the fallback timer', () => {
    const wallConfirmBus = createLocalWallConfirmBus();
    const callbacks = createCallbacks();
    const deps = createDeps(wallConfirmBus);
    const controller = createWallConfirmFallbackController(deps, callbacks);

    controller.armWatcher(baseClimb);
    vi.advanceTimersByTime(500);
    wallConfirmBus.emit('climb-1');
    vi.advanceTimersByTime(WALL_CONFIRM_TIMEOUT_MS + 100);

    expect(deps.bluetoothConnect).not.toHaveBeenCalled();
    expect(callbacks.onConfirmed).toHaveBeenCalledOnce();
    expect(callbacks.onConfirmed).toHaveBeenCalledWith({
      climbUuid: 'climb-1',
      latencyMs: 500,
      confirmedByRole: 'other',
    });
    expect(callbacks.onTrackConfirmed).toHaveBeenCalledWith({
      climbUuid: 'climb-1',
      latencyMs: 500,
      confirmedByRole: 'other',
      mode: 'solo',
      boardLayout: 'Original',
    });
    expect(callbacks.onTimeout).not.toHaveBeenCalled();
    expect(wallConfirmBus.listenerCount()).toBe(0);
  });

  it('marks the confirmation as self when this client is Bluetooth-connected', () => {
    const wallConfirmBus = createLocalWallConfirmBus();
    const callbacks = createCallbacks();
    const deps = createDeps(wallConfirmBus, { isBluetoothConnected: () => true });
    const controller = createWallConfirmFallbackController(deps, callbacks);

    controller.armWatcher(baseClimb);
    vi.advanceTimersByTime(300);
    wallConfirmBus.emit('climb-1');

    expect(callbacks.onTrackConfirmed).toHaveBeenCalledWith(
      expect.objectContaining({ confirmedByRole: 'self', latencyMs: 300 }),
    );
  });

  it('ignores confirmations for other climbs and opens the picker on timeout', () => {
    const wallConfirmBus = createLocalWallConfirmBus();
    const callbacks = createCallbacks();
    const deps = createDeps(wallConfirmBus);
    const controller = createWallConfirmFallbackController(deps, callbacks);

    controller.armWatcher(baseClimb);
    wallConfirmBus.emit('different-climb');
    vi.advanceTimersByTime(WALL_CONFIRM_TIMEOUT_MS);

    expect(callbacks.onConfirmed).not.toHaveBeenCalled();
    expect(callbacks.onTimeout).toHaveBeenCalledWith({ climbUuid: 'climb-1' });
    expect(callbacks.onTrackTimeout).toHaveBeenCalledWith({
      mode: 'solo',
      fallback: 'picker',
      boardLayout: 'Original',
    });
    expect(deps.bluetoothConnect).toHaveBeenCalledOnce();
    expect(deps.bluetoothConnect).toHaveBeenCalledWith();
  });

  it('auto-connects to the stored serial on native clients', () => {
    const wallConfirmBus = createLocalWallConfirmBus();
    const callbacks = createCallbacks();
    const deps = createDeps(wallConfirmBus, {
      lastConnectedBoardSerial: () => 'serial-42',
      isNativeApp: () => true,
    });
    const controller = createWallConfirmFallbackController(deps, callbacks);

    controller.armWatcher({ ...baseClimb, mode: 'party' });
    vi.advanceTimersByTime(WALL_CONFIRM_TIMEOUT_MS);

    expect(deps.bluetoothConnect).toHaveBeenCalledOnce();
    expect(deps.bluetoothConnect).toHaveBeenCalledWith(undefined, undefined, 'serial-42');
    expect(callbacks.onTrackTimeout).toHaveBeenCalledWith({
      mode: 'party',
      fallback: 'auto_connect',
      boardLayout: 'Original',
    });
  });

  it('does not connect again when Bluetooth is already connected', () => {
    const wallConfirmBus = createLocalWallConfirmBus();
    const callbacks = createCallbacks();
    const deps = createDeps(wallConfirmBus, { isBluetoothConnected: () => true });
    const controller = createWallConfirmFallbackController(deps, callbacks);

    controller.armWatcher(baseClimb);
    vi.advanceTimersByTime(WALL_CONFIRM_TIMEOUT_MS);

    expect(deps.bluetoothConnect).not.toHaveBeenCalled();
    expect(callbacks.onTrackTimeout).toHaveBeenCalledWith({
      mode: 'solo',
      fallback: 'already_connected',
      boardLayout: 'Original',
    });
  });

  it('skips connect when Bluetooth is unsupported', () => {
    const wallConfirmBus = createLocalWallConfirmBus();
    const callbacks = createCallbacks();
    const deps = createDeps(wallConfirmBus, { isBluetoothSupported: () => false });
    const controller = createWallConfirmFallbackController(deps, callbacks);

    controller.armWatcher(baseClimb);
    vi.advanceTimersByTime(WALL_CONFIRM_TIMEOUT_MS);

    expect(deps.bluetoothConnect).not.toHaveBeenCalled();
    expect(callbacks.onTrackTimeout).toHaveBeenCalledWith({
      mode: 'solo',
      fallback: 'unsupported',
      boardLayout: 'Original',
    });
  });

  it('cancels the prior watcher when a new climb is armed', () => {
    const wallConfirmBus = createLocalWallConfirmBus();
    const callbacks = createCallbacks();
    const deps = createDeps(wallConfirmBus);
    const controller = createWallConfirmFallbackController(deps, callbacks);

    controller.armWatcher(baseClimb);
    vi.advanceTimersByTime(WALL_CONFIRM_TIMEOUT_MS / 2);
    controller.armWatcher({ ...baseClimb, climbUuid: 'climb-2' });
    vi.advanceTimersByTime(WALL_CONFIRM_TIMEOUT_MS / 2 + 1);

    expect(deps.bluetoothConnect).not.toHaveBeenCalled();

    vi.advanceTimersByTime(WALL_CONFIRM_TIMEOUT_MS / 2);

    expect(deps.bluetoothConnect).toHaveBeenCalledOnce();
    expect(callbacks.onTimeout).toHaveBeenCalledWith({ climbUuid: 'climb-2' });
    expect(wallConfirmBus.listenerCount()).toBe(0);
  });

  it('cancels silently when requested or when the persistent session ends', () => {
    const wallConfirmBus = createLocalWallConfirmBus();
    const callbacks = createCallbacks();
    const sessionActive = { current: true };
    const deps = createDeps(wallConfirmBus, {
      isPersistentSessionActive: () => sessionActive.current,
    });
    const controller = createWallConfirmFallbackController(deps, callbacks);

    controller.armWatcher({ ...baseClimb, mode: 'party' });
    sessionActive.current = false;
    controller.handleSessionActiveChange();
    vi.advanceTimersByTime(WALL_CONFIRM_TIMEOUT_MS + 100);

    expect(deps.bluetoothConnect).not.toHaveBeenCalled();
    expect(callbacks.onConfirmed).not.toHaveBeenCalled();
    expect(callbacks.onTimeout).not.toHaveBeenCalled();
    expect(callbacks.onTrackTimeout).not.toHaveBeenCalled();
    expect(wallConfirmBus.listenerCount()).toBe(0);

    controller.armWatcher(baseClimb);
    controller.cancelWatcher();
    vi.advanceTimersByTime(WALL_CONFIRM_TIMEOUT_MS + 100);

    expect(deps.bluetoothConnect).not.toHaveBeenCalled();
    expect(callbacks.onTrackTimeout).not.toHaveBeenCalled();
    expect(wallConfirmBus.listenerCount()).toBe(0);
  });

  it('pulseOnly: never connects on timeout even when disconnected and supported', () => {
    // The production lightbulb path: the caller already initiated a connect, so
    // a second bluetoothConnect here would start a duplicate native scan
    // ("Already scanning. Stopping now." on iOS). pulseOnly suppresses it while
    // still recording the timeout.
    const wallConfirmBus = createLocalWallConfirmBus();
    const callbacks = createCallbacks();
    const deps = createDeps(wallConfirmBus, {
      // The exact state that previously triggered the harmful picker re-connect.
      isBluetoothConnected: () => false,
      isBluetoothSupported: () => true,
      lastConnectedBoardSerial: () => 'serial-42',
      isNativeApp: () => true,
    });
    const controller = createWallConfirmFallbackController(deps, callbacks);

    controller.armWatcher({ ...baseClimb, mode: 'party', pulseOnly: true });
    vi.advanceTimersByTime(WALL_CONFIRM_TIMEOUT_MS);

    expect(deps.bluetoothConnect).not.toHaveBeenCalled();
    expect(callbacks.onTimeout).toHaveBeenCalledWith({ climbUuid: 'climb-1' });
    expect(callbacks.onTrackTimeout).toHaveBeenCalledWith({
      mode: 'party',
      fallback: 'pulse_only',
      boardLayout: 'Original',
    });
  });

  it('pulseOnly: still confirms the climb and clears the pulse when WallConfirmedClimb arrives', () => {
    const wallConfirmBus = createLocalWallConfirmBus();
    const callbacks = createCallbacks();
    const deps = createDeps(wallConfirmBus);
    const controller = createWallConfirmFallbackController(deps, callbacks);

    controller.armWatcher({ ...baseClimb, pulseOnly: true });
    vi.advanceTimersByTime(400);
    wallConfirmBus.emit('climb-1');
    vi.advanceTimersByTime(WALL_CONFIRM_TIMEOUT_MS);

    expect(callbacks.onConfirmed).toHaveBeenCalledWith({
      climbUuid: 'climb-1',
      latencyMs: 400,
      confirmedByRole: 'other',
    });
    expect(callbacks.onTimeout).not.toHaveBeenCalled();
    expect(deps.bluetoothConnect).not.toHaveBeenCalled();
    expect(wallConfirmBus.listenerCount()).toBe(0);
  });

  it('reads current dependency values when the timeout fires', () => {
    const wallConfirmBus = createLocalWallConfirmBus();
    const callbacks = createCallbacks();
    const bluetoothConnected = { current: false };
    const deps = createDeps(wallConfirmBus, {
      isBluetoothConnected: () => bluetoothConnected.current,
    });
    const controller = createWallConfirmFallbackController(deps, callbacks);

    controller.armWatcher(baseClimb);
    bluetoothConnected.current = true;
    vi.advanceTimersByTime(WALL_CONFIRM_TIMEOUT_MS);

    expect(deps.bluetoothConnect).not.toHaveBeenCalled();
    expect(callbacks.onTrackTimeout).toHaveBeenCalledWith({
      mode: 'solo',
      fallback: 'already_connected',
      boardLayout: 'Original',
    });
  });

  it('pulseOnly: classifies a connected backstop as a genuine board-ack timeout, not pulse_only', () => {
    // Connected when the backstop fires means the connect handshake wasn't the
    // problem — we were on the board but no confirm converged. That's the
    // genuine board-ack signal, even though pulseOnly still suppresses connect.
    const wallConfirmBus = createLocalWallConfirmBus();
    const callbacks = createCallbacks();
    const deps = createDeps(wallConfirmBus, { isBluetoothConnected: () => true });
    const controller = createWallConfirmFallbackController(deps, callbacks);

    controller.armWatcher({ ...baseClimb, pulseOnly: true });
    vi.advanceTimersByTime(WALL_CONFIRM_TIMEOUT_MS);

    expect(deps.bluetoothConnect).not.toHaveBeenCalled();
    expect(callbacks.onTrackTimeout).toHaveBeenCalledWith({
      mode: 'solo',
      fallback: 'already_connected',
      boardLayout: 'Original',
    });
  });

  it('respects a custom timeoutMs backstop', () => {
    const wallConfirmBus = createLocalWallConfirmBus();
    const callbacks = createCallbacks();
    const deps = createDeps(wallConfirmBus);
    const controller = createWallConfirmFallbackController(deps, callbacks);

    controller.armWatcher({ ...baseClimb, timeoutMs: 5000 });
    // Past the default window — the backstop must NOT have fired yet.
    vi.advanceTimersByTime(WALL_CONFIRM_TIMEOUT_MS + 500);
    expect(callbacks.onTimeout).not.toHaveBeenCalled();
    expect(callbacks.onTrackTimeout).not.toHaveBeenCalled();
    expect(deps.bluetoothConnect).not.toHaveBeenCalled();

    // Reach the custom backstop — now it fires.
    vi.advanceTimersByTime(5000 - (WALL_CONFIRM_TIMEOUT_MS + 500));
    expect(callbacks.onTimeout).toHaveBeenCalledWith({ climbUuid: 'climb-1' });
    expect(callbacks.onTrackTimeout).toHaveBeenCalledOnce();
  });

  it('records a confirm that lands after the default window but within a widened backstop (no clipping)', () => {
    const wallConfirmBus = createLocalWallConfirmBus();
    const callbacks = createCallbacks();
    const deps = createDeps(wallConfirmBus);
    const controller = createWallConfirmFallbackController(deps, callbacks);

    controller.armWatcher({ ...baseClimb, timeoutMs: 5000 });
    vi.advanceTimersByTime(2500); // past the old 2s clip ceiling
    wallConfirmBus.emit('climb-1');

    expect(callbacks.onConfirmed).toHaveBeenCalledWith({
      climbUuid: 'climb-1',
      latencyMs: 2500,
      confirmedByRole: 'other',
    });
    expect(callbacks.onTimeout).not.toHaveBeenCalled();
    expect(callbacks.onTrackTimeout).not.toHaveBeenCalled();
  });
});
