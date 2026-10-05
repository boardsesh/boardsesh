/// <reference types="node" />

import { describe, expect, it } from 'vitest';
import { otaReleasePolicy } from '../infra/ota/config';
import { FAKE_APP, fakeXprem } from './__tests__/helpers/fake-xprem';
import { parseRolloutArgs, runRolloutCommand } from './mobile-ota-rollout';

const RTV = 'a'.repeat(40);
const OTHER_RTV = 'b'.repeat(40);
const POLICY = otaReleasePolicy.health;
const rolloutPath = (branch: string, runtimeVersion: string): string =>
  `${FAKE_APP}/branch/${branch}/runtimeVersion/${runtimeVersion}/rollout`;
const LIVE = { active: true, updates: [{ updateId: 11, controlUpdateId: 10, platform: 'ios', percentage: 5 }] };

describe('parseRolloutArgs', () => {
  it('defaults to the production branch and every platform', () => {
    expect(parseRolloutArgs(['status'])).toEqual({
      command: 'status',
      branch: 'production',
      runtimeVersion: null,
      platform: 'all',
      percentage: null,
      expectedUpdateId: null,
      updateUUID: null,
      controlUpdateUUID: null,
      json: false,
      ifLive: false,
    });
  });

  it('reads every flag', () => {
    expect(
      parseRolloutArgs([
        '--',
        'set',
        '--branch',
        'pr-rollout-test',
        '--runtime-version',
        RTV,
        '--platform',
        'android',
        '--percentage',
        '25',
        '--expected-update-id',
        '17911745123242',
      ]),
    ).toMatchObject({
      command: 'set',
      branch: 'pr-rollout-test',
      runtimeVersion: RTV,
      platform: 'android',
      percentage: 25,
      expectedUpdateId: '17911745123242',
    });
  });

  it('refuses what would be ambiguous or dangerous', () => {
    expect(() => parseRolloutArgs([])).toThrow('Unknown command');
    expect(() => parseRolloutArgs(['delete'])).toThrow('Unknown command "delete"');
    expect(() => parseRolloutArgs(['status', '--force'])).toThrow('Unknown argument: --force');
    expect(() => parseRolloutArgs(['status', '--branch'])).toThrow('--branch needs a value');
    expect(() => parseRolloutArgs(['status', '--platform', 'web'])).toThrow('--platform must be');
    // 100 is a different act with its own command.
    expect(() => parseRolloutArgs(['set', '--runtime-version', RTV, '--percentage', '100'])).toThrow('Use finish');
    expect(() => parseRolloutArgs(['set', '--runtime-version', RTV])).toThrow('set needs --percentage');
    expect(() => parseRolloutArgs(['set', '--percentage', '10'])).toThrow('set needs --runtime-version');
    expect(() => parseRolloutArgs(['finish'])).toThrow('finish needs --runtime-version');
    expect(() => parseRolloutArgs(['revert'])).toThrow('revert needs --runtime-version');
    expect(() => parseRolloutArgs(['finish', '--runtime-version', RTV, '--percentage', '50'])).toThrow(
      '--percentage only applies to set',
    );
    expect(() => parseRolloutArgs(['status', '--if-live'])).toThrow('--if-live only applies to revert');
    expect(() => parseRolloutArgs(['health'])).toThrow('health needs --runtime-version or --update-id');
    expect(() => parseRolloutArgs(['health', '--update-id', '17911745123242'])).toThrow('must be an update UUID');
  });
});

