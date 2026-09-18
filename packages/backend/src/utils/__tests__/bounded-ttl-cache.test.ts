import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import { BoundedTtlCache } from '../bounded-ttl-cache';

afterEach(() => vi.useRealTimers());

describe('bounded TTL cache', () => {
  it('evicts expired entries without rereading their keys', () => {
    vi.useFakeTimers();
    const cache = new BoundedTtlCache<string>({ maxEntries: 10, maxBytes: 1000 });
    cache.set('short', 'transient', 120_000);
    cache.set('long', 'success', 600_000);
    vi.advanceTimersByTime(120_000);
    cache.evictExpired();
    expect(cache.getStats().entries).toBe(1);
    expect(cache.get('short')).toBeUndefined();
    expect(cache.get('long')).toBe('success');
    vi.advanceTimersByTime(480_000);
    cache.evictExpired();
    expect(cache.getStats()).toMatchObject({ entries: 0, serializedBytes: 0 });
  });

  it('keeps frequently read entries when capacity is exceeded', () => {
    const cache = new BoundedTtlCache<number>({ maxEntries: 2, maxBytes: 1000 });
    cache.set('first', 1, 1000);
    cache.set('second', 2, 1000);
    cache.get('first');
    cache.set('third', 3, 1000);
    expect(cache.get('first')).toBe(1);
    expect(cache.get('second')).toBeUndefined();
    expect(cache.get('third')).toBe(3);
  });

  it('accounts for UTF-8 keys, replacements, and oversized payloads', () => {
    const cache = new BoundedTtlCache<string>({ maxEntries: 10, maxBytes: 12 });
    cache.set('é', 'abc', 1000); // 2-byte key + 5-byte JSON string
    expect(cache.getStats().serializedBytes).toBe(7);
    cache.set('é', 'x', 1000);
    expect(cache.getStats().serializedBytes).toBe(5);
    cache.set('next', 'abc', 1000);
    expect(cache.get('é')).toBeUndefined();
    cache.set('huge', 'x'.repeat(100), 1000);
    expect(cache.get('huge')).toBeUndefined();
    expect(cache.get('next')).toBe('abc');
    cache.clear();
    expect(cache.getStats()).toMatchObject({ entries: 0, serializedBytes: 0 });
  });
});
