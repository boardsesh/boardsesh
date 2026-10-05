/// <reference types="node" />

import { describe, expect, it } from 'vitest';
import { otaReleasePolicy } from '../../infra/ota/config';
import { FAKE_APP, fakeXprem } from '../__tests__/helpers/fake-xprem';
import type { FakeRoute } from '../__tests__/helpers/fake-xprem';
import { judgeCanary, listActiveRollouts, readRolloutHealth, revertRollout, setRolloutPercentage } from './ota-rollout';

const IOS_RTV = 'a'.repeat(40);
const ANDROID_RTV = 'b'.repeat(40);
const OLD_RTV = 'c'.repeat(40);
const rolloutPath = (runtimeVersion: string): string =>
  `${FAKE_APP}/branch/production/runtimeVersion/${runtimeVersion}/rollout`;

const POLICY = otaReleasePolicy.health;

/** A rollout endpoint whose state the test's own PUT and POST calls change. */
function statefulRollout(
  runtimeVersion: string,
  updates: { updateId: number; platform: string; percentage: number }[],
): Record<string, FakeRoute> {
  let live = updates.map((update) => ({ ...update, controlUpdateId: update.updateId - 1 }));
  return {
    [`GET ${rolloutPath(runtimeVersion)}`]: () => ({ active: live.length > 0, updates: live }),
    [`PUT ${rolloutPath(runtimeVersion)}`]: (request) => {
      const body = request.body as { percentage: number; expectedUpdateId: number };
      live =
        body.percentage === 100
          ? live.filter((update) => update.updateId !== body.expectedUpdateId)
          : live.map((update) =>
              update.updateId === body.expectedUpdateId ? { ...update, percentage: body.percentage } : update,
            );
      return { status: 204 };
    },
    [`POST ${rolloutPath(runtimeVersion)}/revert`]: (request) => {
      const body = request.body as { expectedUpdateId: number };
      live = live.filter((update) => update.updateId !== body.expectedUpdateId);
      return { status: 204 };
    },
  };
}

describe('listActiveRollouts', () => {
  it('walks every runtime version of the branch, so a rollout on an old one is found', async () => {
    const server = fakeXprem({
      [`GET ${FAKE_APP}/branch/production/runtimeVersions`]: [
        { runtimeVersion: IOS_RTV },
        { runtimeVersion: ANDROID_RTV },
        { runtimeVersion: OLD_RTV },
      ],
      [`GET ${rolloutPath(IOS_RTV)}`]: {
        active: true,
        updates: [{ updateId: 11, controlUpdateId: 10, platform: 'ios', percentage: 25 }],
      },
      [`GET ${rolloutPath(ANDROID_RTV)}`]: { active: false, updates: [] },
      [`GET ${rolloutPath(OLD_RTV)}`]: {
        active: true,
        updates: [{ updateId: 5, platform: 'android', percentage: 5 }],
      },
    });
    await expect(listActiveRollouts(server.client, 'production')).resolves.toEqual([
      {
        branch: 'production',
        runtimeVersion: IOS_RTV,
        platform: 'ios',
        updateId: 11,
        controlUpdateId: 10,
        percentage: 25,
        createdAt: null,
      },
      {
        branch: 'production',
        runtimeVersion: OLD_RTV,
        platform: 'android',
        updateId: 5,
        controlUpdateId: null,
        percentage: 5,
        createdAt: null,
      },
    ]);
    expect(server.log().sort()).toEqual(
      [
        `GET ${FAKE_APP}/branch/production/runtimeVersions`,
        `GET ${rolloutPath(IOS_RTV)}`,
        `GET ${rolloutPath(ANDROID_RTV)}`,
        `GET ${rolloutPath(OLD_RTV)}`,
      ].sort(),
    );
  });
});

