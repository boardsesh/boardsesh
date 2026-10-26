/// <reference types="node" />

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { parse } from 'yaml';
import {
  affectsMobilePreview,
  appConfigDigest,
  createGitHubRefreshApi,
  decidePreviewRefresh,
  parsePreviewBases,
  planPreviewRefresh,
  PREVIEW_BASE_KEYS,
  RUNTIME_INPUTS,
  snapshotQuery,
  unreadableSnapshot,
  type BaseHeads,
  type BaseSnapshot,
  type PreviewAttempt,
  type PreviewRecord,
  type RefreshApi,
  type RefreshPull,
} from './mobile-ota-preview-refresh.ts';

interface WorkflowStep {
  id?: string;
  name?: string;
  uses?: string;
  run?: string;
  env?: Record<string, string>;
  with?: Record<string, unknown> & { script?: string };
}
interface WorkflowJob {
  if?: string;
  environment?: string;
  concurrency?: { group: string; 'cancel-in-progress': boolean };
  needs?: string | string[];
  permissions?: Record<string, string>;
  outputs?: Record<string, string>;
  steps: WorkflowStep[];
}
interface Workflow {
  permissions?: Record<string, string>;
  concurrency?: unknown;
  jobs: Record<string, WorkflowJob>;
}
const readWorkflow = (name: string) =>
  parse(readFileSync(resolve(import.meta.dirname, `../.github/workflows/${name}.yml`), 'utf8')) as Workflow;
const refresh = readWorkflow('mobile-ota-preview-refresh');
const publisher = readWorkflow('mobile-ota-preview');
const decideScript = publisher.jobs.gate.steps.find((step) => step.id === 'decide')?.with?.script ?? '';
const pinScript = publisher.jobs.gate.steps.find((step) => step.id === 'pin')?.with?.script ?? '';

const sha = (character: string) => character.repeat(40);
const MAIN_OLD = sha('1');
const MAIN_NEW = sha('2');
const TRAIN_OLD = sha('3');
const TRAIN_NEW = sha('4');

const baseInputs = (): Record<string, string> =>
  Object.fromEntries(RUNTIME_INPUTS.map(({ path }, index) => [path, `oid-${index}`]));
const snap = (commit: string, version = '2.6.0', overrides: Record<string, string> = {}): BaseSnapshot => ({
  sha: commit,
  readable: true,
  inputs: { ...baseInputs(), ...overrides },
  marketingVersion: version,
});
const HEAD = sha('a');
const NOW = Date.parse('2026-10-26T12:00:00Z');
const found = (
  status = 'success',
  trainSha = TRAIN_OLD,
  extra: { statusAt?: string; recent?: PreviewAttempt[] } = {},
): PreviewRecord => ({
  kind: 'found',
  status,
  statusAt: extra.statusAt ?? new Date().toISOString(),
  bases: { version: 1, mainSha: MAIN_OLD, trainSha, sourceBaseRef: 'main', sourceBaseSha: MAIN_OLD },
  recent: extra.recent ?? [{ sha: HEAD, status }],
});
/** Recorded and current heads with an active train (main 2.6.0, train 2.7.0) and identical inputs. */
const heads = (): { recorded: BaseHeads; current: BaseHeads } => ({
  recorded: { main: snap(MAIN_OLD), train: snap(TRAIN_OLD, '2.7.0') },
  current: { main: snap(MAIN_NEW), train: snap(TRAIN_NEW, '2.7.0') },
});

