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

describe('a rollout that changes under the tool', () => {
  const target = { branch: 'production', runtimeVersion: IOS_RTV, platform: 'all' as const };
  /** Live on the first read, gone on every read after it. */
  const vanishing = (): ReturnType<typeof fakeXprem> => {
    let reads = 0;
    return fakeXprem({
      [`GET ${rolloutPath(IOS_RTV)}`]: () =>
        reads++ === 0
          ? { active: true, updates: [{ updateId: 11, platform: 'ios', percentage: 50 }] }
          : { active: false },
    });
  };

  it('finish does not report success for a rollout that vanished before its first write', async () => {
    const server = vanishing();
    await expect(setRolloutPercentage(server.client, target, 100)).rejects.toThrow(
      'Update 11 stopped rolling out on "production" before anything was written. Nothing was changed.',
    );
    expect(server.requests.every((request) => request.method === 'GET')).toBe(true);
  });

  it('finish tolerates a second platform that its own first write ended', async () => {
    let live = [
      { updateId: 11, platform: 'ios', percentage: 50 },
      { updateId: 12, platform: 'android', percentage: 50 },
    ];
    const server = fakeXprem({
      [`GET ${rolloutPath(IOS_RTV)}`]: () => ({ active: live.length > 0, updates: live }),
      // A server whose single write finishes every platform on the runtime version.
      [`PUT ${rolloutPath(IOS_RTV)}`]: () => {
        live = [];
        return { status: 204 };
      },
    });
    const finished = await setRolloutPercentage(server.client, target, 100);
    expect(finished.map((rollout) => rollout.platform)).toEqual(['ios']);
    expect(server.requests.filter((request) => request.method === 'PUT')).toHaveLength(1);
  });

  it('revert fails on a vanished rollout, unless nothing live is an acceptable answer', async () => {
    await expect(revertRollout(vanishing().client, target)).rejects.toThrow('stopped rolling out');
    const tolerant = vanishing();
    await expect(revertRollout(tolerant.client, target, { allowNone: true })).resolves.toEqual([]);
    expect(tolerant.requests.every((request) => request.method === 'GET')).toBe(true);
  });

  it('revert with allowNone answers from one read when nothing is live', async () => {
    const server = fakeXprem({ [`GET ${rolloutPath(IOS_RTV)}`]: { active: false } });
    await expect(revertRollout(server.client, target, { allowNone: true })).resolves.toEqual([]);
    expect(server.requests).toHaveLength(1);
    await expect(revertRollout(server.client, target)).rejects.toThrow('No live rollout');
  });

  it('revert with allowNone still fails when the write is refused and the rollout is still live', async () => {
    const server = fakeXprem({
      [`GET ${rolloutPath(IOS_RTV)}`]: { active: true, updates: [{ updateId: 11, platform: 'ios', percentage: 50 }] },
      [`POST ${rolloutPath(IOS_RTV)}/revert`]: { status: 500, body: { detail: 'boom' } },
    });
    await expect(revertRollout(server.client, target, { allowNone: true })).rejects.toThrow('HTTP 500');
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
  const verdict = (
    canary: Parameters<typeof judgeCanary>[0],
    against: Parameters<typeof judgeCanary>[1] = control,
  ): string => judgeCanary(canary, against, POLICY).verdict;

  it('is healthy with enough devices and a faulty rate within the margin of the control', () => {
    const canary = { devicesOnUpdate: 40, successfulDevices: 39, faultyDevices: 1 };
    expect(judgeCanary(canary, control, POLICY)).toEqual({
      verdict: 'healthy',
      reason:
        'Healthy: 2.5% faulty (1 of 40 reporting devices), within the allowed 3.0% (control at 1.0% plus 2 points).',
    });
  });

  it('is unhealthy when the faulty rate clears the allowed rate on enough faulty devices', () => {
    const canary = { devicesOnUpdate: 40, successfulDevices: 34, faultyDevices: 6 };
    expect(judgeCanary(canary, control, POLICY)).toEqual({
      verdict: 'unhealthy',
      reason:
        'Unhealthy: 15.0% faulty (6 of 40 reporting devices), over the allowed 3.0% (control at 1.0% plus 2 points), on at least 3 faulty devices.',
    });
  });

  // The three cases a review reproduced as "healthy" before the control was
  // required to be large enough to mean something, and capped.
  it.each([
    ['15 of 15 faulty against a control of 1 of 1', [15, 0, 15], [1, 0, 1]],
    ['20 of 20 faulty against a control of 3 of 3', [20, 0, 20], [3, 0, 3]],
    ['7 of 15 faulty against a control of 1 of 2', [15, 8, 7], [2, 1, 1]],
  ] as const)('is unhealthy: %s', (_label, canaryCounts, controlCounts) => {
    const cohort = ([devicesOnUpdate, successfulDevices, faultyDevices]: readonly number[]) => ({
      devicesOnUpdate,
      successfulDevices,
      faultyDevices,
    });
    expect(verdict(cohort(canaryCounts), cohort(controlCounts))).toBe('unhealthy');
  });

  it('ignores a control below the evidence floor, however it looks', () => {
    const canary = { devicesOnUpdate: 40, successfulDevices: 38, faultyDevices: 2 };
    const tinyBadControl = { devicesOnUpdate: 14, successfulDevices: 0, faultyDevices: 14 };
    // 5.0% against 0% + 2 points: over, on two faulty devices, so it holds.
    expect(judgeCanary(canary, tinyBadControl, POLICY)).toEqual({
      verdict: 'insufficient-evidence',
      reason:
        'Not enough evidence: 5.0% faulty (2 of 40 reporting devices) is over the allowed 2.0% (no usable control, so 0% plus 2 points), but on fewer than 3 faulty devices.',
    });
  });

  it('caps the allowed rate, so a broken control cannot wave a broken canary through', () => {
    const brokenControl = { devicesOnUpdate: 300, successfulDevices: 150, faultyDevices: 150 };
    const canary = { devicesOnUpdate: 50, successfulDevices: 45, faultyDevices: 5 };
    expect(judgeCanary(canary, brokenControl, POLICY)).toEqual({
      verdict: 'unhealthy',
      reason:
        'Unhealthy: 10.0% faulty (5 of 50 reporting devices), over the 5.0% cap (control at 50.0% plus 2 points would allow 52.0%), on at least 3 faulty devices.',
    });
    // Within the cap, a canary no worse than a rough control passes.
    const roughControl = { devicesOnUpdate: 300, successfulDevices: 288, faultyDevices: 12 };
    const steady = { devicesOnUpdate: 50, successfulDevices: 48, faultyDevices: 2 };
    expect(verdict(steady, roughControl)).toBe('healthy');
  });

  it('never treats too little evidence as healthy', () => {
    const spotless = { devicesOnUpdate: 14, successfulDevices: 14, faultyDevices: 0 };
    expect(judgeCanary(spotless, control, POLICY)).toEqual({
      verdict: 'insufficient-evidence',
      reason: 'Not enough evidence: 14 device(s) have reported on the canary and 15 are needed.',
    });
    expect(verdict(null)).toBe('insufficient-evidence');
    // Devices are on the update, but none has reported an outcome yet.
    expect(verdict({ devicesOnUpdate: 60, successfulDevices: 0, faultyDevices: 0 })).toBe('insufficient-evidence');
    // Nothing at all.
    expect(verdict({ devicesOnUpdate: 0, successfulDevices: 0, faultyDevices: 0 })).toBe('insufficient-evidence');
  });

  it('below the floor, is unhealthy only on enough faulty devices at a very high rate', () => {
    // 4 of 10 = 40%, at or over the 30% small-sample threshold, on 4 faulty devices.
    // The reason quotes the threshold that fired, not the control-based allowance.
    expect(judgeCanary({ devicesOnUpdate: 10, successfulDevices: 6, faultyDevices: 4 }, control, POLICY)).toEqual({
      verdict: 'unhealthy',
      reason:
        'Unhealthy on a small sample: 40.0% faulty (4 of 10 reporting devices) against the 30% small-sample ' +
        'threshold, on at least 3 faulty devices. Only 10 of the 15 devices a normal verdict needs have reported.',
    });
    // 3 of 12 = 25%: far over the allowed rate, but under the small-sample threshold.
    expect(verdict({ devicesOnUpdate: 12, successfulDevices: 9, faultyDevices: 3 })).toBe('insufficient-evidence');
    // 2 of 2 = 100%, on fewer than three faulty devices.
    expect(verdict({ devicesOnUpdate: 2, successfulDevices: 0, faultyDevices: 2 })).toBe('insufficient-evidence');
  });

  it('holds, and does not pass, a canary over the allowed rate on too few faulty devices', () => {
    expect(verdict({ devicesOnUpdate: 20, successfulDevices: 18, faultyDevices: 2 })).toBe('insufficient-evidence');
  });

  it('treats a missing control as a 0% baseline, making the margin an absolute cap', () => {
    const clean = { devicesOnUpdate: 100, successfulDevices: 99, faultyDevices: 1 };
    const rough = { devicesOnUpdate: 100, successfulDevices: 95, faultyDevices: 5 };
    expect(verdict(clean, null)).toBe('healthy');
    expect(verdict(rough, null)).toBe('unhealthy');
  });

  it('calls more faulty devices than devices on the update a crash loop, on enough faulty devices', () => {
    // A crash at launch falls back to the embedded bundle: the device stops
    // counting as on the update while its failure is still recorded.
    expect(judgeCanary({ devicesOnUpdate: 1, successfulDevices: 1, faultyDevices: 4 }, control, POLICY)).toEqual({
      verdict: 'unhealthy',
      reason:
        'Unhealthy: 4 faulty device(s) against 1 on the update (100.0% of 4). More faulty devices than devices on ' +
        'the update is what a crash loop that falls back to the embedded bundle produces, and 4 meets the minimum of 3 faulty devices.',
    });
    // Nothing reported successful at all, and nothing left on the update.
    expect(verdict({ devicesOnUpdate: 0, successfulDevices: 0, faultyDevices: 20 })).toBe('unhealthy');
    // Holds whatever the control looks like: this rule does not compare rates.
    expect(verdict({ devicesOnUpdate: 2, successfulDevices: 40, faultyDevices: 3 }, null)).toBe('unhealthy');
  });

  it('does not call it a crash loop on fewer faulty devices than the minimum', () => {
    expect(judgeCanary({ devicesOnUpdate: 1, successfulDevices: 30, faultyDevices: 2 }, control, POLICY)).toEqual({
      verdict: 'insufficient-evidence',
      reason:
        'Not enough evidence: 2 faulty device(s) against 1 on the update (100.0% of 2). More faulty devices than ' +
        'devices on the update is what a crash loop that falls back to the embedded bundle produces, but 2 is below the minimum of 3 faulty devices.',
    });
    expect(verdict({ devicesOnUpdate: 0, successfulDevices: 0, faultyDevices: 1 })).toBe('insufficient-evidence');
  });

  it('names the rule behind every verdict', () => {
    const reasons = [
      judgeCanary(null, control, POLICY),
      judgeCanary({ devicesOnUpdate: Number.NaN, successfulDevices: 1, faultyDevices: 0 }, control, POLICY),
      judgeCanary({ devicesOnUpdate: 40, successfulDevices: 40, faultyDevices: 0 }, control, {
        ...POLICY,
        minFaultyDevicesToFail: Number.NaN,
      }),
    ].map((judgement) => judgement.reason);
    expect(reasons).toEqual([
      'Not enough evidence: the server reports no health for the canary update.',
      'Not enough evidence: the canary health counts are not finite, non-negative numbers.',
      'Not judged: the health policy holds a value that is not a finite, non-negative number.',
    ]);
  });

  it('refuses to judge numbers it cannot trust', () => {
    const usable = { devicesOnUpdate: 40, successfulDevices: 40, faultyDevices: 0 };
    expect(verdict(usable)).toBe('healthy');
    for (const broken of [
      { ...usable, devicesOnUpdate: Number.NaN },
      { ...usable, successfulDevices: Number.NaN },
      { ...usable, faultyDevices: Number.POSITIVE_INFINITY },
      { ...usable, successfulDevices: -1 },
      { ...usable, faultyDevices: '3' as unknown as number },
    ]) {
      expect(verdict(broken), JSON.stringify(broken)).toBe('insufficient-evidence');
    }
    // An unusable control is no control: the cap still applies.
    const nanControl = { devicesOnUpdate: 300, successfulDevices: Number.NaN, faultyDevices: 3 };
    expect(verdict(usable, nanControl)).toBe('healthy');
    expect(verdict({ devicesOnUpdate: 50, successfulDevices: 45, faultyDevices: 5 }, nanControl)).toBe('unhealthy');
    // A policy with a hole in it judges nothing.
    expect(judgeCanary(usable, control, { ...POLICY, maxFaultyRatePercent: Number.NaN }).verdict).toBe(
      'insufficient-evidence',
    );
  });
});

describe('readRolloutHealth', () => {
  it('resolves numeric update ids to UUIDs and judges each platform on its own numbers', async () => {
    const uuids = {
      iosCanary: '43d5c1d5-ade8-62d9-1d01-9ffa9a169620',
      iosControl: '2d55b3b3-cc04-1a38-217b-92ec1ff5d2ff',
      androidCanary: 'aaaaaaaa-ade8-62d9-1d01-9ffa9a169620',
      androidControl: 'bbbbbbbb-cc04-1a38-217b-92ec1ff5d2ff',
    };
    const updates = `${FAKE_APP}/branch/production/runtimeVersion/${IOS_RTV}/updates`;
    const healthy = { devicesOnUpdate: 30, successfulDevices: 30, faultyDevices: 0 };
    const bigControl = { devicesOnUpdate: 200, successfulDevices: 199, faultyDevices: 1 };
    const history = (uuid: string, runtimeIssues: number) => ({
      source: 'snapshots',
      updates: { [uuid]: [{ timestamp: '2026-10-05T04:46:00Z', updateIssues: 0, runtimeIssues }] },
    });
    const server = fakeXprem({
      [`GET ${rolloutPath(IOS_RTV)}`]: {
        active: true,
        updates: [
          { updateId: 11, controlUpdateId: 10, platform: 'ios', percentage: 50 },
          { updateId: 21, controlUpdateId: 20, platform: 'android', percentage: 50 },
        ],
      },
      [`GET ${updates}/11`]: { updateId: 11, updateUUID: uuids.iosCanary },
      [`GET ${updates}/10`]: { updateId: 10, updateUUID: uuids.iosControl },
      [`GET ${updates}/21`]: { updateId: 21, updateUUID: uuids.androidCanary },
      [`GET ${updates}/20`]: { updateId: 20, updateUUID: uuids.androidControl },
      [`GET ${FAKE_APP}/identity/update-health?ids=${uuids.iosCanary}%2C${uuids.iosControl}`]: {
        updates: { [uuids.iosCanary]: healthy, [uuids.iosControl]: bigControl },
      },
      [`GET ${FAKE_APP}/identity/update-health?ids=${uuids.androidCanary}%2C${uuids.androidControl}`]: {
        updates: {
          [uuids.androidCanary]: { devicesOnUpdate: 30, successfulDevices: 22, faultyDevices: 8 },
          [uuids.androidControl]: bigControl,
        },
      },
      [`GET ${FAKE_APP}/observe/update-health/history?ids=${uuids.iosCanary}`]: history(uuids.iosCanary, 2),
      [`GET ${FAKE_APP}/observe/update-health/history?ids=${uuids.androidCanary}`]: history(uuids.androidCanary, 9),
    });
    const [ios, android] = await readRolloutHealth(server.client, 'production', IOS_RTV, POLICY);
    expect(ios).toMatchObject({
      canaryUpdateUUID: uuids.iosCanary,
      controlUpdateUUID: uuids.iosControl,
      canary: healthy,
      canaryIssues: { updateIssues: 0, runtimeIssues: 2 },
      judgement: { verdict: 'healthy' },
    });
    // One platform passing says nothing about the other.
    expect(android).toMatchObject({
      rollout: { platform: 'android' },
      canaryIssues: { updateIssues: 0, runtimeIssues: 9 },
      judgement: { verdict: 'unhealthy' },
    });
  });

  it('holds a platform whose canary has no update UUID, without reading health for it', async () => {
    const controlUUID = '2d55b3b3-cc04-1a38-217b-92ec1ff5d2ff';
    const updates = `${FAKE_APP}/branch/production/runtimeVersion/${IOS_RTV}/updates`;
    const server = fakeXprem({
      [`GET ${rolloutPath(IOS_RTV)}`]: {
        active: true,
        updates: [{ updateId: 11, controlUpdateId: 10, platform: 'ios', percentage: 5 }],
      },
      // Details exist, but carry no UUID: health is keyed on it, so there is nothing to ask for.
      [`GET ${updates}/11`]: { updateId: 11 },
      [`GET ${updates}/10`]: { updateId: 10, updateUUID: controlUUID },
    });
    await expect(readRolloutHealth(server.client, 'production', IOS_RTV, POLICY)).resolves.toEqual([
      {
        rollout: expect.objectContaining({ platform: 'ios', updateId: 11 }),
        canaryUpdateUUID: null,
        controlUpdateUUID: controlUUID,
        canary: null,
        control: null,
        canaryIssues: null,
        judgement: {
          verdict: 'insufficient-evidence',
          reason: 'Not enough evidence: update 11 has no update UUID, so its health cannot be read.',
        },
      },
    ]);
    expect(server.log().some((entry) => entry.includes('update-health'))).toBe(false);
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
