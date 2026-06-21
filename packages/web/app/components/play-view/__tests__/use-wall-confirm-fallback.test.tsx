// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';
import { renderHook, act } from '@testing-library/react';
import { useWallConfirmFallback, WALL_CONFIRM_TIMEOUT_MS } from '../use-wall-confirm-fallback';
import { emitWallConfirm } from '@boardsesh/play-view';

const mockTrack = vi.fn();
vi.mock('@/app/lib/analytics', () => ({
  track: (...args: unknown[]) => mockTrack(...args),
}));

// Default to the picker branch unless a test explicitly opts into the
// native-shell behaviour by overriding the `isNativeAppOverride` Dep.
vi.mock('@/app/lib/ble/capacitor-utils', () => ({
  // Production calls `isNativeApp()` directly; tests prefer the
  // `isNativeAppOverride` Dep so the override seam stays exercised.
  isNativeApp: () => false,
}));

type Deps = Parameters<typeof useWallConfirmFallback>[0];
type Callbacks = NonNullable<Parameters<typeof useWallConfirmFallback>[1]>;

const baseClimb = {
  climbUuid: 'climb-1',
  mode: 'solo' as const,
  boardLayout: 'Original',
};

function makeDeps(overrides: Partial<Deps> = {}): Deps {
  return {
    isBluetoothConnected: false,
    isBluetoothSupported: true,
    lastConnectedBoardSerial: null,
    isPersistentSessionActive: false,
    bluetoothConnect: vi.fn().mockResolvedValue(true),
    isNativeAppOverride: () => false,
    ...overrides,
  };
}