describe('runRolloutCommand', () => {
  it('status without a runtime version walks every one, per platform', async () => {
    const server = fakeXprem({
      [`GET ${FAKE_APP}/branch/production/runtimeVersions`]: [{ runtimeVersion: RTV }, { runtimeVersion: OTHER_RTV }],
      [`GET ${rolloutPath('production', RTV)}`]: LIVE,
      [`GET ${rolloutPath('production', OTHER_RTV)}`]: {
        active: true,
        updates: [{ updateId: 21, platform: 'android', percentage: 50 }],
      },
    });
    await expect(runRolloutCommand(server.client, parseRolloutArgs(['status']), POLICY)).resolves.toEqual([
      `[ota-rollout] production ios runtime ${RTV}: update 11 at 5%`,
      `[ota-rollout] production android runtime ${OTHER_RTV}: update 21 at 50%`,
    ]);
    await expect(
      runRolloutCommand(server.client, parseRolloutArgs(['status', '--platform', 'android']), POLICY),
    ).resolves.toEqual([`[ota-rollout] production android runtime ${OTHER_RTV}: update 21 at 50%`]);
  });

  it('status reports the absence of a rollout in words and in JSON', async () => {
    const server = fakeXprem({ [`GET ${rolloutPath('pr-beta', RTV)}`]: { active: false } });
    const args = ['status', '--branch', 'pr-beta', '--runtime-version', RTV];
    await expect(runRolloutCommand(server.client, parseRolloutArgs(args), POLICY)).resolves.toEqual([
      '[ota-rollout] No live rollout on "pr-beta".',
    ]);
    const [json] = await runRolloutCommand(server.client, parseRolloutArgs([...args, '--json']), POLICY);
    expect(JSON.parse(json)).toEqual({ branch: 'pr-beta', rollouts: [] });
  });

  it('set, finish and revert each make exactly one write, always naming the update', async () => {
    const server = fakeXprem({
      [`GET ${rolloutPath('production', RTV)}`]: LIVE,
      [`PUT ${rolloutPath('production', RTV)}`]: { status: 204 },
      [`POST ${rolloutPath('production', RTV)}/revert`]: { status: 204 },
    });
    const run = (argv: string[]): Promise<string[]> =>
      runRolloutCommand(server.client, parseRolloutArgs([...argv, '--runtime-version', RTV]), POLICY);

    await expect(run(['set', '--percentage', '10'])).resolves.toEqual([
      `[ota-rollout] Raised production ios runtime ${RTV}: update 11 at 10%.`,
    ]);
    await expect(run(['finish'])).resolves.toEqual([
      `[ota-rollout] Finished production ios runtime ${RTV}: update 11 at 100%.`,
    ]);
    await expect(run(['revert', '--expected-update-id', '11'])).resolves.toEqual([
      `[ota-rollout] Reverted production ios runtime ${RTV}: update 11 at 5%.`,
    ]);

    const writes = server.requests.filter((request) => request.method !== 'GET');
    expect(writes.map(({ method, path, body }) => ({ method, path, body }))).toEqual([
      { method: 'PUT', path: rolloutPath('production', RTV), body: { percentage: 10, expectedUpdateId: 11 } },
      { method: 'PUT', path: rolloutPath('production', RTV), body: { percentage: 100, expectedUpdateId: 11 } },
      { method: 'POST', path: `${rolloutPath('production', RTV)}/revert`, body: { expectedUpdateId: 11 } },
    ]);
  });

  it('revert fails when nothing is live, unless --if-live makes that a no-op', async () => {
    const server = fakeXprem({ [`GET ${rolloutPath('production', RTV)}`]: { active: false } });
    const args = ['revert', '--runtime-version', RTV];
    await expect(runRolloutCommand(server.client, parseRolloutArgs(args), POLICY)).rejects.toThrow('No live rollout');
    await expect(runRolloutCommand(server.client, parseRolloutArgs([...args, '--if-live']), POLICY)).resolves.toEqual([
      `[ota-rollout] No live rollout on "production" runtime ${RTV}. Nothing to revert.`,
    ]);
    expect(server.requests.every((request) => request.method === 'GET')).toBe(true);
  });

  it('revert --if-live succeeds when the rollout ends between its read and its write', async () => {
    let reads = 0;
    const server = fakeXprem({
      [`GET ${rolloutPath('production', RTV)}`]: () => (reads++ === 0 ? LIVE : { active: false }),
    });
    const args = parseRolloutArgs(['revert', '--runtime-version', RTV, '--if-live']);
    await expect(runRolloutCommand(server.client, args, POLICY)).resolves.toEqual([
      `[ota-rollout] No live rollout on "production" runtime ${RTV}. Nothing to revert.`,
    ]);
  });

  it('health judges named updates by UUID', async () => {
    const canary = '43d5c1d5-ade8-62d9-1d01-9ffa9a169620';
    const control = '2d55b3b3-cc04-1a38-217b-92ec1ff5d2ff';
    const server = fakeXprem({
      [`GET ${FAKE_APP}/identity/update-health?ids=${canary}%2C${control}`]: {
        updates: {
          [canary]: { devicesOnUpdate: 6, successfulDevices: 6, faultyDevices: 0 },
          [control]: { devicesOnUpdate: 200, successfulDevices: 200, faultyDevices: 0 },
        },
      },
      [`GET ${FAKE_APP}/observe/update-health/history?ids=${canary}`]: { source: 'snapshots', updates: {} },
    });
    const args = parseRolloutArgs(['health', '--update-id', canary, '--control-update-id', control]);
    await expect(runRolloutCommand(server.client, args, POLICY)).resolves.toEqual([
      `[ota-rollout] ${canary}: insufficient-evidence. Not enough evidence: 6 device(s) have reported on the canary and 15 are needed.`,
    ]);
  });
});
