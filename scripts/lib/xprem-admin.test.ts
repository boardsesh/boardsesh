/// <reference types="node" />

import { describe, expect, it } from 'vitest';
import { FAKE_APP, FAKE_BASE_URL, fakeXprem } from '../__tests__/helpers/fake-xprem';
import {
  XpremApiError,
  adminBaseUrl,
  adminClientFromEnvironment,
  adminLogin,
  mapWithConcurrency,
  sameId,
} from './xprem-admin.mts';

// The admin-session API is undocumented: every path, method and payload here was
// read from the dashboard bundle named in xprem-admin.mts. These tests pin the
// requests OUR client makes, against a fake server, so an accidental edit to the
// client fails here. They cannot notice the real server changing: that is the
// job of scripts/ota-admin-api-probe.ts, which reads the live bundle.

const RTV = 'b'.repeat(40);
const ROLLOUT = `${FAKE_APP}/branch/production/runtimeVersion/${RTV}/rollout`;

describe('admin login', () => {
  it('posts the form the dashboard posts and returns the session token', async () => {
    const server = fakeXprem({ 'POST /auth/login': { token: 'jwt', refreshToken: 'refresh' } });
    await expect(
      adminLogin({
        baseUrl: FAKE_BASE_URL,
        email: 'ops@example.test',
        password: 'p&ss word',
        fetchImpl: server.fetchImpl,
      }),
    ).resolves.toBe('jwt');
    expect(server.requests[0]).toMatchObject({
      method: 'POST',
      path: '/auth/login',
      body: 'email=ops%40example.test&password=p%26ss+word',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });
  });

  it('fails on a refused login and on an answer without a token', async () => {
    const refused = fakeXprem({ 'POST /auth/login': { status: 401, body: { detail: 'bad credentials' } } });
    await expect(
      adminLogin({ baseUrl: FAKE_BASE_URL, email: 'a', password: 'b', fetchImpl: refused.fetchImpl }),
    ).rejects.toThrow('Admin login failed (HTTP 401)');
    const empty = fakeXprem({ 'POST /auth/login': {} });
    await expect(
      adminLogin({ baseUrl: FAKE_BASE_URL, email: 'a', password: 'b', fetchImpl: empty.fetchImpl }),
    ).rejects.toThrow('Admin login returned no token.');
  });

  it('derives the server origin from a manifest URL', () => {
    expect(adminBaseUrl('https://updates.example/manifest')).toBe('https://updates.example');
    expect(adminBaseUrl('https://updates.example/manifest/')).toBe('https://updates.example');
    expect(adminBaseUrl('https://updates.example//')).toBe('https://updates.example');
  });

  it('builds a client from the environment, and refuses without a login', async () => {
    const server = fakeXprem({ 'POST /auth/login': { token: 'jwt' }, [`GET ${FAKE_APP}/branches`]: [] });
    const client = await adminClientFromEnvironment({
      appId: 'app-1',
      defaultBaseUrl: 'https://unused.example',
      environment: {
        EXPO_UPDATES_URL: `${FAKE_BASE_URL}/manifest`,
        OTA_ADMIN_EMAIL: 'ops@example.test',
        OTA_ADMIN_PASSWORD: 'secret',
      },
      fetchImpl: server.fetchImpl,
    });
    await client.getBranches();
    expect(server.requests[1].headers.authorization).toBe('Bearer jwt');
    await expect(
      adminClientFromEnvironment({ appId: 'app-1', defaultBaseUrl: FAKE_BASE_URL, environment: {} }),
    ).rejects.toThrow('Set OTA_ADMIN_EMAIL and OTA_ADMIN_PASSWORD.');
  });
});