describe('decidePreviewRefresh', () => {
  it('skips a preview whose base runtime inputs did not change across new SHAs', () => {
    const { recorded, current } = heads();
    expect(decidePreviewRefresh(found(), current, recorded)).toEqual({
      dispatch: false,
      reason: 'unchanged runtime, skipped',
    });
  });

  it('dispatches when only the iOS runtime of main changed', () => {
    const { recorded, current } = heads();
    current.main = snap(MAIN_NEW, '2.6.0', { 'packages/mobile/ios': 'podfile-v2' });
    expect(decidePreviewRefresh(found(), current, recorded)).toEqual({
      dispatch: true,
      reason: 'runtime inputs changed on main ios',
    });
  });

  it('names the train and both platforms for a shared native input', () => {
    const { recorded, current } = heads();
    current.train = snap(TRAIN_NEW, '2.7.0', { 'pnpm-lock.yaml': 'lock-v2' });
    expect(decidePreviewRefresh(found(), current, recorded).reason).toBe(
      'runtime inputs changed on release/next ios+android',
    );
  });

  it('dispatches when the release train becomes active', () => {
    const { current } = heads();
    const recorded: BaseHeads = { main: snap(MAIN_OLD), train: null };
    expect(decidePreviewRefresh(found('success', ''), current, recorded)).toEqual({
      dispatch: true,
      reason: 'release train activated',
    });
  });

  it('dispatches when a merge-back levels the versions and the train stops being a target', () => {
    const { recorded } = heads();
    const current: BaseHeads = { main: snap(MAIN_NEW, '2.7.0'), train: snap(TRAIN_NEW, '2.7.0') };
    expect(decidePreviewRefresh(found(), current, recorded).reason).toBe('release train deactivated');
  });

  it('dispatches when the PR has no preview record', () => {
    const { current } = heads();
    expect(decidePreviewRefresh({ kind: 'missing' }, current)).toEqual({
      dispatch: true,
      reason: 'no preview record, refreshing',
    });
  });

  it('dispatches an unreadable preview record', () => {
    const { current } = heads();
    expect(decidePreviewRefresh({ kind: 'unreadable', detail: 'no valid otaPreviewBases' }, current).dispatch).toBe(
      true,
    );
  });

  it.each(['failure', 'error'])('dispatches when the last preview ended in %s', (status) => {
    const { recorded, current } = heads();
    expect(decidePreviewRefresh(found(status), current, recorded)).toEqual({
      dispatch: true,
      reason: `last preview ended in ${status}, refreshing`,
    });
  });

  it.each(['in_progress', 'queued', 'pending', '', 'inactive'])(
    'compares runtimes for a %j preview instead of refreshing it',
    (status) => {
      const { recorded, current } = heads();
      expect(decidePreviewRefresh(found(status), current, recorded).dispatch).toBe(false);
    },
  );

  it('ignores native changes on an inactive train', () => {
    const recorded: BaseHeads = { main: snap(MAIN_OLD), train: snap(TRAIN_OLD) };
    const current: BaseHeads = {
      main: snap(MAIN_NEW),
      train: snap(TRAIN_NEW, '2.6.0', { 'packages/mobile/modules': 'changed' }),
    };
    expect(decidePreviewRefresh(found(), current, recorded).dispatch).toBe(false);
  });

  it('counts the publisher workflow on main only, since dispatches run main’s copy', () => {
    const workflow = '.github/workflows/mobile-ota-preview.yml';
    const onTrain = heads();
    onTrain.current.train = snap(TRAIN_NEW, '2.7.0', { [workflow]: 'edited' });
    expect(decidePreviewRefresh(found(), onTrain.current, onTrain.recorded).dispatch).toBe(false);
    const onMain = heads();
    onMain.current.main = snap(MAIN_NEW, '2.6.0', { [workflow]: 'edited' });
    expect(decidePreviewRefresh(found(), onMain.current, onMain.recorded).reason).toBe(
      'runtime inputs changed on main ios+android',
    );
  });

  it('refreshes when a recorded base can no longer be read', () => {
    const { current } = heads();
    const recorded: BaseHeads = { main: unreadableSnapshot(MAIN_OLD), train: snap(TRAIN_OLD, '2.7.0') };
    expect(decidePreviewRefresh(found(), current, recorded).dispatch).toBe(true);
  });

  it('refreshes when a marketing version cannot be read', () => {
    const { recorded, current } = heads();
    current.train = { ...snap(TRAIN_NEW), marketingVersion: null };
    expect(decidePreviewRefresh(found(), current, recorded).reason).toBe(
      'release train version unreadable, refreshing',
    );
  });

  it('treats a deployment stuck without a terminal status for over 6 hours as failed', () => {
    const { recorded, current } = heads();
    const hoursAgo = (hours: number) => new Date(NOW - hours * 60 * 60 * 1000).toISOString();
    expect(
      decidePreviewRefresh(found('in_progress', TRAIN_OLD, { statusAt: hoursAgo(7) }), current, recorded, { now: NOW }),
    ).toEqual({ dispatch: true, reason: 'last preview stuck in in_progress for over 6 hours, refreshing' });
    expect(
      decidePreviewRefresh(found('', TRAIN_OLD, { statusAt: hoursAgo(6.5) }), current, recorded, { now: NOW }).reason,
    ).toBe('last preview stuck without a status for over 6 hours, refreshing');
    // Inside the 330-minute publish timeout the attempt may still be running.
    expect(
      decidePreviewRefresh(found('queued', TRAIN_OLD, { statusAt: hoursAgo(5) }), current, recorded, { now: NOW })
        .dispatch,
    ).toBe(false);
    // A finished preview is never stale by age.
    expect(
      decidePreviewRefresh(found('success', TRAIN_OLD, { statusAt: hoursAgo(72) }), current, recorded, { now: NOW })
        .dispatch,
    ).toBe(false);
  });

  it('stops re-dispatching after two failures in a row at the current head', () => {
    const { recorded, current } = heads();
    const twice = found('failure', TRAIN_OLD, {
      recent: [
        { sha: HEAD, status: 'failure' },
        { sha: HEAD, status: 'failure' },
      ],
    });
    expect(decidePreviewRefresh(twice, current, recorded, { headSha: HEAD })).toEqual({
      dispatch: false,
      reason: 'failed twice at this head; next PR push retries',
    });
    // A new head, a single failure, an error or a success in between still retries.
    expect(decidePreviewRefresh(twice, current, recorded, { headSha: sha('b') }).dispatch).toBe(true);
    const once = found('failure', TRAIN_OLD, { recent: [{ sha: HEAD, status: 'failure' }] });
    expect(decidePreviewRefresh(once, current, recorded, { headSha: HEAD }).dispatch).toBe(true);
    const afterSuccess = found('failure', TRAIN_OLD, {
      recent: [
        { sha: HEAD, status: 'failure' },
        { sha: HEAD, status: 'success' },
      ],
    });
    expect(decidePreviewRefresh(afterSuccess, current, recorded, { headSha: HEAD }).dispatch).toBe(true);
    const resetPending = found('error', TRAIN_OLD, {
      recent: [
        { sha: HEAD, status: 'error' },
        { sha: HEAD, status: 'failure' },
      ],
    });
    expect(decidePreviewRefresh(resetPending, current, recorded, { headSha: HEAD }).dispatch).toBe(true);
  });

  it('still dispatches a twice-failed head when the runtime changed or the train flipped', () => {
    const twice = found('failure', TRAIN_OLD, {
      recent: [
        { sha: HEAD, status: 'failure' },
        { sha: HEAD, status: 'failure' },
      ],
    });
    const changed = heads();
    changed.current.main = snap(MAIN_NEW, '2.6.0', { 'packages/mobile/eas.json': 'edited' });
    expect(decidePreviewRefresh(twice, changed.current, changed.recorded, { headSha: HEAD }).reason).toBe(
      'runtime inputs changed on main ios+android',
    );
    const flipped = heads();
    flipped.current.train = snap(TRAIN_NEW, '2.6.0');
    expect(decidePreviewRefresh(twice, flipped.current, flipped.recorded, { headSha: HEAD }).reason).toBe(
      'release train deactivated',
    );
  });
});

