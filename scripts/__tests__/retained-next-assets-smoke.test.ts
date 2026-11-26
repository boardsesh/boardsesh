import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { checkRetainedNextAssets, type RetainedAssetFetch } from '../retained-next-assets-smoke';

const origin = 'https://fixture.up.railway.app';
const path = '/_next/static/Sj_peyg3dLRKbogd1hG-t/_buildManifest.js';
const cdn = 'https://assets.boardsesh.com' + path;
// The immutable release-88 bytes verified by the deploy smoke.
const manifest = readFileSync(new URL('./fixtures/retained-next-build-manifest.js.txt', import.meta.url), 'utf8');
const identity = { deploymentId: 'deployment-1', release: 'release-1' };
function health(overrides: Record<string, unknown> = {}) {
  return Response.json(
    { ...identity, status: 'ok', staticAssets: { retainedNextAssets: true }, ...overrides },
    { headers: { 'cache-control': 'no-store' } },
  );
}
function redirect(overrides: Record<string, string> = {}) {
  return new Response(null, {
    status: 307,
    headers: {
      location: cdn,
      'cache-control': 'private, no-store',
      'cdn-cache-control': 'no-store',
      'referrer-policy': 'no-referrer',
      ...overrides,
    },
  });
}
function retained(body = manifest, overrides: Record<string, string> = {}) {
  return new Response(body, {
    headers: {
      'cache-control': 'public, max-age=31536000, immutable',
      'content-type': 'application/javascript; charset=utf-8',
      'access-control-allow-origin': '*',
      ...overrides,
    },
  });
}

describe('retained Next assets deployment smoke', () => {
  it('verifies the redirect, fetches the fixed asset anonymously and rechecks the same origin', async () => {
    const fetchImpl = vi
      .fn<RetainedAssetFetch>()
      .mockResolvedValueOnce(health())
      .mockResolvedValueOnce(redirect())
      .mockResolvedValueOnce(retained())
      .mockResolvedValueOnce(health());
    await checkRetainedNextAssets(origin, identity, fetchImpl);
    expect(fetchImpl.mock.calls.map(([url]) => (url instanceof URL ? url.href : url))).toEqual([
      origin + '/api/health',
      origin + path + '?smoke=retained',
      cdn,
      origin + '/api/health',
    ]);
    for (const [, init] of fetchImpl.mock.calls) {
      expect(init).toMatchObject({
        method: 'GET',
        redirect: 'manual',
        credentials: 'omit',
        signal: expect.any(AbortSignal),
      });
      expect(init?.body).toBeUndefined();
      expect(init?.headers).toBeUndefined();
    }
  });

  it.each([
    ['missing capability', () => health({ staticAssets: {} })],
    ['another deployment', () => health({ deploymentId: 'previous' })],
    ['another release', () => health({ release: 'previous' })],
    ['cached health', () => Response.json({ ...identity, status: 'ok', staticAssets: { retainedNextAssets: true } })],
  ])('rejects %s before fetching the asset', async (_label, response) => {
    const fetchImpl = vi.fn<RetainedAssetFetch>().mockResolvedValueOnce(response());
    await expect(checkRetainedNextAssets(origin, identity, fetchImpl)).rejects.toThrow();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['current-image hit', () => retained()],
    ['redirect to another origin', () => redirect({ location: origin + path })],
    ['redirect containing the query', () => redirect({ location: cdn + '?smoke=retained' })],
    ['browser-cacheable redirect', () => redirect({ 'cache-control': 'public' })],
    ['CDN-cacheable redirect', () => redirect({ 'cdn-cache-control': 'public' })],
    ['referrer allowed', () => redirect({ 'referrer-policy': 'origin' })],
  ])('rejects %s without following it', async (_label, response) => {
    const fetchImpl = vi.fn<RetainedAssetFetch>().mockResolvedValueOnce(health()).mockResolvedValueOnce(response());
    await expect(checkRetainedNextAssets(origin, identity, fetchImpl)).rejects.toThrow();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['asset missing', () => new Response(null, { status: 404 })],
    ['restricted CORS', () => retained(manifest, { 'access-control-allow-origin': origin })],
    ['unexpected MIME type', () => retained(manifest, { 'content-type': 'text/html' })],
    ['mutable CDN response', () => retained(manifest, { 'cache-control': 'no-store' })],
    ['wrong size', () => retained(manifest.slice(1))],
    ['oversized body', () => retained(manifest + ' ')],
    ['wrong digest', () => retained('X' + manifest.slice(1))],
  ])('rejects %s', async (_label, response) => {
    const fetchImpl = vi
      .fn<RetainedAssetFetch>()
      .mockResolvedValueOnce(health())
      .mockResolvedValueOnce(redirect())
      .mockResolvedValueOnce(response());
    await expect(checkRetainedNextAssets(origin, identity, fetchImpl)).rejects.toThrow();
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it.each(['deploymentId', 'release'])('detects a mid-check %s switch without expected IDs', async (key) => {
    const fetchImpl = vi
      .fn<RetainedAssetFetch>()
      .mockResolvedValueOnce(health())
      .mockResolvedValueOnce(redirect())
      .mockResolvedValueOnce(retained())
      .mockResolvedValueOnce(health({ [key]: 'next' }));
    await expect(checkRetainedNextAssets(origin, {}, fetchImpl)).rejects.toThrow('Deployment changed');
  });
});
