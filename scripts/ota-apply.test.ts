/// <reference types="node" />

import { describe, expect, it, vi } from 'vitest';
import {
  EARLY_UPDATES_BRANCH,
  PREVIEW_BRANCH_PATTERN,
  STABLE_BRANCH,
  STAGING_BRANCH,
  desiredOtaState,
  otaReleasePolicy,
} from '../infra/ota/config';
import type { OtaDesiredState } from '../infra/ota/config';
import {
  ADDITIVE_CHANGE_KINDS,
  OTA_CHANGE_KINDS,
  assertDeclarable,
  branchesNeedingRolloutRead,
  buildOtaPlan,
  hasDrift,
} from '../infra/ota/plan';
import type { OtaChangeKind, OtaLiveState } from '../infra/ota/plan';
import { FAKE_APP, fakeXprem } from './__tests__/helpers/fake-xprem';
import type { FakeRoute } from './__tests__/helpers/fake-xprem';
import { OTA_APP_ID } from './lib/ota-branch-probe';
import {
  EXIT_DRIFT,
  EXIT_IN_SYNC,
  EXIT_UNREADABLE,
  ServerUnreadableError,
  formatPlan,
  parseApplyArgs,
  readLiveState,
  runOtaApply,
  withReadRetries,
} from './ota-apply';

const RTV = 'b'.repeat(40);

/** A server that already matches the declaration. Each test bends one thing. */
function inSync(): OtaLiveState {
  return {
    channels: [
      {
        name: 'production',
        branchName: 'production',
        branchSurfing: { enabled: true, pattern: 'pr-*' },
        rollout: null,
      },
    ],
    branches: [
      { name: 'production', protected: true },
      { name: 'pr-beta', protected: true },
      { name: 'pr-staging', protected: true },
    ],
    updateRollouts: [],
  };
}

const summaries = (live: OtaLiveState): string[] =>
  buildOtaPlan(desiredOtaState, live).changes.map((change) => change.summary);

describe('the declaration', () => {
  it('declares the app, the channel mapping, surfing and three protected branches', () => {
    expect(desiredOtaState.appId).toBe(OTA_APP_ID);
    expect(desiredOtaState.channels).toMatchObject([
      { name: 'production', branch: 'production', branchSurfing: { enabled: true, pattern: 'pr-*' } },
    ]);
    expect(desiredOtaState.branches.map(({ name, protected: isProtected }) => ({ name, isProtected }))).toEqual([
      { name: STABLE_BRANCH, isProtected: true },
      { name: EARLY_UPDATES_BRANCH, isProtected: true },
      { name: STAGING_BRANCH, isProtected: true },
    ]);
    expect([STABLE_BRANCH, EARLY_UPDATES_BRANCH, STAGING_BRANCH]).toEqual(['production', 'pr-beta', 'pr-staging']);
  });

  it('gives every declared value a reason', () => {
    for (const entry of [...desiredOtaState.channels, ...desiredOtaState.branches]) {
      expect(entry.reason.length, entry.name).toBeGreaterThan(20);
    }
  });

  it('keeps the long-lived pr- branches out of the preview pattern, and inside the surfing glob', () => {
    for (const branch of desiredOtaState.branches) expect(PREVIEW_BRANCH_PATTERN.test(branch.name)).toBe(false);
    expect(PREVIEW_BRANCH_PATTERN.test('pr-123')).toBe(true);
    expect(PREVIEW_BRANCH_PATTERN.test('pr-0')).toBe(false);
    expect(EARLY_UPDATES_BRANCH.startsWith('pr-')).toBe(true);
    expect(STAGING_BRANCH.startsWith('pr-')).toBe(true);
  });

  it('declares the release policy', () => {
    expect(otaReleasePolicy).toEqual({
      canarySteps: [5, 10, 25, 50],
      stepHours: 4,
      minimumSoakHours: 20,
      dailyWindowUtcHour: 22,
      health: {
        evidenceFloorDevicesPerPlatform: 15,
        minFaultyDevicesToFail: 3,
        maxFaultyRateOverControlPercent: 2,
        maxFaultyRatePercent: 5,
        smallSampleFaultyRatePercent: 30,
      },
    });
    // The ramp must fit inside the soak, or a canary could be finished mid-ramp.
    const rampHours = (otaReleasePolicy.canarySteps.length - 1) * otaReleasePolicy.stepHours;
    expect(rampHours).toBeLessThan(otaReleasePolicy.minimumSoakHours);
    expect(otaReleasePolicy.minimumSoakHours).toBeLessThan(24);
    expect([...otaReleasePolicy.canarySteps].sort((left, right) => left - right)).toEqual([
      ...otaReleasePolicy.canarySteps,
    ]);
  });
});

