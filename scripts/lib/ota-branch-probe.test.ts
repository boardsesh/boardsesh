/// <reference types="node" />

import { describe, expect, it } from 'vitest';
import { findSurfableBranch, interpretProbe, stripManifestSuffix } from './ota-branch-probe';

describe('branch surfability probe', () => {
  const headers = new Headers();

  it('finds a branch the server offers this platform', () => {
    const outcome = interpretProbe(
      200,
      headers,
      { branches: [{ name: 'pr-5422', lastUpdateAt: '2026-09-13T20:39:15Z' }], total: 1 },
      // eslint-disable-next-line @typescript-eslint/no-unsafe-argument -- fixture body is intentionally untyped
    );

    expect(outcome.state).toBe('branches');
    expect(findSurfableBranch(outcome, 'pr-5422')?.lastUpdateAt).toBe('2026-09-13T20:39:15Z');
  });

  it('reports a branch published for the OTHER platform as absent', () => {
    // Exactly #5417: pr-5417 was on the server for iOS and missing for Android,
    // and /branch_lists is filtered per platform, so the Android list simply
    // does not contain it.
    const outcome = interpretProbe(200, headers, { branches: [{ name: 'pr-5419' }], total: 1 });

    expect(findSurfableBranch(outcome, 'pr-5417')).toBeNull();
  });

  it('separates surfing being switched off from any other 404', () => {
    const off = new Headers({ 'xprem-branch-surfing': 'off' });
    expect(interpretProbe(404, off, null).state).toBe('surfing-off');
    expect(interpretProbe(404, headers, null).state).toBe('unreachable');
  });

  it('derives the server base URL from the manifest endpoint', () => {
    expect(stripManifestSuffix('https://updates.boardsesh.com/manifest')).toBe('https://updates.boardsesh.com');
    expect(stripManifestSuffix('https://updates.boardsesh.com/manifest/')).toBe('https://updates.boardsesh.com');
  });
});
