/// <reference types="node" />

import { describe, expect, it } from 'vitest';
import {
  PROBE_TIMEOUT_MS,
  findSurfableBranch,
  interpretProbe,
  probeBranchList,
  stripManifestSuffix,
} from './ota-branch-probe';

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

describe('the request itself', () => {
  const RV = 'b71bdb600c5a3e954d75c9ca673f056c62247ea9';

  it('asks the server exactly what a device asks, and caps the wait', async () => {
    const calls: { url: string; headers: Record<string, string>; signal?: AbortSignal }[] = [];
    const fetchImpl = async (url: string, init: { headers: Record<string, string>; signal?: AbortSignal }) => {
      calls.push({ url, ...init });
      return new Response(JSON.stringify({ branches: [{ name: 'pr-5417' }], total: 1 }), { status: 200 });
    };

    const outcome = await probeBranchList(fetchImpl, 'https://updates.boardsesh.com', RV, 'ios');

    expect(outcome.state).toBe('branches');
    // ?all=1 matters: the server's default page is the newest 50 and is applied
    // BEFORE the pr-* filter, so a busy day could hide a branch that exists.
    expect(calls[0].url).toBe('https://updates.boardsesh.com/branch_lists?all=1');
    expect(calls[0].headers).toMatchObject({ 'expo-runtime-version': RV, 'expo-platform': 'ios' });
    // An uncapped request would park a publish step behind a TCP timeout.
    expect(calls[0].signal).toBeInstanceOf(AbortSignal);
    expect(PROBE_TIMEOUT_MS).toBeLessThan(60_000);
  });

  it('reports a transport failure as unreachable instead of throwing', async () => {
    // Callers treat "unreachable" as no verdict; a throw would escape into the
    // publish flow instead.
    const outcome = await probeBranchList(
      () => {
        throw new Error('connect ECONNREFUSED');
      },
      'https://updates.boardsesh.com',
      RV,
      'android',
    );

    expect(outcome.state).toBe('unreachable');
    expect(outcome.detail).toContain('ECONNREFUSED');
  });

  it('reports a body that is not JSON as unreachable rather than crashing', async () => {
    // A proxy error page is HTML with a 200 more often than anyone would like.
    const outcome = await probeBranchList(
      async () => new Response('<html>gateway</html>', { status: 200 }),
      'https://updates.boardsesh.com',
      RV,
      'ios',
    );

    expect(outcome.state).toBe('unreachable');
  });
});
