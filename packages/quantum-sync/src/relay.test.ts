import { describe, expect, it } from 'vitest';
import { createNostrEventLoader, queryNostrRelay, type NostrWebSocketEvent, type NostrWebSocketLike } from './relay';

const QUERY = {
  relays: ['wss://one.example/', 'wss://two.example/'],
  signerPubkey: 'a'.repeat(64),
  kind: 30_078,
  dTag: 'test',
  maxManifestBytes: 1024,
  maxEventsPerRelay: 4,
  relayTimeoutMs: 100,
} as const;

type SocketEventType = 'open' | 'message' | 'error' | 'close';

class SyntheticNostrSocket implements NostrWebSocketLike {
  readonly sent: string[] = [];
  readonly listeners: Record<SocketEventType, Set<(event: NostrWebSocketEvent) => void>> = {
    open: new Set(),
    message: new Set(),
    error: new Set(),
    close: new Set(),
  };

  addEventListener(type: SocketEventType, listener: (event: NostrWebSocketEvent) => void): void {
    this.listeners[type].add(listener);
  }

  removeEventListener(type: SocketEventType, listener: (event: NostrWebSocketEvent) => void): void {
    this.listeners[type].delete(listener);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {}

  emit(type: SocketEventType, event: NostrWebSocketEvent = {}): void {
    for (const listener of this.listeners[type]) listener(event);
  }
}

describe('Quantum Nostr relay loading', () => {
  it('uses successful relays when another fails and deduplicates event ids', async () => {
    const event = { id: 'event-1' };
    const loader = createNostrEventLoader({
      queryRelay: async (relay) => {
        if (relay.includes('one.example')) throw new Error('offline');
        return [event, event];
      },
    });
    await expect(loader(QUERY)).resolves.toEqual([event]);
  });

  it('fails when every configured relay fails', async () => {
    const loader = createNostrEventLoader({ queryRelay: async () => Promise.reject(new Error('offline')) });
    await expect(loader(QUERY)).rejects.toMatchObject({ code: 'NOSTR_RELAY_FAILED' });
  });

  it('rejects oversized manifest content before retaining the event', async () => {
    const socket = new SyntheticNostrSocket();
    const queryPromise = queryNostrRelay(
      'wss://relay.example/',
      { ...QUERY, relays: ['wss://relay.example/'], maxManifestBytes: 16 },
      () => socket,
    );
    socket.emit('open');
    const request = JSON.parse(socket.sent[0] ?? 'null') as unknown;
    if (!Array.isArray(request) || typeof request[1] !== 'string') throw new Error('Expected a Nostr request frame.');

    socket.emit('message', {
      data: JSON.stringify(['EVENT', request[1], { id: 'candidate', content: 'x'.repeat(17) }]),
    });

    await expect(queryPromise).rejects.toThrow(/oversized manifest event/);
  });

  it('rejects binary relay frames before decoding beyond the bounded envelope', async () => {
    const socket = new SyntheticNostrSocket();
    const queryPromise = queryNostrRelay(
      'wss://relay.example/',
      { ...QUERY, relays: ['wss://relay.example/'], maxManifestBytes: 16 },
      () => socket,
    );
    socket.emit('message', { data: new Uint8Array(64 * 1024 + 16 * 2 + 1) });

    await expect(queryPromise).rejects.toThrow(/oversized message/);
  });

  it('rejects injected relay results that exceed the retained-event cap', async () => {
    const loader = createNostrEventLoader({
      queryRelay: async () => Array.from({ length: QUERY.maxEventsPerRelay + 1 }, (_, index) => ({ id: `${index}` })),
    });

    await expect(loader(QUERY)).rejects.toThrow(/exceeded the configured event limit/);
  });
});
