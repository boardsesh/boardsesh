// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Boardsesh

import { describe, expect, it } from 'vitest';
import { createOgImageHeaders } from '../headers';

// Three tiers, not two (#4773). The versioned branch is what the `&v=` in a
// board-render URL buys; the two unversioned branches exist because the original
// 300s TTL was calibrated for the /api/og/climb 307 redirect, which carries no
// image bytes — applying it to a WASM + sharp render on the route that is 48.7%
// of all function invocations would have been a cost regression.
describe('createOgImageHeaders', () => {
  it('marks a versioned response immutable for a year', () => {
    const headers = createOgImageHeaders({ contentType: 'image/webp', version: 'ddff19e91ac6' });
    expect(headers['Cache-Control']).toBe('public, max-age=31536000, s-maxage=31536000, immutable');
    expect(headers['CDN-Cache-Control']).toBe('public, s-maxage=31536000, immutable');
    expect(headers['Vercel-CDN-Cache-Control']).toBe('public, s-maxage=31536000, immutable');
  });

  it('keeps the short tier as the default for unversioned responses', () => {
    const headers = createOgImageHeaders({ contentType: 'image/jpeg' });
    expect(headers['Cache-Control']).toBe('public, max-age=0, s-maxage=300, stale-while-revalidate=86400');
    expect(headers['CDN-Cache-Control']).toBe('public, s-maxage=300, stale-while-revalidate=86400');
    expect(headers['Vercel-CDN-Cache-Control']).toBe('public, s-maxage=300, stale-while-revalidate=86400');
  });

  it('caps an unversioned render at a day on the daily tier', () => {
    const headers = createOgImageHeaders({ contentType: 'image/webp', unversionedTier: 'daily' });
    expect(headers['Cache-Control']).toBe('public, max-age=0, s-maxage=86400, stale-while-revalidate=604800');
    expect(headers['CDN-Cache-Control']).toBe('public, s-maxage=86400, stale-while-revalidate=604800');
    // Load-bearing on Vercel while www still serves from there — it has to track
    // the CDN header on every tier, not just the immutable one.
    expect(headers['Vercel-CDN-Cache-Control']).toBe('public, s-maxage=86400, stale-while-revalidate=604800');
  });

  it('ignores the unversioned tier once a version is present', () => {
    const daily = createOgImageHeaders({ contentType: 'image/webp', version: 'abc12345', unversionedTier: 'daily' });
    const short = createOgImageHeaders({ contentType: 'image/webp', version: 'abc12345', unversionedTier: 'short' });
    expect(daily['Cache-Control']).toBe(short['Cache-Control']);
    expect(daily['Cache-Control']).toContain('immutable');
  });

  it('treats an explicit null version as unversioned', () => {
    const headers = createOgImageHeaders({ contentType: 'image/webp', version: null, unversionedTier: 'daily' });
    expect(headers['Cache-Control']).not.toContain('immutable');
  });

  it('passes content type and server timing through', () => {
    const headers = createOgImageHeaders({
      contentType: 'image/png',
      version: 'abc12345',
      serverTiming: 'wasm;dur=1.0',
    });
    expect(headers['Content-Type']).toBe('image/png');
    expect(headers['Server-Timing']).toBe('wasm;dur=1.0');
  });

  it('omits Server-Timing when none is given', () => {
    expect(createOgImageHeaders({ contentType: 'image/png' })['Server-Timing']).toBeUndefined();
  });
});
