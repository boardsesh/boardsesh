/// <reference types="node" />

import { describe, expect, it } from 'vitest';
import { XPREM_BUNDLE_MARKERS, missingBundleMarkers } from './lib/xprem-admin.mts';
import { BUNDLE_LAST_READ, BundleUnavailableError, formatProbe, probeAdminApi } from './ota-admin-api-probe';

const BASE = 'https://updates.example';

/** A bundle that spells every path the way the 3.2.5 dashboard does. */
const INTACT_BUNDLE = XPREM_BUNDLE_MARKERS.map(({ marker }) => `x=${marker};`).join('\n');

function dashboard(bundleSource: string | null, bundleName = 'index-AbC_123-x.js'): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = input instanceof URL ? input.href : typeof input === 'string' ? input : input.url;
    if (url === `${BASE}/dashboard/`) {
      return new Response(`<script type="module" src="./assets/${bundleName}"></script>`);
    }
    if (url === `${BASE}/dashboard/assets/${bundleName}` && bundleSource !== null) return new Response(bundleSource);
    return new Response('not found', { status: 404 });
  }) as typeof fetch;
}

describe('missingBundleMarkers', () => {
  it('finds nothing missing in a bundle that has every marker', () => {
    expect(missingBundleMarkers(INTACT_BUNDLE)).toEqual([]);
  });

  it.each(XPREM_BUNDLE_MARKERS.map(({ marker, usedFor }) => [usedFor, marker]))(
    'names the marker for "%s" when the bundle loses it',
    (usedFor, marker) => {
      const without = XPREM_BUNDLE_MARKERS.filter((entry) => entry.marker !== marker)
        .map((entry) => `x=${entry.marker};`)
        .join('\n');
      // A longer marker can contain a shorter one, so only assert on the one removed.
      expect(missingBundleMarkers(without)).toContainEqual({ marker, usedFor });
    },
  );

  it('has one marker per endpoint the client calls', () => {
    const markers = XPREM_BUNDLE_MARKERS.map(({ marker }) => marker);
    expect(new Set(markers).size).toBe(markers.length);
    for (const fragment of [
      '/auth/login',
      '/api/license',
      '/channels',
      '/branch-surfing',
      '/branches',
      '/protection',
      '/updateChannelBranchMapping',
      '/runtimeVersions',
      '/rollout',
      '/rollout/revert',
      '/updates/',
      '/identity/update-health',
      '/observe/update-health/history',
    ]) {
      expect(
        markers.some((marker) => marker.includes(fragment)),
        fragment,
      ).toBe(true);
    }
  });
});

describe('probeAdminApi', () => {
  it('follows the dashboard page to its bundle and passes an intact one', async () => {
    const result = await probeAdminApi(BASE, dashboard(INTACT_BUNDLE));
    expect(result).toEqual({ bundleName: 'index-AbC_123-x.js', missing: [] });
    expect(formatProbe(result)).toEqual([
      '[ota-api-probe] dashboard bundle: index-AbC_123-x.js',
      `[ota-api-probe] note: the client was written against ${BUNDLE_LAST_READ}. A new bundle is normal after a server upgrade.`,
      `[ota-api-probe] All ${XPREM_BUNDLE_MARKERS.length} admin API markers are present.`,
    ]);
  });

  it('reports an endpoint that moved', async () => {
    const moved = INTACT_BUNDLE.replace('/rollout/revert`', '/rollout/undo`');
    const result = await probeAdminApi(BASE, dashboard(moved, BUNDLE_LAST_READ));
    expect(result.missing).toEqual([{ marker: '/rollout/revert`', usedFor: 'revert a rollout' }]);
    const lines = formatProbe(result);
    expect(lines[1]).toBe('[ota-api-probe] MISSING: /rollout/revert` (used for: revert a rollout)');
    expect(lines.at(-1)).toContain('1 marker(s) are gone from the dashboard bundle.');
  });

  it('says the bundle is unavailable, which is a different finding from a moved endpoint', async () => {
    await expect(probeAdminApi(BASE, dashboard(null))).rejects.toBeInstanceOf(BundleUnavailableError);
    const noBundle = (async () => new Response('<html></html>')) as typeof fetch;
    await expect(probeAdminApi(BASE, noBundle)).rejects.toThrow('names no assets/index-*.js bundle');
    const offline = (async () => {
      throw new Error('getaddrinfo ENOTFOUND');
    }) as typeof fetch;
    await expect(probeAdminApi(BASE, offline)).rejects.toThrow('failed: getaddrinfo ENOTFOUND');
  });
});
