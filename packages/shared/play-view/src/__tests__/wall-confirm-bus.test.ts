import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { emitWallConfirm, subscribeToWallConfirm, type WallConfirmOrigin } from '../wall-confirm-bus';
import { createWallConfirmFallbackController } from '../wall-confirm-fallback';

// The bus is module-wide, so every test drops what it subscribed.
const unsubscribers: Array<() => void> = [];
function listen(callback: (climbUuid: string, origin: WallConfirmOrigin) => void): void {
  unsubscribers.push(subscribeToWallConfirm(callback));
}

afterEach(() => {
  for (const unsubscribe of unsubscribers.splice(0)) unsubscribe();
});

describe('wall-confirm bus', () => {
  it('tells every listener where each confirm came from', () => {
    const first = vi.fn();
    const second = vi.fn();
    listen(first);
    listen(second);

    emitWallConfirm('climb-1', 'self');
    emitWallConfirm('climb-2', 'relay');

    for (const listener of [first, second]) {
      expect(listener.mock.calls).toEqual([
        ['climb-1', 'self'],
        ['climb-2', 'relay'],
      ]);
    }
  });

  // A listener that only reads the climb (the reconcile watcher, the
  // disconnect wait) still hears relays: filtering is each listener's own call.
  it('hands a relay to a listener that ignores the origin', () => {
    const climbs: string[] = [];
    listen((climbUuid) => climbs.push(climbUuid));

    emitWallConfirm('climb-1', 'relay');
    emitWallConfirm('climb-2', 'self');

    expect(climbs).toEqual(['climb-1', 'climb-2']);
  });

  it('stops telling a listener once it unsubscribes', () => {
    const listener = vi.fn();
    const unsubscribe = subscribeToWallConfirm(listener);
    unsubscribe();

    emitWallConfirm('climb-1', 'self');

    expect(listener).not.toHaveBeenCalled();
  });

  it('keeps telling the others when one listener throws', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const after = vi.fn();
    listen(() => {
      throw new Error('boom');
    });
    listen(after);

    emitWallConfirm('climb-1', 'relay');

    expect(after).toHaveBeenCalledWith('climb-1', 'relay');
    expect(error).toHaveBeenCalledOnce();
    error.mockRestore();
  });
});

// The fallback controller wired to the real bus: a crewmate's relayed confirm
// still clears the pulse, exactly as this phone's own does.
describe('wall-confirm bus → fallback controller', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it.each(['self', 'relay'] as const)('confirms the armed climb on a %s confirm', (origin) => {
    const onConfirmed = vi.fn();
    const bluetoothConnect = vi.fn().mockResolvedValue(true);
    const controller = createWallConfirmFallbackController(
      {
        isBluetoothConnected: () => origin === 'self',
        isBluetoothSupported: () => true,
        lastConnectedBoardSerial: () => null,
        isPersistentSessionActive: () => true,
        bluetoothConnect,
        isNativeApp: () => true,
        subscribeToWallConfirm,
      },
      { onConfirmed },
    );

    controller.armWatcher({ climbUuid: 'climb-1', mode: 'party', boardLayout: 'Original' });
    emitWallConfirm('climb-1', origin);
    vi.runAllTimers();

    expect(onConfirmed).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ climbUuid: 'climb-1', confirmedByRole: origin === 'self' ? 'self' : 'other' }),
    );
    expect(bluetoothConnect).not.toHaveBeenCalled();
  });
});