describe('useWallConfirmFallback', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockTrack.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('clears the timer when a matching wall-confirm arrives within the window', () => {
    const deps = makeDeps();
    const onConfirmed = vi.fn();
    const { result } = renderHook(() => useWallConfirmFallback(deps, { onConfirmed } satisfies Callbacks));

    act(() => {
      result.current.armWatcher(baseClimb);
    });

    // Advance partway then fire the matching confirm.
    act(() => {
      vi.advanceTimersByTime(500);
    });
    act(() => {
      emitWallConfirm('climb-1');
    });

    // Advance past the timeout and verify the fallback did NOT run.
    act(() => {
      vi.advanceTimersByTime(WALL_CONFIRM_TIMEOUT_MS + 100);
    });

    expect(deps.bluetoothConnect).not.toHaveBeenCalled();
    expect(mockTrack).toHaveBeenCalledOnce();
    expect(mockTrack).toHaveBeenCalledWith('Wall Confirmed', {
      climbUuid: 'climb-1',
      latencyMs: 500,
      confirmedByRole: 'other',
      mode: 'solo',
      boardLayout: 'Original',
    });
    expect(onConfirmed).toHaveBeenCalledOnce();
    expect(onConfirmed).toHaveBeenCalledWith({
      climbUuid: 'climb-1',
      latencyMs: 500,
      confirmedByRole: 'other',
    });
  });

  it('marks confirmedByRole as "self" when the local phone is BLE-connected', () => {
    const deps = makeDeps({ isBluetoothConnected: true });
    const { result } = renderHook(() => useWallConfirmFallback(deps));

    act(() => {
      result.current.armWatcher(baseClimb);
    });
    act(() => {
      vi.advanceTimersByTime(300);
    });
    act(() => {
      emitWallConfirm('climb-1');
    });

    expect(mockTrack).toHaveBeenCalledWith('Wall Confirmed', {
      climbUuid: 'climb-1',
      latencyMs: 300,
      confirmedByRole: 'self',
      mode: 'solo',
      boardLayout: 'Original',
    });
  });

  it('ignores wall-confirms for a different climb', () => {
    const deps = makeDeps();
    const { result } = renderHook(() => useWallConfirmFallback(deps));

    act(() => {
      result.current.armWatcher(baseClimb);
    });

    // Confirm fires for a different climb — should NOT dismiss our watcher.
    act(() => {
      emitWallConfirm('different-climb');
    });

    act(() => {
      vi.advanceTimersByTime(WALL_CONFIRM_TIMEOUT_MS + 100);
    });

    // The fallback should have run — by default no BLE connection, no stored
    // serial, BLE supported → picker fallback.
    expect(deps.bluetoothConnect).toHaveBeenCalledOnce();
    expect(deps.bluetoothConnect).toHaveBeenCalledWith();
    expect(mockTrack).toHaveBeenCalledWith('Wall Confirm Connecting', {
      mode: 'solo',
      fallback: 'picker',
      boardLayout: 'Original',
    });
  });

  it('opens the picker when timeout fires with no stored serial', () => {
    const deps = makeDeps({ lastConnectedBoardSerial: null });
    const { result } = renderHook(() => useWallConfirmFallback(deps));

    act(() => {
      result.current.armWatcher({ ...baseClimb, mode: 'party' });
    });

    act(() => {
      vi.advanceTimersByTime(WALL_CONFIRM_TIMEOUT_MS);
    });

    // Picker path: connect called with NO targetSerial arg.
    expect(deps.bluetoothConnect).toHaveBeenCalledOnce();
    expect(deps.bluetoothConnect).toHaveBeenCalledWith();
    expect(mockTrack).toHaveBeenCalledWith('Wall Confirm Connecting', {
      mode: 'party',
      fallback: 'picker',
      boardLayout: 'Original',
    });
  });

  it('auto-connects to stored serial when on native shell', () => {
    // Exercises the `isNativeAppOverride` seam: tests drive the auto-connect
    // branch deterministically without monkey-patching `isNativeApp`.
    const deps = makeDeps({
      lastConnectedBoardSerial: 'serial-42',
      isNativeAppOverride: () => true,
    });
    const { result } = renderHook(() => useWallConfirmFallback(deps));

    act(() => {
      result.current.armWatcher({ ...baseClimb, mode: 'party' });
    });

    act(() => {
      vi.advanceTimersByTime(WALL_CONFIRM_TIMEOUT_MS);
    });

    expect(deps.bluetoothConnect).toHaveBeenCalledOnce();
    expect(deps.bluetoothConnect).toHaveBeenCalledWith(undefined, undefined, 'serial-42');
    expect(mockTrack).toHaveBeenCalledWith('Wall Confirm Connecting', {
      mode: 'party',
      fallback: 'auto_connect',
      boardLayout: 'Original',
    });
  });

  it('falls back to picker when stored serial exists but not on native shell', () => {
    // Exercises the other side of the override seam — non-native shell with
    // a stored serial still picks rather than silently auto-connecting.
    const deps = makeDeps({
      lastConnectedBoardSerial: 'serial-42',
      isNativeAppOverride: () => false,
    });
    const { result } = renderHook(() => useWallConfirmFallback(deps));

    act(() => {
      result.current.armWatcher(baseClimb);
    });

    act(() => {
      vi.advanceTimersByTime(WALL_CONFIRM_TIMEOUT_MS);
    });

    expect(deps.bluetoothConnect).toHaveBeenCalledOnce();
    expect(deps.bluetoothConnect).toHaveBeenCalledWith();
    expect(mockTrack).toHaveBeenCalledWith('Wall Confirm Connecting', expect.objectContaining({ fallback: 'picker' }));
  });

  it('does nothing when already BLE-connected (already_connected path)', () => {
    const deps = makeDeps({ isBluetoothConnected: true });
    const { result } = renderHook(() => useWallConfirmFallback(deps));

    act(() => {
      result.current.armWatcher(baseClimb);
    });

    act(() => {
      vi.advanceTimersByTime(WALL_CONFIRM_TIMEOUT_MS);
    });

    expect(deps.bluetoothConnect).not.toHaveBeenCalled();
    expect(mockTrack).toHaveBeenCalledWith('Wall Confirm Timeout', {
      mode: 'solo',
      fallback: 'already_connected',
      boardLayout: 'Original',
    });
  });

  it('reports unsupported and skips connect when BLE is unavailable', () => {
    const deps = makeDeps({ isBluetoothSupported: false });
    const { result } = renderHook(() => useWallConfirmFallback(deps));

    act(() => {
      result.current.armWatcher(baseClimb);
    });

    act(() => {
      vi.advanceTimersByTime(WALL_CONFIRM_TIMEOUT_MS);
    });

    expect(deps.bluetoothConnect).not.toHaveBeenCalled();
    expect(mockTrack).toHaveBeenCalledWith(
      'Wall Confirm Connecting',
      expect.objectContaining({ fallback: 'unsupported' }),
    );
  });

  it('cancels the prior watcher when armWatcher is called again before timeout', () => {
    const deps = makeDeps();
    const { result } = renderHook(() => useWallConfirmFallback(deps));

    act(() => {
      result.current.armWatcher(baseClimb);
    });

    // Re-arm with a different climb halfway through the window.
    act(() => {
      vi.advanceTimersByTime(WALL_CONFIRM_TIMEOUT_MS / 2);
    });
    act(() => {
      result.current.armWatcher({ ...baseClimb, climbUuid: 'climb-2' });
    });

    // Original would have fired now — should be cancelled.
    act(() => {
      vi.advanceTimersByTime(WALL_CONFIRM_TIMEOUT_MS / 2 + 1);
    });
    expect(deps.bluetoothConnect).not.toHaveBeenCalled();

    // Second watcher's full window now elapses.
    act(() => {
      vi.advanceTimersByTime(WALL_CONFIRM_TIMEOUT_MS / 2);
    });
    expect(deps.bluetoothConnect).toHaveBeenCalledOnce();
    // No frames/mirrored passed — the AutoSender handles the initial write
    // once `isConnected` flips. See the GATT-race fix in the hook.
    expect(deps.bluetoothConnect).toHaveBeenCalledWith();
  });

  it('cleans up the watcher on unmount', () => {
    const deps = makeDeps();
    const { result, unmount } = renderHook(() => useWallConfirmFallback(deps));

    act(() => {
      result.current.armWatcher(baseClimb);
    });

    unmount();

    act(() => {
      vi.advanceTimersByTime(WALL_CONFIRM_TIMEOUT_MS + 100);
    });

    expect(deps.bluetoothConnect).not.toHaveBeenCalled();
    expect(mockTrack).not.toHaveBeenCalled();
  });

  // -- P0-3 race regression coverage --

  it('does not tear down a re-armed watcher if a stale timeout fires', () => {
    // Models the P0-3 race: timer-A is scheduled with capturedTimeoutId=A.
    // The user re-arms before A elapses, which calls cancelWatcher() and
    // installs watcher-B (timeoutId=B). If the JS task that runs A's
    // setTimeout callback was already queued and not cancellable (or if a
    // future scheduler ran it anyway), A's runFallback() must not tear down
    // B's watcher.
    const deps = makeDeps();
    const { result } = renderHook(() => useWallConfirmFallback(deps));

    act(() => {
      result.current.armWatcher(baseClimb);
    });

    // Reach inside to grab watcher A's timeoutId, then force-cancel without
    // clearing it (simulates a queued-but-not-yet-fired stale timer that
    // beat the cancel).
    act(() => {
      // Re-arm: cancels A's timer (and unsubscribes A's subscriber) and
      // installs B.
      result.current.armWatcher({ ...baseClimb, climbUuid: 'climb-2' });
    });

    // Manually emit a confirm for climb-2 — this should match watcher B.
    act(() => {
      vi.advanceTimersByTime(100);
    });
    act(() => {
      emitWallConfirm('climb-2');
    });

    // Past the window: neither A's timeout nor B's should run a picker
    // fallback (B was confirmed; A is stale).
    act(() => {
      vi.advanceTimersByTime(WALL_CONFIRM_TIMEOUT_MS + 100);
    });

    expect(deps.bluetoothConnect).not.toHaveBeenCalled();
    expect(mockTrack).toHaveBeenCalledTimes(1);
    expect(mockTrack).toHaveBeenCalledWith(
      'Wall Confirmed',
      expect.objectContaining({ climbUuid: 'climb-2', mode: 'solo' }),
    );
  });

  it('is a no-op when a WallConfirmedClimb arrives after the timeout already ran', () => {
    const deps = makeDeps();
    const { result } = renderHook(() => useWallConfirmFallback(deps));

    act(() => {
      result.current.armWatcher(baseClimb);
    });

    // Timeout fires — fallback runs.
    act(() => {
      vi.advanceTimersByTime(WALL_CONFIRM_TIMEOUT_MS);
    });
    expect(deps.bluetoothConnect).toHaveBeenCalledOnce();
    expect(mockTrack).toHaveBeenCalledOnce();
    expect(mockTrack).toHaveBeenCalledWith('Wall Confirm Connecting', expect.objectContaining({ fallback: 'picker' }));

    // A late confirm for the same climb arrives — must not double-fire or
    // tear anything down (the watcher is already gone).
    act(() => {
      emitWallConfirm('climb-1');
    });

    expect(deps.bluetoothConnect).toHaveBeenCalledOnce();
    expect(mockTrack).toHaveBeenCalledOnce();
  });

  it('coalesces repeated emits for the same climbUuid (two-phones racing)', () => {
    // Two BLE-paired members both wrote the same climb and both broadcast
    // WallConfirmedClimb. After the first cancel, subsequent emits for the
    // same uuid must be no-ops.
    const deps = makeDeps();
    const { result } = renderHook(() => useWallConfirmFallback(deps));

    act(() => {
      result.current.armWatcher(baseClimb);
    });
    act(() => {
      vi.advanceTimersByTime(200);
    });

    // First confirm fires the success path.
    act(() => {
      emitWallConfirm('climb-1');
    });

    // Repeated emits — no fresh events, no fallback, no crash.
    act(() => {
      emitWallConfirm('climb-1');
      emitWallConfirm('climb-1');
    });

    expect(mockTrack).toHaveBeenCalledTimes(1);
    expect(mockTrack).toHaveBeenCalledWith('Wall Confirmed', expect.objectContaining({ climbUuid: 'climb-1' }));
    expect(deps.bluetoothConnect).not.toHaveBeenCalled();
  });

  it('cancels the watcher silently when the persistent session ends mid-window', () => {
    // Session-swap during pending: user leaves the party (or the WS dies and
    // we deactivate the session) before the 2s elapses. The picker should
    // not pop up after the user already moved on.
    const deps = makeDeps({ isPersistentSessionActive: true });
    const { result, rerender } = renderHook((d: Deps) => useWallConfirmFallback(d), { initialProps: deps });

    act(() => {
      result.current.armWatcher({ ...baseClimb, mode: 'party' });
    });

    // Flip the session off mid-window.
    const stoppedDeps = makeDeps({ isPersistentSessionActive: false });
    rerender(stoppedDeps);

    act(() => {
      vi.advanceTimersByTime(WALL_CONFIRM_TIMEOUT_MS + 100);
    });

    expect(stoppedDeps.bluetoothConnect).not.toHaveBeenCalled();
    expect(deps.bluetoothConnect).not.toHaveBeenCalled();
    expect(mockTrack).not.toHaveBeenCalled();
  });

  it('reads the latest deps when they change mid-window', () => {
    // Deps update mid-window: the watcher was armed when BLE was
    // disconnected, then mid-window the BLE auto-connect succeeds. The
    // fallback should read the live `isBluetoothConnected=true` and report
    // `already_connected` instead of the committed-at-arm `false`.
    const initialDeps = makeDeps({ isBluetoothConnected: false });
    const { result, rerender } = renderHook((d: Deps) => useWallConfirmFallback(d), {
      initialProps: initialDeps,
    });

    act(() => {
      result.current.armWatcher(baseClimb);
    });

    // BLE connects mid-window.
    const connectedDeps = makeDeps({ isBluetoothConnected: true });
    rerender(connectedDeps);

    act(() => {
      vi.advanceTimersByTime(WALL_CONFIRM_TIMEOUT_MS);
    });

    expect(initialDeps.bluetoothConnect).not.toHaveBeenCalled();
    expect(connectedDeps.bluetoothConnect).not.toHaveBeenCalled();
    expect(mockTrack).toHaveBeenCalledWith(
      'Wall Confirm Timeout',
      expect.objectContaining({ fallback: 'already_connected' }),
    );
  });

  it('records a still-connecting backstop as "Wall Confirm Connecting", not a board-ack timeout', () => {
    // The production lightbulb arm: pulseOnly + still disconnected when the
    // backstop fires. This is "we were still bringing the link up", not a board
    // failure — it must NOT inflate the genuine `Wall Confirm Timeout` metric.
    const deps = makeDeps({ isBluetoothConnected: false });
    const { result } = renderHook(() => useWallConfirmFallback(deps));

    act(() => {
      result.current.armWatcher({ ...baseClimb, pulseOnly: true });
    });
    act(() => {
      vi.advanceTimersByTime(WALL_CONFIRM_TIMEOUT_MS);
    });

    expect(deps.bluetoothConnect).not.toHaveBeenCalled();
    expect(mockTrack).toHaveBeenCalledWith('Wall Confirm Connecting', {
      mode: 'solo',
      fallback: 'pulse_only',
      boardLayout: 'Original',
    });
    expect(mockTrack).not.toHaveBeenCalledWith('Wall Confirm Timeout', expect.anything());
  });

  it('records a confirm past the old 2s ceiling as Wall Confirmed (no clipping) with a widened backstop', () => {
    const deps = makeDeps();
    const { result } = renderHook(() => useWallConfirmFallback(deps));

    act(() => {
      result.current.armWatcher({ ...baseClimb, pulseOnly: true, timeoutMs: 8000 });
    });
    act(() => {
      vi.advanceTimersByTime(2500); // would have been clipped under the old 2s verdict
    });
    act(() => {
      emitWallConfirm('climb-1');
    });

    expect(mockTrack).toHaveBeenCalledWith(
      'Wall Confirmed',
      expect.objectContaining({ climbUuid: 'climb-1', latencyMs: 2500 }),
    );
    expect(mockTrack).not.toHaveBeenCalledWith('Wall Confirm Connecting', expect.anything());
    expect(mockTrack).not.toHaveBeenCalledWith('Wall Confirm Timeout', expect.anything());
  });
});