describe('buildOtaPlan', () => {
  it('plans nothing when the server is in sync', () => {
    const plan = buildOtaPlan(desiredOtaState, inSync());
    expect(plan).toEqual({ changes: [], blocked: [], reports: [] });
    expect(hasDrift(plan)).toBe(false);
    expect(formatPlan(plan)).toEqual(['[ota-apply] In sync: the server matches infra/ota/config.ts.']);
  });

  it('creates and then protects a missing branch', () => {
    const live = inSync();
    live.branches = live.branches.filter((branch) => branch.name !== 'pr-beta');
    expect(buildOtaPlan(desiredOtaState, live).changes).toEqual([
      { kind: 'create-branch', branch: 'pr-beta', summary: 'Create branch "pr-beta".' },
      { kind: 'protect-branch', branch: 'pr-beta', summary: 'Protect branch "pr-beta" against deletion.' },
    ]);
  });

  it('protects an unprotected branch', () => {
    const live = inSync();
    live.branches = live.branches.map((branch) => ({ ...branch, protected: branch.name !== 'pr-staging' }));
    expect(summaries(live)).toEqual(['Protect branch "pr-staging" against deletion.']);
  });

  it('corrects a wrong surfing pattern, and surfing that is off', () => {
    const wrongPattern = inSync();
    wrongPattern.channels[0].branchSurfing = { enabled: true, pattern: '*' };
    expect(buildOtaPlan(desiredOtaState, wrongPattern).changes).toEqual([
      {
        kind: 'set-branch-surfing',
        channel: 'production',
        enabled: true,
        pattern: 'pr-*',
        summary: 'Set Branch Surfing on "production" to on with pattern "pr-*" (found on with pattern "*").',
      },
    ]);
    const off = inSync();
    off.channels[0].branchSurfing = null;
    expect(summaries(off)).toEqual([
      'Set Branch Surfing on "production" to on with pattern "pr-*" (found off with pattern "").',
    ]);
  });

  it('remaps a channel that serves the wrong branch', () => {
    const live = inSync();
    live.channels[0].branchName = 'pr-staging';
    expect(buildOtaPlan(desiredOtaState, live).changes).toEqual([
      {
        kind: 'map-channel',
        channel: 'production',
        branch: 'production',
        summary: 'Map channel "production" to branch "production" (serves "pr-staging" today).',
      },
    ]);
  });

  it('creates a missing channel after the branch it serves, then sets surfing', () => {
    const live: OtaLiveState = { channels: [], branches: [], updateRollouts: [] };
    expect(buildOtaPlan(desiredOtaState, live).changes.map((change) => change.kind)).toEqual([
      'create-branch',
      'create-branch',
      'create-branch',
      'protect-branch',
      'protect-branch',
      'protect-branch',
      'create-channel',
      'set-branch-surfing',
    ]);
  });

  it('plans every create before any protect, so a refused protection cannot block a create', () => {
    const live = inSync();
    live.branches = [{ name: 'production', protected: false }];
    expect(summaries(live)).toEqual([
      'Create branch "pr-beta".',
      'Create branch "pr-staging".',
      'Protect branch "production" against deletion.',
      'Protect branch "pr-beta" against deletion.',
      'Protect branch "pr-staging" against deletion.',
    ]);
  });

  it('reports undeclared channels and branches, and never plans to remove one', () => {
    const live = inSync();
    live.branches.push(
      { name: 'experiment', protected: false },
      { name: 'pr-4187', protected: false },
      { name: 'pr-6099', protected: false },
    );
    live.channels.push(
      { name: 'internal', branchName: 'experiment', branchSurfing: null, rollout: null },
      { name: 'pr-4187', branchName: 'pr-4187', branchSurfing: { enabled: false, pattern: '' }, rollout: null },
    );
    const plan = buildOtaPlan(desiredOtaState, live);
    expect(plan.changes).toEqual([]);
    expect(hasDrift(plan)).toBe(false);
    expect(plan.reports).toEqual([
      'Branch "experiment" exists on the server and is not declared. Left alone.',
      '2 per-PR preview branch(es) exist. They are never touched from here.',
      'Channel "internal" exists on the server and is not declared. Left alone.',
      '1 legacy per-PR channel(s) exist. The preview cleanup removes each with its branch.',
    ]);
  });

  it('reports a live rollout without calling it drift', () => {
    const live = inSync();
    live.updateRollouts = [
      { branch: 'production', runtimeVersion: RTV, platform: 'ios', updateId: '202', percentage: 25 },
    ];
    const plan = buildOtaPlan(desiredOtaState, live);
    expect(hasDrift(plan)).toBe(false);
    expect(plan.reports).toEqual([`Live rollout on "production" (ios, runtime ${RTV}): update 202 at 25%.`]);
  });

  it('refuses to remap a channel while an update rollout is live on either branch', () => {
    for (const rolloutBranch of ['production', 'pr-staging']) {
      const live = inSync();
      live.channels[0].branchName = 'pr-staging';
      live.updateRollouts = [
        { branch: rolloutBranch, runtimeVersion: RTV, platform: 'android', updateId: '303', percentage: 5 },
      ];
      const plan = buildOtaPlan(desiredOtaState, live);
      expect(plan.changes, rolloutBranch).toEqual([]);
      expect(plan.blocked, rolloutBranch).toEqual([
        'Channel "production" serves "pr-staging", not "production", and will not be remapped: ' +
          '1 update rollout(s) are live on the branches involved.',
      ]);
      expect(hasDrift(plan)).toBe(true);
    }
  });

  it('still remaps when the only live rollout is on an uninvolved branch', () => {
    const live = inSync();
    live.channels[0].branchName = 'pr-staging';
    live.updateRollouts = [{ branch: 'pr-beta', runtimeVersion: RTV, platform: 'ios', updateId: '404', percentage: 5 }];
    expect(buildOtaPlan(desiredOtaState, live).changes.map((change) => change.kind)).toEqual(['map-channel']);
  });

  it('refuses to remap a channel during a channel rollout', () => {
    const live = inSync();
    live.channels[0].branchName = 'pr-staging';
    live.channels[0].rollout = { percentage: 10, rolloutBranchName: 'pr-beta' };
    const plan = buildOtaPlan(desiredOtaState, live);
    expect(plan.changes).toEqual([]);
    expect(plan.blocked[0]).toContain('a channel rollout to "pr-beta" is live at 10%');
  });

  it('never lifts protection from a branch declared unprotected', () => {
    const relaxed: OtaDesiredState = {
      ...desiredOtaState,
      branches: desiredOtaState.branches.map((branch) => ({ ...branch, protected: false })),
    };
    const plan = buildOtaPlan(relaxed, inSync());
    expect(plan.changes).toEqual([]);
    expect(plan.reports).toHaveLength(3);
    expect(plan.reports[0]).toContain('Protection is never lifted from here.');
  });

  it('rejects a declaration it must not act on', () => {
    const withBranch = (name: string): OtaDesiredState => ({
      ...desiredOtaState,
      branches: [...desiredOtaState.branches, { name, protected: true, reason: 'test' }],
    });
    expect(() => assertDeclarable(withBranch('pr-123'))).toThrow('is a per-PR preview branch');
    expect(() => buildOtaPlan(withBranch('pr-123'), inSync())).toThrow('is a per-PR preview branch');
    expect(() => assertDeclarable(withBranch('production'))).toThrow('declared twice');
    const [channel] = desiredOtaState.channels;
    expect(() => assertDeclarable({ ...desiredOtaState, channels: [{ ...channel, branch: 'undeclared' }] })).toThrow(
      'which is not a declared branch',
    );
    expect(() =>
      assertDeclarable({
        ...desiredOtaState,
        channels: [{ ...channel, branchSurfing: { enabled: false, pattern: ' ' } }],
      }),
    ).toThrow('empty Branch Surfing pattern');
    expect(() => assertDeclarable(desiredOtaState)).not.toThrow();
  });

  it('never produces a change kind that deletes or loosens', () => {
    const empty: OtaLiveState = { channels: [], branches: [], updateRollouts: [] };
    const kinds = new Set(
      [inSync(), empty].flatMap((live) => buildOtaPlan(desiredOtaState, live).changes.map((change) => change.kind)),
    );
    for (const kind of kinds) expect(kind).toMatch(/^(create|protect|map|set)-/);
  });

  it('reads rollouts for declared branches that exist and for whatever the channel serves', () => {
    const live = inSync();
    live.branches = [
      { name: 'production', protected: true },
      { name: 'pr-staging', protected: true },
      { name: 'legacy', protected: false },
      { name: 'pr-77', protected: false },
    ];
    live.channels[0].branchName = 'legacy';
    expect(branchesNeedingRolloutRead(desiredOtaState, live)).toEqual(['legacy', 'pr-staging', 'production']);
  });
});