describe('setRolloutPercentage', () => {
  it('sends the update id it just read as expectedUpdateId', async () => {
    const server = fakeXprem(statefulRollout(IOS_RTV, [{ updateId: 11, platform: 'ios', percentage: 5 }]));
    const changed = await setRolloutPercentage(
      server.client,
      { branch: 'production', runtimeVersion: IOS_RTV, platform: 'all' },
      10,
    );
    expect(changed.map(({ platform, percentage }) => ({ platform, percentage }))).toEqual([
      { platform: 'ios', percentage: 10 },
    ]);
    const writes = server.requests.filter((request) => request.method !== 'GET');
    expect(writes.map(({ method, path, body }) => ({ method, path, body }))).toEqual([
      { method: 'PUT', path: rolloutPath(IOS_RTV), body: { percentage: 10, expectedUpdateId: 11 } },
    ]);
  });

  it('finishes with percentage 100, once per platform sharing a runtime version', async () => {
    const server = fakeXprem(
      statefulRollout(IOS_RTV, [
        { updateId: 11, platform: 'ios', percentage: 50 },
        { updateId: 12, platform: 'android', percentage: 50 },
      ]),
    );
    await setRolloutPercentage(server.client, { branch: 'production', runtimeVersion: IOS_RTV, platform: 'all' }, 100);
    expect(server.requests.filter((request) => request.method === 'PUT').map((request) => request.body)).toEqual([
      { percentage: 100, expectedUpdateId: 11 },
      { percentage: 100, expectedUpdateId: 12 },
    ]);
  });

  it('does not write again when one call already moved the other platform', async () => {
    let percentage = 5;
    const server = fakeXprem({
      [`GET ${rolloutPath(IOS_RTV)}`]: () => ({
        active: true,
        updates: [
          { updateId: 11, platform: 'ios', percentage },
          { updateId: 12, platform: 'android', percentage },
        ],
      }),
      // A server whose single write moves every platform on the runtime version.
      [`PUT ${rolloutPath(IOS_RTV)}`]: () => {
        percentage = 10;
        return { status: 204 };
      },
    });
    await setRolloutPercentage(server.client, { branch: 'production', runtimeVersion: IOS_RTV, platform: 'all' }, 10);
    expect(server.requests.filter((request) => request.method === 'PUT')).toHaveLength(1);
  });

  it('acts on one platform only when asked', async () => {
    const server = fakeXprem(
      statefulRollout(IOS_RTV, [
        { updateId: 11, platform: 'ios', percentage: 5 },
        { updateId: 12, platform: 'android', percentage: 5 },
      ]),
    );
    await setRolloutPercentage(
      server.client,
      { branch: 'production', runtimeVersion: IOS_RTV, platform: 'android' },
      25,
    );
    expect(server.requests.filter((request) => request.method === 'PUT').map((request) => request.body)).toEqual([
      { percentage: 25, expectedUpdateId: 12 },
    ]);
  });

  it('refuses without writing: no rollout, another update, a decrease, a bad percentage', async () => {
    const target = { branch: 'production', runtimeVersion: IOS_RTV, platform: 'all' as const };
    const idle = fakeXprem({ [`GET ${rolloutPath(IOS_RTV)}`]: { active: false } });
    await expect(setRolloutPercentage(idle.client, target, 10)).rejects.toThrow('No live rollout');

    const live = fakeXprem(statefulRollout(IOS_RTV, [{ updateId: 11, platform: 'ios', percentage: 25 }]));
    await expect(setRolloutPercentage(live.client, { ...target, expectedUpdateId: '99' }, 50)).rejects.toThrow(
      'The live rollout is update 11, not 99. Nothing was changed.',
    );
    await expect(setRolloutPercentage(live.client, target, 10)).rejects.toThrow('A rollout cannot be decreased');
    await expect(setRolloutPercentage(live.client, target, 0)).rejects.toThrow('whole number from 1 to 100');
    await expect(setRolloutPercentage(live.client, target, 12.5)).rejects.toThrow('whole number from 1 to 100');
    expect(live.requests.every((request) => request.method === 'GET')).toBe(true);
  });
});

describe('revertRollout', () => {
  it('posts to the revert endpoint with the live update id', async () => {
    const server = fakeXprem(statefulRollout(ANDROID_RTV, [{ updateId: 31, platform: 'android', percentage: 50 }]));
    const reverted = await revertRollout(server.client, {
      branch: 'production',
      runtimeVersion: ANDROID_RTV,
      platform: 'all',
      expectedUpdateId: '31',
    });
    expect(reverted).toHaveLength(1);
    const writes = server.requests.filter((request) => request.method !== 'GET');
    expect(writes.map(({ method, path, body }) => ({ method, path, body }))).toEqual([
      { method: 'POST', path: `${rolloutPath(ANDROID_RTV)}/revert`, body: { expectedUpdateId: 31 } },
    ]);
  });
});