describe('runtime inputs', () => {
  it('treats a marketing-version bump as runtime-neutral, like ExpoConfigVersions', () => {
    const config = (version: string, scheme = 'boardsesh') =>
      `export default () => ({\n    name: 'Boardsesh',\n    version: '${version}',\n    scheme: '${scheme}',\n});\n`;
    expect(appConfigDigest(config('2.7.0'))).toBe(appConfigDigest(config('2.7.1')));
    expect(appConfigDigest(config('2.7.0'))).not.toBe(appConfigDigest(config('2.7.0', 'other')));
    // More than one literal version line is hashed as-is rather than guessed at.
    const doubled = `${config('2.7.0')}\n    version: '1.0.0',\n`;
    expect(appConfigDigest(doubled)).not.toBe(appConfigDigest(`${config('2.7.0')}\n    version: '1.0.1',\n`));
  });

  it('covers every path the publisher gate treats as a native fingerprint input', () => {
    const body = /const affectsNativeFingerprint = \(path\) =>([\s\S]*?);\n\n/.exec(decideScript)?.[1];
    expect(body).toBeTruthy();
    // oxlint-disable-next-line no-implied-eval
    const gate = new Function('path', `return (${body});`) as (path: string) => boolean;
    const covered = (path: string) =>
      RUNTIME_INPUTS.some((input) => path === input.path || path.startsWith(`${input.path}/`));
    const samples = [
      'package.json',
      'pnpm-lock.yaml',
      'pnpm-workspace.yaml',
      'patches/expo-updates@58.0.18.patch',
      'packages/mobile/app.config.ts',
      'packages/mobile/package.json',
      'packages/mobile/fingerprint.config.js',
      'packages/mobile/eas.json',
      'packages/mobile/assets/icon.png',
      'packages/mobile/assets/splash-icon.png',
      'packages/mobile/assets/adaptive-icon.png',
      'packages/mobile/assets/boards/kilter.png',
      'packages/mobile/targets/widget/Info.plist',
      'packages/mobile/plugins/with-android-minify.js',
      'packages/mobile/modules/live-activity/ios/LiveActivity.swift',
      'packages/mobile/locales/de.json',
      'packages/mobile/ios/Podfile',
      'packages/mobile/android/build.gradle',
      'packages/mobile/src/app.tsx',
      'packages/shared/queue/src/index.ts',
      'packages/web/package.json',
    ];
    for (const path of samples) expect(covered(path), path).toBe(gate(path));
    // Extra inputs beyond the gate: react-native.config.js and the publisher env.
    const extras = RUNTIME_INPUTS.filter((input) => !gate(input.path) && !gate(`${input.path}/file`)).map(
      (input) => input.path,
    );
    expect(extras).toEqual([
      'packages/mobile/react-native.config.js',
      '.github/workflows/mobile-ota-preview.yml',
      'scripts/lib/eoas.ts',
    ]);
  });
  it('treats exactly the files the publisher gate publishes for as mobile changes', () => {
    const body = /const affectsMobilePreview = \(path\) =>([\s\S]*?);\n\n/.exec(decideScript)?.[1];
    expect(body).toBeTruthy();
    // oxlint-disable-next-line no-implied-eval
    const gate = new Function('path', `return (${body});`) as (path: string) => boolean;
    const literals = [...String(body).matchAll(/'([^']+)'/g)].map((match) => match[1]);
    expect(literals.length).toBeGreaterThan(10);
    const samples = [
      ...literals,
      ...literals.map((literal) => `${literal}x`),
      'packages/web/app/page.tsx',
      '.github/workflows/mobile-ota-production.yml',
      'scripts/mobile-ota-preview-refresh.ts',
    ];
    for (const path of samples) expect(affectsMobilePreview(path), path).toBe(gate(path));
  });

  it('covers the repo-local sources the fingerprint hashes, on the platforms that hash them', () => {
    // Captured 2026-10-26 from `vp exec expo-updates fingerprint:generate --platform <p> --debug`
    // in packages/mobile: every `file`/`dir` source outside node_modules, as repo paths
    // (one representative per plugin/module directory). Re-capture when that output grows.
    const both = [
      'patches',
      'packages/mobile/locales',
      'packages/mobile/assets/icon.png',
      'packages/mobile/assets/splash-icon.png',
      'packages/mobile/eas.json',
      'packages/mobile/fingerprint.config.js',
      'packages/mobile/plugins/with-android-minify.js',
      'packages/mobile/plugins/with-boardsesh-widget-build-settings.js',
      'packages/mobile/targets/BoardseshWidgets/expo-target.config.js',
    ];
    const sources: Record<'ios' | 'android', string[]> = {
      ios: [...both, 'packages/mobile/modules/live-activity/ios', 'packages/mobile/modules/storefront/ios'],
      android: [
        ...both,
        'packages/mobile/assets/adaptive-icon.png',
        'packages/mobile/modules/live-activity/android',
        'packages/mobile/modules/install-referrer/android',
      ],
    };
    for (const platform of ['ios', 'android'] as const)
      for (const path of sources[platform])
        expect(
          RUNTIME_INPUTS.some(
            (input) => (path === input.path || path.startsWith(`${input.path}/`)) && input.platforms.includes(platform),
          ),
          `${platform} ${path}`,
        ).toBe(true);
    // Any production icon or splash the app config names is a hashed file too.
    const appConfig = readFileSync(resolve(import.meta.dirname, '../packages/mobile/app.config.ts'), 'utf8');
    const assets = [...appConfig.matchAll(/'\.\/(assets\/[^']+\.png)'/g)].map((match) => `packages/mobile/${match[1]}`);
    expect(assets.length).toBeGreaterThan(0);
    for (const asset of assets)
      expect(
        RUNTIME_INPUTS.map((input) => input.path),
        asset,
      ).toContain(asset);
  });
});