/** A fake server holding the state the apply mutates, so a second read sees the first run's writes. */
function statefulServer(initial: {
  protectedBranches: string[];
  branches: string[];
  surfingPattern: string;
  license?: FakeRoute;
  /** Branches whose protection call the server refuses, and how. */
  refuseProtection?: Record<string, { status: number; body?: unknown }>;
}) {
  const branches = new Map(initial.branches.map((name, index) => [name, { branchId: String(index + 1), name }]));
  const protectedBranches = new Set(initial.protectedBranches);
  let surfing = { enabled: true, pattern: initial.surfingPattern };
  let mappedBranchId = '1';
  const routes: Record<string, FakeRoute> = {
    'GET /api/license': initial.license ?? { valid: true, hasKey: true },
    [`GET ${FAKE_APP}/channels`]: () => [
      {
        releaseChannelId: '3',
        releaseChannelName: 'production',
        branchId: mappedBranchId,
        branchName: [...branches.values()].find((branch) => branch.branchId === mappedBranchId)?.name,
        branchSurfing: surfing,
      },
    ],
    [`GET ${FAKE_APP}/branches`]: () =>
      [...branches.values()].map((branch) => ({
        branchId: branch.branchId,
        branchName: branch.name,
        protected: protectedBranches.has(branch.name),
      })),
    [`POST ${FAKE_APP}/branches`]: (request) => {
      const { branchName } = request.body as { branchName: string };
      const branchId = String(branches.size + 1);
      branches.set(branchName, { branchId, name: branchName });
      return { branchId };
    },
    [`PUT ${FAKE_APP}/channels/production/branch-surfing`]: (request) => {
      surfing = request.body as typeof surfing;
      return { status: 204 };
    },
  };
  for (const name of ['production', 'pr-beta', 'pr-staging']) {
    routes[`PUT ${FAKE_APP}/branches/${name}/protection`] = () => {
      const refusal = initial.refuseProtection?.[name];
      if (refusal) return refusal;
      protectedBranches.add(name);
      return { status: 204 };
    };
    routes[`GET ${FAKE_APP}/branch/${name}/runtimeVersions`] = [{ runtimeVersion: RTV }];
    routes[`GET ${FAKE_APP}/branch/${name}/runtimeVersion/${RTV}/rollout`] = { active: false };
  }
  for (const branchId of ['1', '2', '3']) {
    routes[`POST ${FAKE_APP}/branch/${branchId}/updateChannelBranchMapping`] = () => {
      mappedBranchId = branchId;
      return { status: 204 };
    };
  }
  return {
    ...fakeXprem(routes),
    remap: (branchId: string) => {
      mappedBranchId = branchId;
    },
  };
}