describe('admin client requests', () => {
  it('reads channels with their mapping, surfing and channel rollout', async () => {
    const server = fakeXprem({
      [`GET ${FAKE_APP}/channels`]: [
        {
          releaseChannelId: '3',
          releaseChannelName: 'production',
          branchId: '7',
          branchName: 'production',
          branchSurfing: { enabled: true, pattern: 'pr-*' },
          rollout: { percentage: 10, rolloutBranchName: 'next', defaultBranchName: 'production' },
        },
        { releaseChannelId: 9, releaseChannelName: 'empty' },
      ],
    });
    await expect(server.client.getChannels()).resolves.toEqual([
      {
        releaseChannelId: '3',
        releaseChannelName: 'production',
        branchId: '7',
        branchName: 'production',
        branchSurfing: { enabled: true, pattern: 'pr-*' },
        rollout: { percentage: 10, rolloutBranchName: 'next' },
      },
      {
        releaseChannelId: 9,
        releaseChannelName: 'empty',
        branchId: null,
        branchName: null,
        branchSurfing: null,
        rollout: null,
      },
    ]);
    expect(server.requests[0]).toMatchObject({ method: 'GET', headers: { authorization: 'Bearer session-jwt' } });
    expect(server.requests[0].body).toBeUndefined();
  });

  it('reads branches, treating an absent protection flag as unprotected', async () => {
    const server = fakeXprem({
      [`GET ${FAKE_APP}/branches`]: [
        { branchId: '7', branchName: 'production', protected: true },
        { branchId: 12033, branchName: 'pr-staging' },
        // The dashboard labels a branch with an empty id "Legacy".
        { branchId: '', branchName: 'old', protected: false },
      ],
    });
    await expect(server.client.getBranches()).resolves.toEqual([
      { branchId: '7', branchName: 'production', protected: true },
      { branchId: 12033, branchName: 'pr-staging', protected: false },
      { branchId: null, branchName: 'old', protected: false },
    ]);
  });

  it('reads the licence, which is not app-scoped', async () => {
    const server = fakeXprem({
      'GET /api/license': { valid: false, hasKey: true, validationErrorCode: 'expired', graceEndsAt: null },
    });
    await expect(server.client.getLicense()).resolves.toEqual({
      valid: false,
      hasKey: true,
      validationErrorCode: 'expired',
    });
    const licensed = fakeXprem({ 'GET /api/license': { valid: true, hasKey: true, orgName: 'Boardsesh' } });
    await expect(licensed.client.getLicense()).resolves.toEqual({
      valid: true,
      hasKey: true,
      validationErrorCode: null,
    });
  });

  it('pins every write: path, method and payload', async () => {
    const server = fakeXprem({
      [`POST ${FAKE_APP}/branches`]: { branchId: '99' },
      [`PUT ${FAKE_APP}/branches/pr-beta/protection`]: { status: 204 },
      [`POST ${FAKE_APP}/channels`]: { status: 204 },
      [`PUT ${FAKE_APP}/channels/production/branch-surfing`]: { status: 204 },
      [`POST ${FAKE_APP}/branch/99/updateChannelBranchMapping`]: { status: 204 },
      [`PUT ${ROLLOUT}`]: { status: 204 },
      [`POST ${ROLLOUT}/revert`]: { status: 204 },
    });
    await expect(server.client.createBranch('pr-beta')).resolves.toBe('99');
    await server.client.setBranchProtection('pr-beta', true);
    await server.client.createChannel('production', 'production');
    await server.client.setChannelBranchSurfing('production', true, 'pr-*');
    await server.client.mapChannelToBranch({ releaseChannelId: '3', releaseChannelName: 'production' }, '99');
    await server.client.setUpdateRolloutPercentage('production', RTV, 25, 17911745123242);
    await server.client.revertUpdateRollout('production', RTV, '17911745123242');

    expect(server.requests.map(({ method, path, body }) => ({ method, path, body }))).toEqual([
      { method: 'POST', path: `${FAKE_APP}/branches`, body: { branchName: 'pr-beta' } },
      { method: 'PUT', path: `${FAKE_APP}/branches/pr-beta/protection`, body: { protected: true } },
      { method: 'POST', path: `${FAKE_APP}/channels`, body: { channelName: 'production', branchName: 'production' } },
      {
        method: 'PUT',
        path: `${FAKE_APP}/channels/production/branch-surfing`,
        body: { enabled: true, pattern: 'pr-*' },
      },
      {
        method: 'POST',
        // Addressed by the target branch's ID, not its name.
        path: `${FAKE_APP}/branch/99/updateChannelBranchMapping`,
        body: { releaseChannelId: '3', releaseChannelName: 'production' },
      },
      // The id goes back exactly as it came: a number stays a number.
      { method: 'PUT', path: ROLLOUT, body: { percentage: 25, expectedUpdateId: 17911745123242 } },
      { method: 'POST', path: `${ROLLOUT}/revert`, body: { expectedUpdateId: '17911745123242' } },
    ]);
    for (const request of server.requests) expect(request.headers['content-type']).toBe('application/json');
  });

  it('reads runtime versions, a rollout and update details', async () => {
    const server = fakeXprem({
      [`GET ${FAKE_APP}/branch/production/runtimeVersions`]: [
        { runtimeVersion: RTV, numberOfUpdates: 6, lastUpdatedAt: '2026-10-05T04:29:17Z' },
      ],
      [`GET ${ROLLOUT}`]: {
        active: true,
        updates: [
          { updateId: 202, controlUpdateId: 201, platform: 'ios', percentage: 5, createdAt: '2026-10-05T22:00:00Z' },
        ],
      },
      [`GET ${FAKE_APP}/branch/production/runtimeVersion/${RTV}/updates/202`]: {
        updateId: 202,
        updateUUID: '43d5c1d5-ade8-62d9-1d01-9ffa9a169620',
        commitHash: 'a'.repeat(40),
        platform: 'ios',
      },
    });
    await expect(server.client.getRuntimeVersions('production')).resolves.toEqual([RTV]);
    await expect(server.client.getUpdateRollout('production', RTV)).resolves.toEqual({
      active: true,
      updates: [
        { updateId: 202, controlUpdateId: 201, platform: 'ios', percentage: 5, createdAt: '2026-10-05T22:00:00Z' },
      ],
    });
    await expect(server.client.getUpdateDetails('production', RTV, 202)).resolves.toEqual({
      updateId: 202,
      updateUUID: '43d5c1d5-ade8-62d9-1d01-9ffa9a169620',
      commitHash: 'a'.repeat(40),
      platform: 'ios',
    });
  });

  it('reads an inactive rollout that carries no update list', async () => {
    const server = fakeXprem({ [`GET ${ROLLOUT}`]: { active: false } });
    await expect(server.client.getUpdateRollout('production', RTV)).resolves.toEqual({ active: false, updates: [] });
  });

  it('reads health by update UUID, and issue counts from the newest history point', async () => {
    const canary = '43d5c1d5-ade8-62d9-1d01-9ffa9a169620';
    const control = '2d55b3b3-cc04-1a38-217b-92ec1ff5d2ff';
    const server = fakeXprem({
      [`GET ${FAKE_APP}/identity/update-health?ids=${canary}%2C${control}`]: {
        updates: {
          [canary]: { devicesOnUpdate: 20, successfulDevices: 18, faultyDevices: 2, healthPercent: 90 },
          [control]: { devicesOnUpdate: 300, successfulDevices: 299, faultyDevices: 1 },
        },
      },
      [`GET ${FAKE_APP}/observe/update-health/history?ids=${canary}`]: {
        source: 'snapshots',
        updates: {
          [canary]: [
            { timestamp: '2026-10-05T04:46:00Z', updateIssues: 4, runtimeIssues: 7 },
            { timestamp: '2026-10-05T04:37:00Z', updateIssues: 1, runtimeIssues: 2 },
          ],
        },
      },
    });
    await expect(server.client.getUpdateHealth([canary, control])).resolves.toEqual({
      [canary]: { devicesOnUpdate: 20, successfulDevices: 18, faultyDevices: 2 },
      [control]: { devicesOnUpdate: 300, successfulDevices: 299, faultyDevices: 1 },
    });
    await expect(server.client.getUpdateHealthHistory([canary])).resolves.toEqual({
      source: 'snapshots',
      latest: { [canary]: { timestamp: '2026-10-05T04:46:00Z', updateIssues: 4, runtimeIssues: 7 } },
    });
  });

  it('URL-encodes names in path segments', async () => {
    const server = fakeXprem({ [`PUT ${FAKE_APP}/branches/odd%2Fname/protection`]: { status: 204 } });
    await server.client.setBranchProtection('odd/name', true);
    expect(server.log()).toEqual([`PUT ${FAKE_APP}/branches/odd%2Fname/protection`]);
  });

  it('raises the HTTP status so a caller can tell a live-rollout refusal apart', async () => {
    const server = fakeXprem({ [`PUT ${ROLLOUT}`]: { status: 409, body: { detail: 'update changed' } } });
    const failure = await server.client.setUpdateRolloutPercentage('production', RTV, 10, 1).catch((error) => error);
    expect(failure).toBeInstanceOf(XpremApiError);
    expect((failure as XpremApiError).status).toBe(409);
    expect((failure as XpremApiError).message).toContain('Set rollout percentage failed (HTTP 409)');
  });

  it('rejects a list endpoint that answers with something else', async () => {
    const server = fakeXprem({ [`GET ${FAKE_APP}/channels`]: { channels: [] } });
    await expect(server.client.getChannels()).rejects.toThrow('xprem channel list is not a list.');
  });
});

describe('helpers', () => {
  it('compares ids across the string and number forms the server uses', () => {
    expect(sameId('17911745123242', 17911745123242)).toBe(true);
    expect(sameId('17', 18)).toBe(false);
  });

  it('maps with bounded concurrency and keeps input order', async () => {
    let inFlight = 0;
    let peak = 0;
    const doubled = await mapWithConcurrency([1, 2, 3, 4, 5, 6, 7], 3, async (item) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((done) => setTimeout(done, 1));
      inFlight--;
      return item * 2;
    });
    expect(doubled).toEqual([2, 4, 6, 8, 10, 12, 14]);
    expect(peak).toBe(3);
  });
});