describe('parsePreviewBases', () => {
  const bases = { version: 1, mainSha: MAIN_OLD, trainSha: '', sourceBaseRef: 'main', sourceBaseSha: MAIN_OLD };

  it('uses the same keys the publisher pin step validates', () => {
    const literal = /const baseKeys = (\[[^\]]+\]);/.exec(pinScript)?.[1];
    expect(JSON.parse(String(literal).replaceAll("'", '"'))).toEqual([...PREVIEW_BASE_KEYS]);
  });

  it('accepts object and JSON-string payloads', () => {
    expect(parsePreviewBases({ otaPreviewBases: bases })).toEqual(bases);
    expect(parsePreviewBases(JSON.stringify({ otaPreviewBases: bases }))).toEqual(bases);
  });

  it.each([
    null,
    'not json',
    {},
    { otaPreviewBases: { ...bases, extra: true } },
    { otaPreviewBases: { ...bases, version: 2 } },
    { otaPreviewBases: { ...bases, mainSha: 'abc' } },
    { otaPreviewBases: { ...bases, trainSha: 'abc' } },
    { otaPreviewBases: { ...bases, sourceBaseRef: '' } },
  ])('rejects %j', (payload) => {
    expect(parsePreviewBases(payload)).toBeNull();
  });
});

const pull = (number: number, overrides: Partial<RefreshPull> = {}): RefreshPull => ({
  number,
  headRef: `feature-${number}`,
  headSha: HEAD,
  headRepository: 'boardsesh/boardsesh',
  baseRef: 'main',
  ...overrides,
});

function fakeApi(options: {
  pulls?: RefreshPull[];
  files?: Record<number, string[]>;
  records?: Record<number, PreviewRecord>;
  live?: Record<number, boolean>;
  snapshots?: BaseSnapshot[];
  trainHead?: string | null;
}) {
  const snapshots = options.snapshots ?? [
    snap(MAIN_OLD),
    snap(MAIN_NEW),
    snap(TRAIN_OLD, '2.7.0'),
    snap(TRAIN_NEW, '2.7.0'),
  ];
  const api = {
    openPulls: vi.fn(async () => options.pulls ?? [pull(7)]),
    pullFiles: vi.fn(async (number: number) => options.files?.[number] ?? ['packages/mobile/app/index.tsx']),
    branchHead: vi.fn(async (branch: string) =>
      branch === 'main' ? MAIN_NEW : options.trainHead === undefined ? TRAIN_NEW : options.trainHead,
    ),
    latestPreview: vi.fn(async (number: number) => options.records?.[number] ?? found()),
    hasLivePreview: vi.fn(async (number: number) => options.live?.[number] ?? false),
    snapshots: vi.fn(
      async (shas: readonly string[]) =>
        new Map(
          snapshots.filter((snapshot) => shas.includes(snapshot.sha)).map((snapshot) => [snapshot.sha, snapshot]),
        ),
    ),
  } satisfies RefreshApi;
  return api;
}