const TODAY = { branches: ['production', 'pr-staging'], protectedBranches: [], surfingPattern: 'pr-*' };
const ALL_PROTECTED = {
  branches: ['production', 'pr-staging', 'pr-beta'],
  protectedBranches: ['production', 'pr-staging', 'pr-beta'],
  surfingPattern: 'pr-*',
};
const ADDITIVE_ONLY = { apply: true, only: [...ADDITIVE_CHANGE_KINDS] };

function writesOf(server: { requests: { method: string; path: string; body: unknown }[] }) {
  return server.requests
    .filter((request) => request.method !== 'GET')
    .map(({ method, path, body }) => ({ method, path, body }));
}

async function run(
  server: ReturnType<typeof statefulServer>,
  args: { apply: boolean; only: OtaChangeKind[] | null },
): Promise<{ exitCode: number; lines: string[] }> {
  const lines: string[] = [];
  const exitCode = await runOtaApply(server.client, desiredOtaState, {
    ...args,
    retryDelayMs: 0,
    log: (line) => lines.push(line),
  });
  return { exitCode, lines };
}

describe('ota-apply against a fake server', () => {
  it('reads channels, branches and the rollouts of every runtime version', async () => {
    const server = statefulServer(TODAY);
    await expect(readLiveState(server.client, desiredOtaState)).resolves.toEqual({
      channels: [
        {
          name: 'production',
          branchName: 'production',
          branchSurfing: { enabled: true, pattern: 'pr-*' },
          rollout: null,
        },
      ],
      branches: [
        { name: 'production', protected: false },
        { name: 'pr-staging', protected: false },
      ],
      updateRollouts: [],
    });
    expect(server.log()).toContain(`GET ${FAKE_APP}/branch/production/runtimeVersion/${RTV}/rollout`);
    expect(server.log()).toContain(`GET ${FAKE_APP}/branch/pr-staging/runtimeVersion/${RTV}/rollout`);
  });

  it('plans without writing, reports the licence, and exits 1 on drift', async () => {
    const server = statefulServer(TODAY);
    const { exitCode, lines } = await run(server, { apply: false, only: null });
    expect(exitCode).toBe(EXIT_DRIFT);
    expect(server.requests.every((request) => request.method === 'GET')).toBe(true);
    expect(lines).toEqual([
      '[ota-apply] drift: Create branch "pr-beta".',
      '[ota-apply] drift: Protect branch "production" against deletion.',
      '[ota-apply] drift: Protect branch "pr-beta" against deletion.',
      '[ota-apply] drift: Protect branch "pr-staging" against deletion.',
      '[ota-apply] licence: valid. Branch protection is available.',
      '[ota-apply] 4 change(s) pending. Re-run with --apply to make them.',
    ]);
  });

  it('applies the plan in order, confirms it, and is a no-op the second time', async () => {
    const server = statefulServer(TODAY);
    expect((await run(server, { apply: true, only: null })).exitCode).toBe(EXIT_IN_SYNC);
    // The create comes before every protect, so a refused protection cannot block it.
    expect(writesOf(server)).toEqual([
      { method: 'POST', path: `${FAKE_APP}/branches`, body: { branchName: 'pr-beta' } },
      { method: 'PUT', path: `${FAKE_APP}/branches/production/protection`, body: { protected: true } },
      { method: 'PUT', path: `${FAKE_APP}/branches/pr-beta/protection`, body: { protected: true } },
      { method: 'PUT', path: `${FAKE_APP}/branches/pr-staging/protection`, body: { protected: true } },
    ]);
    // Nothing the tool sent can delete.
    expect(server.requests.some((request) => request.method === 'DELETE')).toBe(false);

    const before = server.requests.length;
    expect((await run(server, { apply: true, only: null })).exitCode).toBe(EXIT_IN_SYNC);
    expect(server.requests.slice(before).every((request) => request.method === 'GET')).toBe(true);
  });

  it('remaps a channel by branch id and fixes the surfing pattern when a person applies', async () => {
    const server = statefulServer({ ...ALL_PROTECTED, surfingPattern: '*' });
    server.remap('2');
    expect((await run(server, { apply: true, only: null })).exitCode).toBe(EXIT_IN_SYNC);
    expect(writesOf(server)).toEqual([
      {
        method: 'POST',
        path: `${FAKE_APP}/branch/1/updateChannelBranchMapping`,
        body: { releaseChannelId: '3', releaseChannelName: 'production' },
      },
      {
        method: 'PUT',
        path: `${FAKE_APP}/channels/production/branch-surfing`,
        body: { enabled: true, pattern: 'pr-*' },
      },
    ]);
  });
});

