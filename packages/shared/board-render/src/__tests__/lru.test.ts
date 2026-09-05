// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Boardsesh

import { describe, expect, it } from 'vitest';
import { BoundedLru } from '../lru';

const byteLru = (maxEntries: number, maxBytes: number) =>
  new BoundedLru<Buffer>({ maxEntries, maxBytes, sizeOf: (buffer) => buffer.byteLength });

describe('BoundedLru', () => {
  it('evicts the oldest entry when maxEntries is exceeded', () => {
    const cache = byteLru(2, 1_000);
    cache.set('first', Buffer.alloc(1));
    cache.set('second', Buffer.alloc(1));
    cache.set('third', Buffer.alloc(1));

    expect(cache.size).toBe(2);
    expect(cache.has('first')).toBe(false);
    expect(cache.has('second')).toBe(true);
    expect(cache.has('third')).toBe(true);
  });

  it('evicts by byte budget even when under the entry limit', () => {
    const cache = byteLru(10, 100);
    cache.set('first', Buffer.alloc(60));
    cache.set('second', Buffer.alloc(60));

    expect(cache.has('first')).toBe(false);
    expect(cache.has('second')).toBe(true);
    expect(cache.byteSize).toBe(60);
  });

  it('re-accounts bytes when overwriting an existing key', () => {
    const cache = byteLru(10, 100);
    cache.set('key', Buffer.alloc(80));
    cache.set('key', Buffer.alloc(30));

    expect(cache.size).toBe(1);
    expect(cache.byteSize).toBe(30);

    // The freed budget must be reusable without evicting the overwritten key.
    cache.set('other', Buffer.alloc(60));
    expect(cache.has('key')).toBe(true);
    expect(cache.has('other')).toBe(true);
    expect(cache.byteSize).toBe(90);
  });

  it('get marks an entry as most-recently-used', () => {
    const cache = byteLru(2, 1_000);
    cache.set('first', Buffer.alloc(1));
    cache.set('second', Buffer.alloc(1));

    expect(cache.get('first')).toBeDefined();
    cache.set('third', Buffer.alloc(1));

    expect(cache.has('first')).toBe(true);
    expect(cache.has('second')).toBe(false);
    expect(cache.has('third')).toBe(true);
  });

  it('immediately evicts a single entry larger than the byte budget', () => {
    const cache = byteLru(10, 100);
    cache.set('huge', Buffer.alloc(200));

    expect(cache.size).toBe(0);
    expect(cache.byteSize).toBe(0);
    expect(cache.get('huge')).toBeUndefined();
  });

  it('drops every entry and its byte total on clear', () => {
    const cache = byteLru(3, 100);
    cache.set('first', Buffer.alloc(10));
    cache.set('second', Buffer.alloc(10));

    cache.clear();

    expect(cache.size).toBe(0);
    expect(cache.byteSize).toBe(0);
    expect(cache.get('first')).toBeUndefined();

    // Still usable afterwards.
    cache.set('third', Buffer.alloc(10));
    expect(cache.size).toBe(1);
    expect(cache.byteSize).toBe(10);
  });

  it('returns undefined for missing keys and tracks sizes accurately across evictions', () => {
    const cache = byteLru(3, 100);
    expect(cache.get('missing')).toBeUndefined();

    cache.set('first', Buffer.alloc(40));
    cache.set('second', Buffer.alloc(40));
    cache.set('third', Buffer.alloc(40));

    expect(cache.size).toBe(2);
    expect(cache.byteSize).toBe(80);
  });
});
