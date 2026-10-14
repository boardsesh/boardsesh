import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReleaseContextInput } from '@boardsesh/shared-schema';
import { enrichReleaseContext, resetMobileReleaseStatusCacheForTests } from '../mobile-release-status';
import { OptionalReleaseContextInputSchema } from '../../validation/schemas/release-context';

const CANARY_UUID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const CONTROL_UUID = '11111111-2222-4333-8444-555555555555';
const identity: ReleaseContextInput = {
  channel: 'production',
  branch: 'production',
  updateId: CANARY_UUID,
  runtimeVersion: 'ios-fingerprint',
  isEmbeddedLaunch: false,
};
const fetchMock = vi.fn<typeof fetch>();

function serveRollout(options: { active?: boolean; percentage?: number; platform?: string; uuid?: string } = {}) {
  fetchMock.mockImplementation(async (request) => {
    const url = String(request);
    if (url.endsWith('/auth/login')) return Response.json({ token: 'viewer-session' });
    if (url.endsWith('/rollout')) {
      return Response.json({
        active: options.active ?? true,
        updates: [{ updateId: '123456', platform: options.platform ?? 'ios', percentage: options.percentage ?? 25 }],
      });
    }
    if (url.endsWith('/updates/123456')) {
      return Response.json({
        updateId: '123456',
        platform: options.platform ?? 'ios',
        updateUUID: options.uuid ?? CANARY_UUID,
      });
    }
    throw new Error('Unexpected OTA request');
  });
}

beforeEach(() => {
  resetMobileReleaseStatusCacheForTests();
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  vi.stubEnv('OTA_STATUS_URL', 'https://updates.example/manifest');
  vi.stubEnv('OTA_STATUS_APP_ID', 'boardsesh');
  vi.stubEnv('OTA_STATUS_EMAIL', 'viewer@example.com');
  vi.stubEnv('OTA_STATUS_PASSWORD', 'viewer-password');
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('automatic canary membership', () => {
  it('compares the running native UUID with the active rollout UUID', async () => {
    serveRollout();
    const context = await enrichReleaseContext(identity, 'ios');
    expect(context).toMatchObject({ ...identity, automaticCanary: true });
    expect(context?.canaryCheckedAt).toEqual(expect.any(String));
    expect(fetchMock.mock.calls[1]?.[0]).toBe(
      'https://updates.example/api/apps/boardsesh/branch/production/runtimeVersion/ios-fingerprint/rollout',
    );
    expect(fetchMock.mock.calls[2]?.[0]).toEqual(expect.stringContaining('/updates/123456'));
    expect(fetchMock.mock.calls[2]?.[1]?.headers).toEqual({ authorization: 'Bearer viewer-session' });
  });

  it('identifies a canary without a running branch marker', async () => {
    serveRollout();
    expect(await enrichReleaseContext({ ...identity, branch: null }, 'ios')).toMatchObject({
      branch: null,
      automaticCanary: true,
    });
  });

  it('keeps a control device stable while a candidate is downloading elsewhere', async () => {
    serveRollout();
    expect(await enrichReleaseContext({ ...identity, updateId: CONTROL_UUID }, 'ios')).toMatchObject({
      updateId: CONTROL_UUID,
      automaticCanary: false,
    });
  });

  it.each(['pr-beta', 'pr-123', 'pr-staging'])('does not label voluntary %s a production canary', async (branch) => {
    expect(await enrichReleaseContext({ ...identity, branch }, 'ios')).toMatchObject({ automaticCanary: false });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does not label an embedded fallback or browser a canary', async () => {
    expect(await enrichReleaseContext({ ...identity, isEmbeddedLaunch: true }, 'ios')).toMatchObject({
      automaticCanary: false,
    });
    expect(await enrichReleaseContext(identity, 'web')).toMatchObject({ automaticCanary: false });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('clears canary classification after a completed or reverted rollout', async () => {
    serveRollout({ active: false });
    expect(await enrichReleaseContext(identity, 'ios')).toMatchObject({ automaticCanary: false });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('requires a rollout on the reporting platform', async () => {
    serveRollout({ platform: 'android' });
    expect(await enrichReleaseContext(identity, 'ios')).toMatchObject({ automaticCanary: false });
  });

  it('coalesces reads and compares cached rollout evidence against each running UUID', async () => {
    serveRollout();
    const [canary, control] = await Promise.all([
      enrichReleaseContext(identity, 'ios'),
      enrichReleaseContext({ ...identity, updateId: CONTROL_UUID }, 'ios'),
    ]);
    expect(canary?.automaticCanary).toBe(true);
    expect(control?.automaticCanary).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    await enrichReleaseContext(identity, 'ios');
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('refreshes completed rollout evidence after sixty seconds', async () => {
    vi.useFakeTimers();
    serveRollout();
    expect((await enrichReleaseContext(identity, 'ios'))?.automaticCanary).toBe(true);
    serveRollout({ active: false });
    await vi.advanceTimersByTimeAsync(60_000);
    expect((await enrichReleaseContext(identity, 'ios'))?.automaticCanary).toBe(false);
  });

  it.each([null, { updateId: CANARY_UUID }, { ...identity, isEmbeddedLaunch: null }])(
    'leaves incomplete identity unknown',
    async (input) => {
      const context = await enrichReleaseContext(input, 'ios');
      expect(context?.automaticCanary ?? null).toBeNull();
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it('preserves identity when viewer credentials are missing', async () => {
    vi.stubEnv('OTA_STATUS_PASSWORD', '');
    expect(await enrichReleaseContext(identity, 'ios')).toEqual({
      ...identity,
      automaticCanary: null,
      canaryCheckedAt: null,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns unknown after refused login, network failure, or malformed metadata', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 401 }));
    expect((await enrichReleaseContext(identity, 'ios'))?.automaticCanary).toBeNull();
    resetMobileReleaseStatusCacheForTests();
    fetchMock.mockRejectedValue(new Error('network unavailable'));
    expect((await enrichReleaseContext(identity, 'ios'))?.automaticCanary).toBeNull();
    resetMobileReleaseStatusCacheForTests();
    serveRollout({ uuid: 'numeric-update-id' });
    expect((await enrichReleaseContext(identity, 'ios'))?.automaticCanary).toBeNull();
  });

  it('bounds the entire lookup to two seconds', async () => {
    vi.useFakeTimers();
    fetchMock.mockImplementation(() => new Promise(() => {}));
    const pending = enrichReleaseContext(identity, 'ios');
    await vi.advanceTimersByTimeAsync(2_000);
    expect(await pending).toMatchObject({ ...identity, automaticCanary: null, canaryCheckedAt: null });
    expect(fetchMock.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
  });

  it('strips forged canary fields and degrades malformed diagnostics', () => {
    expect(OptionalReleaseContextInputSchema.parse({ ...identity, automaticCanary: true, updateId: 77 })).toEqual({
      ...identity,
      updateId: null,
    });
    expect(OptionalReleaseContextInputSchema.parse('bad context')).toBeNull();
  });
});