describe('an unattended apply (--only)', () => {
  it('treats exactly the additive kinds as safe to apply unattended', () => {
    expect([...ADDITIVE_CHANGE_KINDS]).toEqual(['create-branch', 'protect-branch']);
    expect([...OTA_CHANGE_KINDS].sort()).toEqual(
      ['create-branch', 'create-channel', 'map-channel', 'protect-branch', 'set-branch-surfing'].sort(),
    );
  });

  it('creates and protects branches, and leaves everything fleet-affecting for a person', async () => {
    const server = statefulServer({ ...TODAY, surfingPattern: '*' });
    server.remap('2');
    const { exitCode, lines } = await run(server, ADDITIVE_ONLY);

    // Not red: declining to move the fleet is the intended outcome.
    expect(exitCode).toBe(EXIT_IN_SYNC);
    expect(writesOf(server).map(({ method, path }) => `${method} ${path}`)).toEqual([
      `POST ${FAKE_APP}/branches`,
      `PUT ${FAKE_APP}/branches/production/protection`,
      `PUT ${FAKE_APP}/branches/pr-beta/protection`,
      `PUT ${FAKE_APP}/branches/pr-staging/protection`,
    ]);
    // The channel was neither remapped nor had its surfing changed.
    expect(server.log().some((entry) => entry.includes('updateChannelBranchMapping'))).toBe(false);
    expect(server.log().some((entry) => entry.includes('branch-surfing'))).toBe(false);

    // The whole plan is printed first, with the withheld changes named as such.
    expect(lines.slice(0, 7)).toEqual([
      '[ota-apply] drift: Create branch "pr-beta".',
      '[ota-apply] drift: Protect branch "production" against deletion.',
      '[ota-apply] drift: Protect branch "pr-beta" against deletion.',
      '[ota-apply] drift: Protect branch "pr-staging" against deletion.',
      '[ota-apply] pending manual apply: Map channel "production" to branch "production" (serves "pr-staging" today).',
      '[ota-apply] pending manual apply: Set Branch Surfing on "production" to on with pattern "pr-*" (found on with pattern "*").',
      '[ota-apply] licence: valid. Branch protection is available.',
    ]);
    expect(lines.slice(-3)).toEqual([
      '[ota-apply] Applied what an unattended run may. Left for a manual apply:',
      '[ota-apply] pending manual apply: Map channel "production" to branch "production" (serves "pr-staging" today).',
      '[ota-apply] pending manual apply: Set Branch Surfing on "production" to on with pattern "pr-*" (found on with pattern "*").',
    ]);
  });

  it('keeps reporting what it left: a later plan-only run still exits 1', async () => {
    const server = statefulServer({ ...ALL_PROTECTED, surfingPattern: '*' });
    expect((await run(server, ADDITIVE_ONLY)).exitCode).toBe(EXIT_IN_SYNC);
    expect(writesOf(server)).toEqual([]);
    // What the daily drift job sees.
    expect((await run(server, { apply: false, only: null })).exitCode).toBe(EXIT_DRIFT);
  });

  it('never creates a channel unattended', async () => {
    const live: OtaLiveState = { channels: [], branches: [], updateRollouts: [] };
    const allowed = buildOtaPlan(desiredOtaState, live).changes.filter((change) =>
      ADDITIVE_CHANGE_KINDS.includes(change.kind),
    );
    expect(allowed.map((change) => change.kind)).toEqual([
      'create-branch',
      'create-branch',
      'create-branch',
      'protect-branch',
      'protect-branch',
      'protect-branch',
    ]);
  });

  it('parses --apply and --only, and refuses --only on its own', () => {
    expect(parseApplyArgs([])).toEqual({ apply: false, only: null });
    expect(parseApplyArgs(['--', '--apply'])).toEqual({ apply: true, only: null });
    expect(parseApplyArgs(['--apply', '--only', 'create-branch,protect-branch'])).toEqual(ADDITIVE_ONLY);
    expect(() => parseApplyArgs(['--only', 'create-branch'])).toThrow('--only narrows --apply');
    expect(() => parseApplyArgs(['--apply', '--only'])).toThrow('--only needs a comma-separated list');
    expect(() => parseApplyArgs(['--apply', '--only', 'delete-branch'])).toThrow('Unknown change kind "delete-branch"');
    expect(() => parseApplyArgs(['--force'])).toThrow('Unknown argument: --force');
  });
});

