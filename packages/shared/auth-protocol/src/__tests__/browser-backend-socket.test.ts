import { describe, expect, it, vi } from 'vitest';
import { browserBackendLeaseWebSocket } from '../browser-backend-socket';

function closeEvent(code: number, reason = 'owned close', wasClean = false): CloseEvent {
  return Object.assign(new Event('close'), { code, reason, wasClean }) as CloseEvent;
}
// EventTarget models native event-listener ordering and immediate propagation
// stopping. The onclose property registers after the wrapper's constructor.
class OwnedSocket extends EventTarget {
  readonly sent: unknown[] = [];
  readonly closes: { code: number | undefined; reason: string | undefined }[] = [];
  send(contents: unknown): void {
    this.sent.push(contents);
  }
  close(code?: number, reason?: string): void {
    this.closes.push({ code, reason });
  }
  set onclose(handler: ((event: CloseEvent) => void) | null) {
    if (handler) this.addEventListener('close', (event) => handler(event as CloseEvent));
  }
}
function fixture() {
  let current = true;
  let sendable = true;
  const timers = new Set<() => void>();
  const recover = vi.fn(
    async (): Promise<'admitted' | 'unavailable' | 'denied' | 'conflict' | 'superseded'> => 'admitted',
  );
  const Socket = browserBackendLeaseWebSocket(OwnedSocket as unknown as typeof WebSocket, {
    isCurrent: () => current,
    canSend: () => sendable,
    recover,
    closeEvent,
    schedule(callback) {
      timers.add(callback);
      return () => {
        timers.delete(callback);
      };
    },
  });
  const socket = new Socket('wss://owned.example.test/graphql');
  const delivered = vi.fn();
  socket.onclose = delivered;
  return {
    socket,
    recover,
    delivered,
    timers,
    retire() {
      current = false;
    },
    expire() {
      sendable = false;
    },
    timeout() {
      for (const callback of timers) callback();
    },
  };
}
function deferred() {
  let resolve!: (outcome: 'admitted') => void;
  const promise = new Promise<'admitted'>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}
async function settle() {
  for (let turn = 0; turn < 6; turn += 1) await Promise.resolve();
}

describe('selected browser lease websocket close composition', () => {
  it('makes expired-lease authentication retryable only after the captured scope is rechecked', async () => {
    const current = fixture();
    current.socket.dispatchEvent(closeEvent(4401));
    expect(current.delivered).not.toHaveBeenCalled();
    await settle();
    expect(current.recover).toHaveBeenCalledTimes(1);
    expect(current.delivered).toHaveBeenCalledTimes(1);
    expect(current.delivered.mock.calls[0][0]).toMatchObject({ code: 4403, reason: 'owned close', wasClean: false });
    expect(current.timers.size).toBe(0);
  });
  it.each(['denied', 'conflict', 'superseded'] as const)(
    'keeps %s terminal with no anonymous fallback',
    async (outcome) => {
      const current = fixture();
      current.recover.mockResolvedValue(outcome);
      current.socket.dispatchEvent(closeEvent(4401));
      await settle();
      expect(current.delivered.mock.calls[0][0].code).toBe(4401);
      expect(current.recover).toHaveBeenCalledTimes(1);
    },
  );
  it('uncertainty cannot retry an expired lease until an actual new lease is admitted', async () => {
    const current = fixture();
    current.recover.mockResolvedValue('unavailable');
    current.socket.dispatchEvent(closeEvent(4401));
    await settle();
    expect(current.delivered.mock.calls[0][0].code).toBe(4401);
  });
  it('an already superseded socket never starts recovery for a new owner', async () => {
    const current = fixture();
    current.retire();
    current.socket.dispatchEvent(closeEvent(4401));
    await settle();
    expect(current.recover).not.toHaveBeenCalled();
    expect(current.delivered.mock.calls[0][0].code).toBe(4401);
  });
  it('an owner switch while recovery awaits cannot turn an old socket into a new-account retry', async () => {
    const current = fixture();
    const pending = deferred();
    current.recover.mockReturnValue(pending.promise);
    current.socket.dispatchEvent(closeEvent(4401));
    await Promise.resolve();
    current.retire();
    pending.resolve('admitted');
    await settle();
    expect(current.delivered.mock.calls[0][0].code).toBe(4401);
  });
  it.each([1000, 1013, 4403, 4500])('preserves ordinary close code %i without credential work', async (code) => {
    const current = fixture();
    current.socket.dispatchEvent(closeEvent(code));
    expect(current.delivered.mock.calls[0][0].code).toBe(code);
    await settle();
    expect(current.recover).not.toHaveBeenCalled();
  });
  it('bounds a recovery promise that ignores all cancellation instead of retaining a permanent pending close', async () => {
    const current = fixture();
    const pending = deferred();
    current.recover.mockReturnValue(pending.promise);
    current.socket.dispatchEvent(closeEvent(4401));
    await Promise.resolve();
    current.timeout();
    await settle();
    expect(current.delivered.mock.calls[0][0].code).toBe(4401);
    pending.resolve('admitted');
    await settle();
    expect(current.delivered).toHaveBeenCalledTimes(1);
    expect(current.timers.size).toBe(0);
  });
  it('a failed recovery stays terminal and still delivers exactly one close', async () => {
    const current = fixture();
    current.recover.mockRejectedValue(new Error('Owned reader failed'));
    current.socket.dispatchEvent(closeEvent(4401));
    await settle();
    expect(current.delivered.mock.calls[0][0].code).toBe(4401);
    expect(current.delivered).toHaveBeenCalledTimes(1);
  });
  it.each(['owner', 'expiry'] as const)('suppresses queued protocol frames after %s changes', async (change) => {
    const current = fixture();
    const socket = current.socket as unknown as OwnedSocket;
    current.socket.send('owned-current-subscribe');
    expect(socket.sent).toEqual(['owned-current-subscribe']);
    const queued = Promise.resolve().then(() => current.socket.send('stale-queued-subscribe'));
    if (change === 'owner') current.retire();
    else current.expire();
    await queued;
    expect(socket.sent).toEqual(['owned-current-subscribe']);
    expect(socket.closes).toEqual([{ code: 4401, reason: 'Browser credential changed' }]);
  });
});