describe('planPreviewRefresh', () => {
  it('writes one summary line per PR and dispatches only stale previews', async () => {
    const api = fakeApi({
      pulls: [pull(7), pull(8), pull(9)],
      records: { 8: { kind: 'missing' }, 9: found('failure') },
    });
    expect(await planPreviewRefresh(api, 'boardsesh/boardsesh')).toEqual({
      dispatch: [8, 9],
      lines: [
        'PR #7: unchanged runtime, skipped',
        'PR #8: no preview record, refreshing',
        'PR #9: last preview ended in failure, refreshing',
      ],
    });
    // One batched snapshot read for the current heads and every recorded base.
    expect(api.snapshots).toHaveBeenCalledTimes(1);
    expect(new Set(api.snapshots.mock.calls[0][0])).toEqual(new Set([MAIN_NEW, TRAIN_NEW, MAIN_OLD, TRAIN_OLD]));
  });

  it('keeps forks, train merge-backs and unsupported bases outside the dispatcher', async () => {
    const api = fakeApi({
      pulls: [
        pull(7, { headRepository: 'outsider/boardsesh' }),
        pull(8, { headRef: 'release/next' }),
        pull(9, { baseRef: 'other' }),
        pull(10, { headRepository: null }),
      ],
    });
    const plan = await planPreviewRefresh(api, 'boardsesh/boardsesh');
    expect(plan.dispatch).toEqual([]);
    expect(api.pullFiles).not.toHaveBeenCalled();
    expect(api.branchHead).not.toHaveBeenCalled();
  });

  it('reconciles a PR whose base absorbed its last mobile change only while a preview is live', async () => {
    const api = fakeApi({
      pulls: [pull(7), pull(8)],
      files: { 7: ['packages/web/app/page.tsx'], 8: ['packages/web/app/page.tsx'] },
      live: { 7: true },
    });
    const plan = await planPreviewRefresh(api, 'boardsesh/boardsesh');
    expect(plan.dispatch).toEqual([7]);
    expect(plan.lines[1]).toBe('PR #8: no mobile changes and no live preview, skipped');
    expect(api.latestPreview).not.toHaveBeenCalled();
  });

  it('refreshes a PR whose state cannot be read instead of skipping it', async () => {
    const api = fakeApi({ pulls: [pull(7)] });
    api.pullFiles.mockRejectedValueOnce(new Error('HTTP 502'));
    expect(await planPreviewRefresh(api, 'boardsesh/boardsesh')).toEqual({
      dispatch: [7],
      lines: ['PR #7: preview state unreadable (HTTP 502), refreshing'],
    });
  });

  it('fails visibly rather than fan out when the current bases cannot be read', async () => {
    const api = fakeApi({ snapshots: [snap(MAIN_OLD), snap(TRAIN_OLD, '2.7.0'), snap(TRAIN_NEW, '2.7.0')] });
    await expect(planPreviewRefresh(api, 'boardsesh/boardsesh')).rejects.toThrow('current bases');
  });

  it('treats a deleted release/next as a deactivated train', async () => {
    const api = fakeApi({ trainHead: null });
    const plan = await planPreviewRefresh(api, 'boardsesh/boardsesh');
    expect(plan.lines).toEqual(['PR #7: release train deactivated']);
  });
});

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('createGitHubRefreshApi', () => {
  it('reads runtime inputs as git object ids with a version-free app config digest', async () => {
    const config = "export default () => ({\n    version: '2.7.0',\n});\n";
    const appConfigIndex = RUNTIME_INPUTS.findIndex(({ path }) => path === 'packages/mobile/app.config.ts');
    const iosIndex = RUNTIME_INPUTS.findIndex(({ path }) => path === 'packages/mobile/ios');
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const { query } = JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as { query: string };
      expect(query).toContain(`c0: object(oid: "${MAIN_NEW}")`);
      expect(query).toContain(`object(expression: "${MAIN_NEW}:packages/mobile/targets")`);
      const repository: Record<string, unknown> = { c0: { oid: MAIN_NEW }, c1: null };
      RUNTIME_INPUTS.forEach((_input, index) => {
        repository[`c0_${index}`] =
          index === appConfigIndex ? { oid: 'blob', text: config, isTruncated: false } : { oid: `oid-${index}` };
        repository[`c1_${index}`] = null;
      });
      repository[`c0_${iosIndex}`] = null;
      return jsonResponse({ data: { repository } });
    });
    const api = createGitHubRefreshApi({ token: 't', repository: 'boardsesh/boardsesh', fetchImpl });
    const snapshots = await api.snapshots([MAIN_NEW, MAIN_OLD]);
    const current = snapshots.get(MAIN_NEW);
    expect(current?.readable).toBe(true);
    expect(current?.marketingVersion).toBe('2.7.0');
    expect(current?.inputs['packages/mobile/app.config.ts']).toBe(appConfigDigest(config));
    expect(current?.inputs['packages/mobile/ios']).toBe('');
    expect(snapshots.get(MAIN_OLD)?.readable).toBe(false);
  });

  it('refuses to interpolate anything but a full SHA into the query', () => {
    expect(() => snapshotQuery(['main") { oid } x: object(oid: "1'])).toThrow('full commit SHAs');
  });

  it('reads the latest preview deployment exactly like the pin step', async () => {
    const deployment = {
      id: 123,
      environment: 'pr-preview',
      task: 'ota-preview-pr-7',
      description: 'OTA preview pr-7',
      transient_environment: true,
      production_environment: false,
      sha: HEAD,
      created_at: '2026-10-26T10:00:00Z',
      payload: {
        otaPreviewBases: {
          version: 1,
          mainSha: MAIN_OLD,
          trainSha: '',
          sourceBaseRef: 'main',
          sourceBaseSha: MAIN_OLD,
        },
      },
    };
    const pr = (number: number) => ({
      ...deployment,
      task: `ota-preview-pr-${number}`,
      description: `OTA preview pr-${number}`,
    });
    const status = (state: string) => [{ state, created_at: '2026-10-26T10:05:00Z' }];
    const routes = new Map<string, unknown>([
      ['/deployments?environment=pr-preview&task=ota-preview-pr-7&per_page=3', [deployment]],
      ['/deployments/123/statuses?per_page=1', status('success')],
      ['/deployments?environment=pr-preview&task=ota-preview-pr-8&per_page=3', []],
      ['/deployments?environment=pr-preview&task=ota-preview-pr-9&per_page=3', [{ ...deployment, task: 'other' }]],
      ['/deployments?environment=pr-preview&task=ota-preview-pr-10&per_page=3', [{ ...pr(10), id: 200 }]],
      ['/deployments/200/statuses?per_page=1', []],
      [
        '/deployments?environment=pr-preview&task=ota-preview-pr-11&per_page=3',
        [
          { ...pr(11), id: 301 },
          { ...pr(11), id: 302, sha: sha('b') },
          { ...pr(11), id: 303 },
        ],
      ],
      ['/deployments/301/statuses?per_page=1', status('failure')],
      ['/deployments/302/statuses?per_page=1', status('failure')],
    ]);
    const fetchImpl = vi.fn(async (url: string | URL | Request, _init?: RequestInit) => {
      const path = (typeof url === 'string' ? url : url instanceof URL ? url.href : url.url).replace(
        'https://api.github.com/repos/boardsesh/boardsesh',
        '',
      );
      return routes.has(path) ? jsonResponse(routes.get(path)) : jsonResponse({}, 404);
    });
    const api = createGitHubRefreshApi({ token: 't', repository: 'boardsesh/boardsesh', fetchImpl });
    expect(await api.latestPreview(7)).toMatchObject({
      kind: 'found',
      status: 'success',
      statusAt: '2026-10-26T10:05:00Z',
      recent: [{ sha: HEAD, status: 'success' }],
    });
    // No status yet: the deployment's own creation time dates the attempt.
    expect(await api.latestPreview(10)).toMatchObject({ status: '', statusAt: '2026-10-26T10:00:00Z' });
    // A failure reads the attempt before it, for the failed-twice cap.
    expect(await api.latestPreview(11)).toMatchObject({
      status: 'failure',
      recent: [
        { sha: HEAD, status: 'failure' },
        { sha: sha('b'), status: 'failure' },
      ],
    });
    expect(await api.latestPreview(8)).toEqual({ kind: 'missing' });
    expect(await api.latestPreview(9)).toEqual({ kind: 'unreadable', detail: 'unexpected deployment identity' });
    expect(await api.branchHead('release/next')).toBeNull();
    expect(fetchImpl).toHaveBeenLastCalledWith(
      'https://api.github.com/repos/boardsesh/boardsesh/branches/release%2Fnext',
      expect.anything(),
    );
  });

  it('treats only non-inactive preview deployments as live, walking back through history', async () => {
    const page = (nodes: unknown[], hasPreviousPage: boolean, startCursor: string | null) =>
      jsonResponse({
        data: {
          repository: { pullRequest: { timelineItems: { nodes, pageInfo: { hasPreviousPage, startCursor } } } },
        },
      });
    const event = (state: string, description = 'OTA preview pr-7', environment = 'pr-preview') => ({
      deployment: { environment, description, latestStatus: { state } },
    });
    const apiOver = (pages: Response[]) =>
      createGitHubRefreshApi({
        token: 't',
        repository: 'boardsesh/boardsesh',
        fetchImpl: vi.fn(
          async (_url: string | URL | Request, _init?: RequestInit) => pages.shift() ?? jsonResponse({}, 500),
        ),
      });

    // Another PR's preview, another environment and a removed preview are not live;
    // an older failed partial upload still is.
    const live = apiOver([
      page([event('INACTIVE'), event('SUCCESS', 'OTA preview pr-8'), event('SUCCESS', 'x', 'web')], true, 'older'),
      page([event('FAILURE')], false, null),
    ]);
    expect(await live.hasLivePreview(7)).toBe(true);
    expect(await apiOver([page([event('INACTIVE')], false, null)]).hasLivePreview(7)).toBe(false);
    await expect(apiOver([page([], true, 'same'), page([], true, 'same')]).hasLivePreview(7)).rejects.toThrow(
      'Invalid preview deployment history cursor',
    );
  });
});

