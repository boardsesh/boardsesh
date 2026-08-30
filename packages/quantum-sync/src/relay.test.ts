import { describe, expect, it } from 'vitest';
import { createNostrEventLoader } from './relay';

const QUERY = {
  relays: ['wss://one.example/', 'wss://two.example/'],
  signerPubkey: 'a'.repeat(64),
  kind: 30_078,
  dTag: 'test',
  maxEventsPerRelay: 4,
  relayTimeoutMs: 100,
} as const;

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
});
