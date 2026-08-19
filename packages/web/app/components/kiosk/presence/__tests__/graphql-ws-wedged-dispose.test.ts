// Why the kiosk hub calls `client.terminate()` before `client.dispose()`.
//
// graphql-ws 6.2.0's `dispose()` is `disposed = true; if (connecting) { const
// [socket] = await connecting; socket.close(1000) }` — it can only close a
// socket whose `connecting` promise has SETTLED, and that promise settles on
// `connection_ack`. The ack timeout that would otherwise settle it is disabled
// by the library's own default (`connectionAckWaitTimeout = 0`, guarded by
// `isFinite(x) && x > 0`), which the shared `createGraphQLClient` keeps.
//
// So a proxy that accepts the WebSocket upgrade while the app behind it is
// restarting leaves a disposed client's socket OPEN for the life of the page.
// The kiosk hub disposes mid-connect by construction — its rebuild only ever
// fires while the socket is down — so on an unattended screen that is a
// permanent leak. `terminate()` is what settles the promise and closes it.
//
// If this test ever starts failing because `dispose()` closes the socket on its
// own, the hub's `terminate()` call can go with it.

import { describe, it, expect } from 'vite-plus/test';
import { createClient } from 'graphql-ws';

/** Accepts the upgrade, never sends `connection_ack`. */
class WedgedSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  readyState = WedgedSocket.CONNECTING;
  onopen: (() => void) | null = null;
  onclose: ((event: { code: number; reason: string }) => void) | null = null;
  onerror: ((err: unknown) => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  closedWithCode: number | null = null;

  constructor(
    readonly url: string,
    readonly protocol: string,
  ) {
    openedSockets.push(this);
    queueMicrotask(() => {
      this.readyState = WedgedSocket.OPEN;
      this.onopen?.();
    });
  }

  send() {}

  close(code: number, reason: string) {
    this.closedWithCode = code;
    this.readyState = WedgedSocket.CLOSED;
    this.onclose?.({ code, reason });
  }
}

const openedSockets: WedgedSocket[] = [];
const tick = () => new Promise((resolve) => setTimeout(resolve, 20));

describe('graphql-ws teardown of a socket that never acks', () => {
  it('dispose() leaves it open forever; terminate() closes it', async () => {
    openedSockets.length = 0;
    const client = createClient({
      url: 'ws://wedged.test/graphql',
      webSocketImpl: WedgedSocket as unknown as typeof WebSocket,
      lazy: true,
      retryAttempts: 0,
    });

    const unsubscribe = client.subscribe(
      { query: 'subscription BoardNowPlaying { boardNowPlaying }' },
      { next: () => {}, error: () => {}, complete: () => {} },
    );
    await tick();
    expect(openedSockets).toHaveLength(1);
    expect(openedSockets[0].readyState).toBe(WedgedSocket.OPEN);

    let disposeSettled = false;
    // The public type says `void`; the implementation returns a promise that
    // only settles once the socket is closed, which is the whole point here.
    const disposal = client.dispose() as unknown as Promise<void> | undefined;
    void Promise.resolve(disposal).then(
      () => {
        disposeSettled = true;
      },
      () => {
        disposeSettled = true;
      },
    );
    await tick();

    expect(disposeSettled).toBe(false);
    expect(openedSockets[0].readyState).toBe(WedgedSocket.OPEN);

    client.terminate();
    await tick();

    expect(openedSockets[0].readyState).toBe(WedgedSocket.CLOSED);
    unsubscribe();
  });
});
