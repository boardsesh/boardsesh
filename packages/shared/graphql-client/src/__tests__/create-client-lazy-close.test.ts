import { describe, expect, it } from 'vitest';
import { createGraphQLClient } from '../create-client';

// Runs the REAL graphql-ws client: the bug this guards against lives inside it.
// graphql-ws arms one lazy-close timer per released operation but keeps only the
// last handle, so releasing two operations in one tick and subscribing again
// leaves a timer that closes the socket under the new operation.

const LAZY_CLOSE_MS = 40;

class FakeSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static instances: FakeSocket[] = [];

  readonly CONNECTING = 0;
  readonly OPEN = 1;
  readonly CLOSING = 2;
  readonly CLOSED = 3;
  readonly protocol = 'graphql-transport-ws';
  readyState = 0;
  closeCodes: number[] = [];
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;

  constructor() {
    FakeSocket.instances.push(this);
    setTimeout(() => {
      this.readyState = 1;
      this.onopen?.({} as Event);
    }, 0);
  }

  send(data: string): void {
    const frame = JSON.parse(data) as { type: string };
    if (frame.type === 'connection_init') {
      setTimeout(() => this.onmessage?.({ data: JSON.stringify({ type: 'connection_ack' }) } as MessageEvent), 0);
    }
  }

  close(code = 1000, reason = ''): void {
    this.closeCodes.push(code);
    if (this.readyState >= 2) return;
    this.readyState = 2;
    setTimeout(() => {
      this.readyState = 3;
      this.onclose?.({ code, reason, wasClean: true } as CloseEvent);
    }, 0);
  }
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createClient() {
  FakeSocket.instances = [];
  return createGraphQLClient({
    url: 'ws://localhost/graphql',
    webSocketImpl: FakeSocket as unknown as typeof WebSocket,
    lazyCloseTimeoutMs: LAZY_CLOSE_MS,
  });
}

function stream(client: ReturnType<typeof createClient>, name: string) {
  const events: string[] = [];
  const release = client.subscribe(
    { query: `subscription ${name} { ${name.toLowerCase()} }` },
    {
      next: () => events.push('next'),
      error: () => events.push('error'),
      complete: () => events.push('complete'),
    },
  );
  return { events, release };
}

describe('createGraphQLClient — lazy close', () => {
  it('keeps the socket under a live operation after two were released in one tick', async () => {
    const client = createClient();
    const first = stream(client, 'First');
    const second = stream(client, 'Second');
    await wait(10);
    expect(FakeSocket.instances).toHaveLength(1);

    // A caller dropping both of its streams at once, then subscribing again.
    first.release();
    second.release();
    await Promise.resolve();
    await Promise.resolve();
    const replacement = stream(client, 'Replacement');

    await wait(LAZY_CLOSE_MS * 3);

    const [socket] = FakeSocket.instances;
    expect(socket.readyState).toBe(FakeSocket.OPEN);
    expect(socket.closeCodes).toEqual([]);
    expect(replacement.events).toEqual([]);

    // Once the replacement goes too, the idle socket still closes on time.
    replacement.release();
    await wait(LAZY_CLOSE_MS * 3);
    expect(socket.closeCodes).toEqual([1000]);
    expect(socket.readyState).toBe(FakeSocket.CLOSED);
  });

  it('still closes an idle socket once the timeout passes', async () => {
    const client = createClient();
    const only = stream(client, 'Only');
    await wait(10);

    only.release();
    await wait(LAZY_CLOSE_MS * 3);

    expect(FakeSocket.instances[0].closeCodes).toEqual([1000]);
    expect(FakeSocket.instances[0].readyState).toBe(FakeSocket.CLOSED);
  });

  it('lets dispose close the socket even with operations live', async () => {
    const client = createClient();
    stream(client, 'Live');
    await wait(10);

    await client.dispose();
    await wait(5);

    expect(FakeSocket.instances[0].closeCodes).toEqual([1000]);
    expect(FakeSocket.instances[0].readyState).toBe(FakeSocket.CLOSED);
  });

  // graphql-ws opens a new socket for an operation started on a disposed
  // client, so the dispose exemption must not outlive the dispose itself.
  it('guards again once a dispose has finished', async () => {
    const client = createClient();
    // Released first: graphql-ws never releases the lock of an operation that a
    // dispose ends, which would keep any later lazy close from arming at all.
    const before = stream(client, 'Before');
    await wait(10);
    before.release();
    await client.dispose();
    await wait(5);
    expect(FakeSocket.instances[0].readyState).toBe(FakeSocket.CLOSED);

    const first = stream(client, 'First');
    const second = stream(client, 'Second');
    await wait(10);
    first.release();
    second.release();
    await Promise.resolve();
    await Promise.resolve();
    const replacement = stream(client, 'Replacement');
    await wait(LAZY_CLOSE_MS * 3);

    const reopened = FakeSocket.instances[1];
    expect(reopened.readyState).toBe(FakeSocket.OPEN);
    expect(reopened.closeCodes).toEqual([]);
    replacement.release();
  });
});