describe('licence', () => {
  it('says so in the plan when the licence is not valid', async () => {
    const server = statefulServer({
      ...TODAY,
      license: { valid: false, hasKey: true, validationErrorCode: 'expired' },
    });
    const { lines } = await run(server, { apply: false, only: null });
    expect(lines).toContain(
      '[ota-apply] licence: NOT valid (expired). Branch protection is an Enterprise feature; the server is expected to refuse it.',
    );
  });

  it('carries on when the licence cannot be read', async () => {
    const server = statefulServer({ ...ALL_PROTECTED, license: { status: 404 } });
    const { exitCode, lines } = await run(server, { apply: false, only: null });
    expect(exitCode).toBe(EXIT_IN_SYNC);
    expect(lines[1]).toContain('[ota-apply] licence: could not be read (Read licence failed (HTTP 404))');
  });

  it('reports a protection refused for the licence as its own condition, after creating the branch', async () => {
    const refusal = { status: 403, body: { detail: 'forbidden' } };
    const server = statefulServer({
      ...TODAY,
      license: { valid: false, hasKey: false },
      refuseProtection: { production: refusal, 'pr-beta': refusal, 'pr-staging': refusal },
    });
    const { exitCode, lines } = await run(server, ADDITIVE_ONLY);

    // pr-beta exists even though no protection call was accepted.
    expect(writesOf(server)[0]).toEqual({
      method: 'POST',
      path: `${FAKE_APP}/branches`,
      body: { branchName: 'pr-beta' },
    });
    expect(writesOf(server)).toHaveLength(4);
    expect(exitCode).toBe(EXIT_DRIFT);
    expect(lines).toContain(
      '[ota-apply] licence: the server refused to protect "pr-beta". Branch protection needs a valid ' +
        'Enterprise licence on this server; nothing else failed. The branch exists and stays deletable.',
    );
    expect(lines.filter((line) => line.includes('refused to protect'))).toHaveLength(3);
  });

  it('recognises a licence refusal from the answer alone when the licence reads as valid', async () => {
    const server = statefulServer({
      ...ALL_PROTECTED,
      protectedBranches: ['production', 'pr-beta'],
      refuseProtection: { 'pr-staging': { status: 402, body: { detail: 'Enterprise license required' } } },
    });
    const { exitCode, lines } = await run(server, ADDITIVE_ONLY);
    expect(exitCode).toBe(EXIT_DRIFT);
    expect(lines.some((line) => line.includes('refused to protect "pr-staging"'))).toBe(true);
  });

  it('does not dress up any other refusal as a licence problem', async () => {
    const server = statefulServer({
      ...ALL_PROTECTED,
      protectedBranches: ['production', 'pr-beta'],
      refuseProtection: { 'pr-staging': { status: 403, body: { detail: 'missing permission branch:protect' } } },
    });
    await expect(run(server, ADDITIVE_ONLY)).rejects.toThrow('Set protection on branch "pr-staging" failed (HTTP 403)');
  });
});