describe('judgeCanary', () => {
  const control = { devicesOnUpdate: 300, successfulDevices: 297, faultyDevices: 3 };

  it('is healthy with enough devices and a faulty rate within the margin of the control', () => {
    const canary = { devicesOnUpdate: 40, successfulDevices: 39, faultyDevices: 1 };
    expect(judgeCanary(canary, control, POLICY).verdict).toBe('healthy');
  });

  it('is unhealthy when the faulty rate clears the margin on enough faulty devices', () => {
    const canary = { devicesOnUpdate: 40, successfulDevices: 34, faultyDevices: 6 };
    expect(judgeCanary(canary, control, POLICY)).toEqual({
      verdict: 'unhealthy',
      reason: 'Canary is 15.0% faulty (6 of 40) against an allowed 3.0%.',
    });
  });

  it('calls a crash-looping canary unhealthy below the evidence floor', () => {
    // Faulty devices fall back to the embedded bundle and stop counting as on the update.
    const canary = { devicesOnUpdate: 1, successfulDevices: 1, faultyDevices: 4 };
    expect(judgeCanary(canary, control, POLICY).verdict).toBe('unhealthy');
  });

  it('never treats too little evidence as healthy', () => {
    const spotless = { devicesOnUpdate: 14, successfulDevices: 14, faultyDevices: 0 };
    expect(judgeCanary(spotless, control, POLICY)).toEqual({
      verdict: 'insufficient-evidence',
      reason: '14 device(s) have reported on the canary; 15 are needed.',
    });
    expect(judgeCanary(null, control, POLICY).verdict).toBe('insufficient-evidence');
    // Devices are on the update, but none has reported an outcome yet.
    const silent = { devicesOnUpdate: 60, successfulDevices: 0, faultyDevices: 0 };
    expect(judgeCanary(silent, control, POLICY).verdict).toBe('insufficient-evidence');
  });

  it('holds, and does not pass, a canary over the margin on too few faulty devices', () => {
    const canary = { devicesOnUpdate: 20, successfulDevices: 18, faultyDevices: 2 };
    expect(judgeCanary(canary, control, POLICY).verdict).toBe('insufficient-evidence');
  });

  it('judges against the control, so a fleet that is already faulty does not fail the canary', () => {
    const roughControl = { devicesOnUpdate: 300, successfulDevices: 270, faultyDevices: 30 };
    const canary = { devicesOnUpdate: 50, successfulDevices: 45, faultyDevices: 5 };
    expect(judgeCanary(canary, roughControl, POLICY).verdict).toBe('healthy');
    expect(judgeCanary(canary, control, POLICY).verdict).toBe('unhealthy');
  });

  it('treats a missing control as a 0% baseline, making the margin an absolute cap', () => {
    const clean = { devicesOnUpdate: 100, successfulDevices: 99, faultyDevices: 1 };
    const rough = { devicesOnUpdate: 100, successfulDevices: 95, faultyDevices: 5 };
    expect(judgeCanary(clean, null, POLICY).verdict).toBe('healthy');
    expect(judgeCanary(rough, null, POLICY).verdict).toBe('unhealthy');
  });
});

describe('readRolloutHealth', () => {
  it('resolves numeric update ids to UUIDs and judges each platform', async () => {
    const canaryUUID = '43d5c1d5-ade8-62d9-1d01-9ffa9a169620';
    const controlUUID = '2d55b3b3-cc04-1a38-217b-92ec1ff5d2ff';
    const updates = `${FAKE_APP}/branch/production/runtimeVersion/${IOS_RTV}/updates`;
    const server = fakeXprem({
      [`GET ${rolloutPath(IOS_RTV)}`]: {
        active: true,
        updates: [{ updateId: 11, controlUpdateId: 10, platform: 'ios', percentage: 50 }],
      },
      [`GET ${updates}/11`]: { updateId: 11, updateUUID: canaryUUID },
      [`GET ${updates}/10`]: { updateId: 10, updateUUID: controlUUID },
      [`GET ${FAKE_APP}/identity/update-health?ids=${canaryUUID}%2C${controlUUID}`]: {
        updates: {
          [canaryUUID]: { devicesOnUpdate: 30, successfulDevices: 30, faultyDevices: 0 },
          [controlUUID]: { devicesOnUpdate: 200, successfulDevices: 199, faultyDevices: 1 },
        },
      },
      [`GET ${FAKE_APP}/observe/update-health/history?ids=${canaryUUID}`]: {
        source: 'snapshots',
        updates: { [canaryUUID]: [{ timestamp: '2026-10-05T04:46:00Z', updateIssues: 0, runtimeIssues: 2 }] },
      },
    });
    const [health] = await readRolloutHealth(server.client, 'production', IOS_RTV, POLICY);
    expect(health).toMatchObject({
      canaryUpdateUUID: canaryUUID,
      controlUpdateUUID: controlUUID,
      canary: { devicesOnUpdate: 30, successfulDevices: 30, faultyDevices: 0 },
      canaryIssues: { updateIssues: 0, runtimeIssues: 2 },
      judgement: { verdict: 'healthy' },
    });
  });

  it('reports insufficient evidence when the server has no health row for the canary', async () => {
    const canaryUUID = '43d5c1d5-ade8-62d9-1d01-9ffa9a169620';
    const server = fakeXprem({
      [`GET ${rolloutPath(IOS_RTV)}`]: { active: true, updates: [{ updateId: 11, platform: 'ios', percentage: 5 }] },
      [`GET ${FAKE_APP}/branch/production/runtimeVersion/${IOS_RTV}/updates/11`]: { updateUUID: canaryUUID },
      [`GET ${FAKE_APP}/identity/update-health?ids=${canaryUUID}`]: { updates: {} },
      [`GET ${FAKE_APP}/observe/update-health/history?ids=${canaryUUID}`]: { source: 'state', updates: {} },
    });
    const [health] = await readRolloutHealth(server.client, 'production', IOS_RTV, POLICY);
    expect(health.judgement.verdict).toBe('insufficient-evidence');
    expect(health.canaryIssues).toBeNull();
  });
});