async function runDispatch(dispatch: string) {
  const script = refresh.jobs.dispatch.steps[0].with?.script;
  if (!script) throw new Error('Dispatch script missing');
  const actions = { createWorkflowDispatch: vi.fn(async (_request: unknown) => ({})) };
  const core = { info: vi.fn() };
  const previous = process.env.DISPATCH;
  process.env.DISPATCH = dispatch;
  try {
    // Execute the workflow's own code with injected API objects.
    // oxlint-disable-next-line no-implied-eval
    const run = new Function('github', 'context', 'core', `return (async () => {\n${script}\n})();`) as (
      github: unknown,
      context: unknown,
      core: unknown,
    ) => Promise<void>;
    await run(
      { rest: { actions } },
      { repo: { owner: 'boardsesh', repo: 'boardsesh' }, payload: { repository: { default_branch: 'main' } } },
      core,
    );
  } finally {
    if (previous === undefined) delete process.env.DISPATCH;
    else process.env.DISPATCH = previous;
  }
  return actions.createWorkflowDispatch;
}

describe('refresh workflow shape', () => {
  it('plans with a read-only token from the workflow’s own trusted commit, installing nothing', () => {
    const plan = refresh.jobs.plan;
    expect(refresh.permissions).toEqual({ contents: 'read' });
    expect(plan.permissions).toEqual({ contents: 'read', deployments: 'read', 'pull-requests': 'read' });
    const checkout = plan.steps.find((step) => step.uses?.startsWith('actions/checkout@'));
    expect(checkout?.with).toEqual({
      ref: '${{ github.workflow_sha }}',
      'persist-credentials': false,
      'sparse-checkout': 'scripts',
    });
    const runs = plan.steps.flatMap((step) => (step.run ? [step.run] : []));
    expect(runs).toEqual(['node --experimental-strip-types scripts/mobile-ota-preview-refresh.ts']);
    expect(JSON.stringify(refresh)).not.toMatch(/vp install|pnpm|npm (?:ci|install)|head\.sha|head_sha/);
    expect(JSON.stringify([plan, refresh.jobs.dispatch])).not.toContain('secrets.');
    expect(plan.outputs?.dispatch).toBe('${{ steps.plan.outputs.dispatch }}');
  });

  it('dispatches from a job that holds only actions:write and runs no checked-out code', () => {
    const dispatch = refresh.jobs.dispatch;
    expect(dispatch.needs).toBe('plan');
    expect(dispatch.permissions).toEqual({ actions: 'write' });
    expect(dispatch.steps.map((step) => step.uses?.split('@')[0])).toEqual(['actions/github-script']);
    expect(dispatch.if).toContain("needs.plan.outputs.dispatch != '[]'");
  });

  it('holds the refresh lane on plan only, so a parked notify cannot wedge it', () => {
    expect(refresh.concurrency).toBeUndefined();
    expect(refresh.jobs.plan.concurrency).toEqual({
      group: 'mobile-ota-preview-base-refresh',
      'cancel-in-progress': false,
    });
  });

  it('posts a failed push run to Discord with the webhook and nothing else', async () => {
    const notify = refresh.jobs.notify;
    expect(notify.needs).toEqual(['plan', 'dispatch']);
    expect(notify.if).toBe("${{ failure() && github.event_name == 'push' }}");
    expect(notify.permissions).toEqual({});
    // DISCORD_DEPLOY_WEBHOOK is a Production environment secret (docs/mobile-e2e-gate.md).
    expect(notify.environment).toBe('Production');
    expect(notify.steps.some((step) => step.uses)).toBe(false);
    expect(JSON.stringify(notify).match(/secrets\.[A-Z_]+/g)).toEqual(['secrets.DISCORD_DEPLOY_WEBHOOK']);
    const run = notify.steps[0].run ?? '';
    expect(run).toContain('allowed_mentions: {parse: []}');
    expect(run).toContain('curl -sS --fail-with-body -X POST');
    expect(run).toMatch(/if \[ -z "\$\{DISCORD_DEPLOY_WEBHOOK:-\}" \]; then[\s\S]*exit 0/);
  });

  it('queues the default-branch publisher once per planned PR', async () => {
    const createWorkflowDispatch = await runDispatch('[7,12]');
    const request = (pr: string) => ({
      owner: 'boardsesh',
      repo: 'boardsesh',
      workflow_id: 'mobile-ota-preview.yml',
      ref: 'main',
      inputs: { pr },
    });
    expect(createWorkflowDispatch.mock.calls).toEqual([[request('7')], [request('12')]]);
  });

  it.each(['{"pr":7}', '["7"]', '[0]', '[1.5]'])('rejects a malformed plan %s', async (dispatch) => {
    await expect(runDispatch(dispatch)).rejects.toThrow('list of PR numbers');
  });

  it('hands an absorbed PR to the gate, which selects cleanup', async () => {
    // The planner dispatched PR 7 because its base absorbed the last mobile
    // file while a preview was live. The trusted gate re-resolves it.
    const prData = {
      number: 7,
      state: 'open',
      head: { sha: sha('a'), ref: 'feature', repo: { full_name: 'boardsesh/boardsesh' } },
    };
    const github = {
      rest: { pulls: { get: vi.fn(async () => ({ data: prData })), listFiles: vi.fn() } },
      paginate: vi.fn(async () => [{ filename: 'packages/web/app/page.tsx' }]),
    };
    const outputs = new Map<string, unknown>();
    const core = {
      info: vi.fn(),
      notice: vi.fn(),
      setOutput: (key: string, result: unknown) => outputs.set(key, result),
    };
    // oxlint-disable-next-line no-implied-eval
    const run = new Function('github', 'context', 'core', `return (async () => {\n${decideScript}\n})();`) as (
      github: unknown,
      context: unknown,
      core: unknown,
    ) => Promise<void>;
    await run(
      github,
      {
        repo: { owner: 'boardsesh', repo: 'boardsesh' },
        eventName: 'workflow_dispatch',
        payload: { repository: { default_branch: 'main' }, inputs: { pr: '7' } },
      },
      core,
    );
    expect(outputs.get('action')).toBe('cleanup');
    expect(outputs.get('cleanup_reason')).toBe('no-mobile');
    expect(outputs.get('head_sha')).toBe(sha('a'));
  });
});