describe('reading the server', () => {
  it('retries a failed read and then succeeds', async () => {
    let failures = 2;
    const read = vi.fn(async () => {
      if (failures-- > 0) throw new Error('HTTP 502');
      return 'state';
    });
    await expect(withReadRetries(read, { delayMs: 0 })).resolves.toBe('state');
    expect(read).toHaveBeenCalledTimes(3);
  });

  it('gives up after three tries with an error that is not drift', async () => {
    const read = vi.fn(async () => {
      throw new Error('Admin login failed (HTTP 401): bad credentials');
    });
    const failure = await withReadRetries(read, { delayMs: 0 }).catch((error: unknown) => error);
    expect(read).toHaveBeenCalledTimes(3);
    expect(failure).toBeInstanceOf(ServerUnreadableError);
    expect((failure as Error).message).toBe(
      'Could not read the OTA server: Admin login failed (HTTP 401): bad credentials',
    );
    expect(EXIT_UNREADABLE).not.toBe(EXIT_DRIFT);
  });

  it('surfaces an unreadable server from a run, without calling it drift', async () => {
    const server = fakeXprem({
      [`GET ${FAKE_APP}/channels`]: { status: 503 },
      [`GET ${FAKE_APP}/branches`]: [],
    });
    await expect(
      runOtaApply(server.client, desiredOtaState, { apply: false, only: null, retryDelayMs: 0, log: () => {} }),
    ).rejects.toBeInstanceOf(ServerUnreadableError);
    expect(server.log().filter((entry) => entry.endsWith('/channels'))).toHaveLength(3);
  });

  it('refuses to map a channel to a legacy branch that has no id', async () => {
    const server = fakeXprem({
      'GET /api/license': { valid: true, hasKey: true },
      [`GET ${FAKE_APP}/channels`]: [
        { releaseChannelId: '3', releaseChannelName: 'production', branchName: 'pr-staging', branchId: '2' },
      ],
      [`GET ${FAKE_APP}/branches`]: [
        { branchId: '', branchName: 'production', protected: true },
        { branchId: '2', branchName: 'pr-staging', protected: true },
        { branchId: '3', branchName: 'pr-beta', protected: true },
      ],
      [`GET ${FAKE_APP}/branch/production/runtimeVersions`]: [],
      [`GET ${FAKE_APP}/branch/pr-staging/runtimeVersions`]: [],
      [`GET ${FAKE_APP}/branch/pr-beta/runtimeVersions`]: [],
      [`PUT ${FAKE_APP}/channels/production/branch-surfing`]: { status: 204 },
    });
    await expect(
      runOtaApply(server.client, desiredOtaState, { apply: true, only: null, retryDelayMs: 0, log: () => {} }),
    ).rejects.toThrow('Branch "production" has no id on the server, so "production" cannot be mapped to it.');
  });
});
