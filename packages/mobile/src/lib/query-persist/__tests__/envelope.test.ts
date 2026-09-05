import { describe, it, expect } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import {
  PERSISTED_CACHE_VERSION,
  parsePersistedCache,
  serializePersistedCache,
  utf8ByteLength,
  type PersistedCacheEnvelope,
} from '../envelope';
import { dehydrateAllowlisted } from '../dehydrate';

const OWNER = 'user-1';

function envelope(overrides: Partial<PersistedCacheEnvelope> = {}): PersistedCacheEnvelope {
  return { version: PERSISTED_CACHE_VERSION, userId: OWNER, savedAt: 1000, queries: [], ...overrides };
}

describe('persisted cache envelope', () => {
  // T-03
  it('round-trips and classifies every unreadable shape', () => {
    const parsed = parsePersistedCache(serializePersistedCache(envelope({ savedAt: 42 })));
    expect(parsed.status).toBe('ok');
    if (parsed.status === 'ok') expect(parsed.envelope.savedAt).toBe(42);

    expect(parsePersistedCache(null)).toEqual({ status: 'absent' });
    expect(parsePersistedCache('')).toEqual({ status: 'absent' });
    expect(parsePersistedCache('{not json')).toEqual({ status: 'unreadable', reason: 'json' });
    expect(parsePersistedCache(JSON.stringify({ version: 2, userId: OWNER, savedAt: 1, queries: [] }))).toEqual({
      status: 'unreadable',
      reason: 'version',
    });
    expect(
      parsePersistedCache(JSON.stringify({ version: PERSISTED_CACHE_VERSION, userId: OWNER, savedAt: 1 })),
    ).toEqual({ status: 'unreadable', reason: 'shape' });
    expect(parsePersistedCache(JSON.stringify({ version: PERSISTED_CACHE_VERSION, savedAt: 1, queries: [] }))).toEqual({
      status: 'unreadable',
      reason: 'shape',
    });
    expect(parsePersistedCache('"a string"')).toEqual({ status: 'unreadable', reason: 'shape' });
  });

  it('carries the evicted flag through a round trip and defaults it absent', () => {
    const withFlag = parsePersistedCache(serializePersistedCache(envelope({ evicted: true })));
    expect(withFlag.status === 'ok' && withFlag.envelope.evicted).toBe(true);
    const without = parsePersistedCache(serializePersistedCache(envelope()));
    expect(without.status === 'ok' && without.envelope.evicted).toBeUndefined();
  });

  it('counts UTF-8 bytes the way Buffer.byteLength does', () => {
    for (const sample of ['plain ascii', 'café ñandú', '🧗‍♀️ send it', '{"a":"日本語"}', '']) {
      expect(utf8ByteLength(sample)).toBe(Buffer.byteLength(sample, 'utf8'));
    }
  });

  // T-05: the second of the two defences against a persisted mutation outbox —
  // the envelope type has no `mutations` field, so even a client full of
  // mutations serializes without one. (The first is the hard-coded
  // `shouldDehydrateMutation: () => false` asserted in dehydrate.test.ts.)
  it('never serializes a mutations key, even from a client holding mutations', async () => {
    const client = new QueryClient();
    client.setQueryData(['profile'], { id: OWNER, name: 'Marco' });
    const mutation = client.getMutationCache().build(client, { mutationFn: async () => 'ok' });
    await mutation.execute(undefined);

    const serialized = serializePersistedCache(envelope({ queries: dehydrateAllowlisted(client, OWNER) }));
    expect(serialized).not.toContain('mutations');
    expect(JSON.parse(serialized)).not.toHaveProperty('mutations');
  });
});