describe('publisher reset marks the record it is about to invalidate', () => {
  const reset = publisher.jobs.reset;
  const markIndex = reset.steps.findIndex((step) => step.name === 'Mark the previous preview record stale');
  const markScript = reset.steps[markIndex]?.with?.script ?? '';

  it('runs before the delete with deployments:write and no checkout', () => {
    expect(markIndex).toBe(0);
    expect(reset.steps[1].name).toBe('Reset preview branch before publish');
    expect(reset.permissions).toEqual({ contents: 'read', deployments: 'write', 'pull-requests': 'read' });
    expect(reset.steps.some((step) => step.uses?.startsWith('actions/checkout@'))).toBe(false);
  });

  async function runMark(deployments: unknown[]) {
    const repos = {
      listDeployments: vi.fn(async (_request: unknown) => ({ data: deployments })),
      createDeploymentStatus: vi.fn(async (_request: unknown) => ({})),
    };
    const previous = process.env.PR_NUMBER;
    process.env.PR_NUMBER = '7';
    try {
      // oxlint-disable-next-line no-implied-eval
      const run = new Function('github', 'context', 'core', `return (async () => {\n${markScript}\n})();`) as (
        github: unknown,
        context: unknown,
        core: unknown,
      ) => Promise<void>;
      await run({ rest: { repos } }, { repo: { owner: 'boardsesh', repo: 'boardsesh' } }, { info: vi.fn() });
    } finally {
      if (previous === undefined) delete process.env.PR_NUMBER;
      else process.env.PR_NUMBER = previous;
    }
    return repos;
  }

  it('turns the latest success into an error the refresh planner re-dispatches', async () => {
    const repos = await runMark([{ id: 123 }]);
    expect(repos.listDeployments).toHaveBeenCalledWith({
      owner: 'boardsesh',
      repo: 'boardsesh',
      environment: 'pr-preview',
      task: 'ota-preview-pr-7',
      per_page: 1,
    });
    expect(repos.createDeploymentStatus).toHaveBeenCalledWith({
      owner: 'boardsesh',
      repo: 'boardsesh',
      deployment_id: 123,
      state: 'error',
      description: 'Reset, republish pending',
    });
    const { recorded, current } = heads();
    const marked = found('error', TRAIN_OLD, { recent: [{ sha: HEAD, status: 'error' }] });
    expect(decidePreviewRefresh(marked, current, recorded, { headSha: HEAD }).dispatch).toBe(true);
  });

  it('leaves a first publish alone', async () => {
    const repos = await runMark([]);
    expect(repos.createDeploymentStatus).not.toHaveBeenCalled();
  });
});
