/// <reference types="node" />

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  EARLY_UPDATES_BRANCH,
  ROLLOUT_PROOF_BRANCH,
  STABLE_BRANCH,
  STAGING_BRANCH,
  desiredOtaState,
} from '../infra/ota/config';
import { FAKE_BASE_URL } from './__tests__/helpers/fake-xprem';
import { fakeRolloutServer } from './__tests__/helpers/fake-xprem-rollouts';
import type { RolloutServerQuirks } from './__tests__/helpers/fake-xprem-rollouts';
import { OTA_APP_ID } from './lib/ota-branch-probe';
import { buildUploadFiles, validateExport } from './lib/ota-publish-protocol';
import type { XpremChannel } from './lib/xprem-admin.mts';
import {
  assertBranchNotServed,
  assertProofBranch,
  assertProofRuntimeVersion,
  classifyStep,
  createMasker,
  createProofFetch,
  formatTranscript,
  parseProofArgs,
  proofClientIds,
  proofRuntimeVersion,
  requestRefusal,
  runRolloutProof,
  runSteps,
  sanitizeBody,
  writeSyntheticExport,
} from './ota-rollout-proof';
import type { ProofReport, StepDefinition } from './ota-rollout-proof';

const NOW = new Date('2026-10-05T10:11:12.345Z');
const RUNTIME = 'rollout-proof-20261005T101112Z-a1b2c3';
const ADMIN_EMAIL = 'owner@boardsesh.example';
const ADMIN_PASSWORD = 'correct-horse-battery';
const PUBLISH_TOKEN = 'eoo_publish_token_value';

const temporaryDirectories: string[] = [];
afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});
function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'boardsesh-rollout-proof-test-'));
  temporaryDirectories.push(directory);
  return directory;
}

const channel = (overrides: Partial<XpremChannel>): XpremChannel => ({
  releaseChannelId: 1,
  releaseChannelName: 'production',
  branchId: 1,
  branchName: 'production',
  branchSurfing: { enabled: true, pattern: 'pr-*' },
  rollout: null,
  ...overrides,
});

describe('the branch guard', () => {
  it('accepts the scratch branch and nothing else', () => {
    expect(() => assertProofBranch(ROLLOUT_PROOF_BRANCH, desiredOtaState)).not.toThrow();
    for (const branch of [STABLE_BRANCH, EARLY_UPDATES_BRANCH, STAGING_BRANCH, 'pr-123', 'pr-rollout-proof-2', '']) {
      expect(() => assertProofBranch(branch, desiredOtaState), branch).toThrow(
        `The rollout proof only runs against "pr-rollout-proof", not "${branch}".`,
      );
    }
  });

  it('refuses the scratch branch once the declaration treats it as long-lived', () => {
    const declared = {
      ...desiredOtaState,
      branches: [...desiredOtaState.branches, { name: ROLLOUT_PROOF_BRANCH, protected: false, reason: 'a mistake' }],
    };
    expect(() => assertProofBranch(ROLLOUT_PROOF_BRANCH, declared)).toThrow('is a declared long-lived branch');
    const mapped = {
      ...desiredOtaState,
      channels: [{ ...desiredOtaState.channels[0], branch: ROLLOUT_PROOF_BRANCH }],
    };
    expect(() => assertProofBranch(ROLLOUT_PROOF_BRANCH, mapped)).toThrow(
      'is named by the declared channel "production"',
    );
  });

  it('is not one of the declared long-lived branches today', () => {
    expect(desiredOtaState.branches.map((branch) => branch.name)).not.toContain(ROLLOUT_PROOF_BRANCH);
  });

  it('refuses a branch the server serves through any channel', () => {
    expect(() => assertBranchNotServed(ROLLOUT_PROOF_BRANCH, [channel({})])).not.toThrow();
    expect(() =>
      assertBranchNotServed(ROLLOUT_PROOF_BRANCH, [channel({}), channel({ branchName: ROLLOUT_PROOF_BRANCH })]),
    ).toThrow('The server maps channel "production" to "pr-rollout-proof"');
    expect(() =>
      assertBranchNotServed(ROLLOUT_PROOF_BRANCH, [channel({ releaseChannelName: ROLLOUT_PROOF_BRANCH })]),
    ).toThrow('The server has a release channel named "pr-rollout-proof"');
    expect(() =>
      assertBranchNotServed(ROLLOUT_PROOF_BRANCH, [
        channel({ rollout: { percentage: 5, rolloutBranchName: ROLLOUT_PROOF_BRANCH } }),
      ]),
    ).toThrow('is rolling out to "pr-rollout-proof"');
  });
});

describe('the runtime version guard', () => {
  it('mints a timestamped version no binary can hold', () => {
    expect(proofRuntimeVersion(NOW, 'a1b2c3')).toBe(RUNTIME);
    expect(() => assertProofRuntimeVersion(proofRuntimeVersion(NOW))).not.toThrow();
    expect(proofRuntimeVersion(NOW)).not.toBe(proofRuntimeVersion(NOW, '000000'));
  });

  it('rejects a real-looking runtime version', () => {
    expect(() => assertProofRuntimeVersion('b'.repeat(40))).toThrow('looks like a real fingerprint or app version');
    expect(() => assertProofRuntimeVersion('2.6.0')).toThrow('looks like a real fingerprint or app version');
    for (const runtimeVersion of [
      '',
      'rollout-proof-',
      'rollout-proof-20261005T101112Z',
      `${RUNTIME}-x`,
      'exposdk:57.0.0',
    ]) {
      expect(() => assertProofRuntimeVersion(runtimeVersion), runtimeVersion).toThrow(
        'is not a rollout-proof runtime version',
      );
    }
  });
});

describe('the request allowlist', () => {
  const scope = {
    base: new URL(FAKE_BASE_URL),
    appId: OTA_APP_ID,
    branch: ROLLOUT_PROOF_BRANCH,
    runtimeVersion: RUNTIME,
  };
  const app = `/api/apps/${OTA_APP_ID}`;
  const refusal = (method: string, path: string, headers: Record<string, string> = {}): string | null =>
    requestRefusal({ url: new URL(path, FAKE_BASE_URL), method, headers: new Headers(headers) }, scope);
  const probeHeaders = { 'xprem-branch': ROLLOUT_PROOF_BRANCH, 'expo-runtime-version': RUNTIME };

  it('lets through the calls the sequence makes', () => {
    const scoped = `${app}/branch/${ROLLOUT_PROOF_BRANCH}/runtimeVersion/${RUNTIME}`;
    for (const [method, path] of [
      ['POST', '/auth/login'],
      ['GET', `${app}/channels`],
      ['GET', `${app}/branches`],
      ['GET', `${app}/identity/update-health?ids=a,b`],
      ['GET', `${app}/observe/update-health/history?ids=a`],
      ['GET', `${scoped}/rollout`],
      ['PUT', `${scoped}/rollout`],
      ['POST', `${scoped}/rollout/revert`],
      ['GET', `${scoped}/updates?limit=50`],
      ['GET', `${scoped}/updates/17911745123242`],
      ['POST', `/${OTA_APP_ID}/requestUploadUrl/${ROLLOUT_PROOF_BRANCH}?runtimeVersion=${RUNTIME}&platform=ios`],
      ['POST', `/${OTA_APP_ID}/markUpdateAsUploaded/${ROLLOUT_PROOF_BRANCH}?runtimeVersion=${RUNTIME}`],
      ['POST', `/${OTA_APP_ID}/republish/${ROLLOUT_PROOF_BRANCH}?runtimeVersion=${RUNTIME}`],
      ['POST', `/${OTA_APP_ID}/rollback/${ROLLOUT_PROOF_BRANCH}?runtimeVersion=${RUNTIME}`],
      ['PUT', `/${OTA_APP_ID}/uploadLocalFile`],
    ]) {
      expect(refusal(method, path), `${method} ${path}`).toBeNull();
    }
    expect(refusal('GET', '/manifest', probeHeaders)).toBeNull();
    expect(refusal('PUT', 'https://bucket.example/key?sig=1')).toBeNull();
  });

  it.each([
    ['a publish to production', 'POST', `/${OTA_APP_ID}/requestUploadUrl/production?runtimeVersion=${RUNTIME}`],
    [
      'a publish to the early-updates branch',
      'POST',
      `/${OTA_APP_ID}/requestUploadUrl/pr-beta?runtimeVersion=${RUNTIME}`,
    ],
    ['a publish to a per-PR branch', 'POST', `/${OTA_APP_ID}/markUpdateAsUploaded/pr-123?runtimeVersion=${RUNTIME}`],
    [
      'a publish under a real fingerprint',
      'POST',
      `/${OTA_APP_ID}/requestUploadUrl/${ROLLOUT_PROOF_BRANCH}?runtimeVersion=${'b'.repeat(40)}`,
    ],
    ['a rollback on production', 'POST', `/${OTA_APP_ID}/rollback/production?runtimeVersion=${RUNTIME}`],
    ['a rollout write on production', 'PUT', `${app}/branch/production/runtimeVersion/${RUNTIME}/rollout`],
    [
      'a rollout write on another runtime version',
      'PUT',
      `${app}/branch/${ROLLOUT_PROOF_BRANCH}/runtimeVersion/${'b'.repeat(40)}/rollout`,
    ],
    ['a revert on the staging branch', 'POST', `${app}/branch/pr-staging/runtimeVersion/${RUNTIME}/rollout/revert`],
    ['creating a channel', 'POST', `${app}/channels`],
    ['changing Branch Surfing', 'PUT', `${app}/channels/production/branch-surfing`],
    ['remapping a channel', 'POST', `${app}/branch/7/updateChannelBranchMapping`],
    ['creating a branch', 'POST', `${app}/branches`],
    ['changing branch protection', 'PUT', `${app}/branches/${ROLLOUT_PROOF_BRANCH}/protection`],
    ['deleting the scratch branch', 'DELETE', `${app}/branches/${ROLLOUT_PROOF_BRANCH}`],
    ['deleting an update', 'DELETE', `${app}/branch/${ROLLOUT_PROOF_BRANCH}/runtimeVersion/${RUNTIME}/updates/1`],
    ['a read from another origin', 'GET', 'https://example.com/anything'],
    ['an upload over plain http', 'PUT', 'http://bucket.example/key'],
  ])('refuses %s', (_what, method, path) => {
    expect(refusal(method, path)).not.toBeNull();
  });

  it('refuses a manifest probe of another branch or runtime version', () => {
    expect(refusal('GET', '/manifest', { ...probeHeaders, 'xprem-branch': '' })).toBe(
      'a manifest probe of another branch',
    );
    expect(refusal('GET', '/manifest', { ...probeHeaders, 'xprem-branch': 'pr-beta' })).not.toBeNull();
    expect(refusal('GET', '/manifest', { ...probeHeaders, 'expo-runtime-version': 'b'.repeat(40) })).toBe(
      'a manifest probe of another runtime version',
    );
  });

  it('never sends a refused request', async () => {
    let sent = 0;
    const proofFetch = createProofFetch({
      ...scope,
      mask: (text) => text,
      fetchImpl: (async () => {
        sent += 1;
        return Response.json({});
      }) as typeof fetch,
    });
    await expect(
      proofFetch.fetchImpl(`${FAKE_BASE_URL}/${OTA_APP_ID}/requestUploadUrl/production?runtimeVersion=${RUNTIME}`, {
        method: 'POST',
      }),
    ).rejects.toThrow('Refused before sending');
    expect(sent).toBe(0);
    expect(proofFetch.takeExchanges()).toEqual([]);
  });
});

describe('masking', () => {
  const mask = createMasker([ADMIN_EMAIL, ADMIN_PASSWORD, PUBLISH_TOKEN, undefined, '']);

  it('removes known secrets, emails, bearer credentials and JWTs', () => {
    const masked = mask(
      `login ${ADMIN_EMAIL} / ${ADMIN_PASSWORD}, Authorization: Bearer ${PUBLISH_TOKEN}, ` +
        'session eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJl, other someone@else.example',
    );
    expect(masked).not.toContain(ADMIN_EMAIL);
    expect(masked).not.toContain(ADMIN_PASSWORD);
    expect(masked).not.toContain(PUBLISH_TOKEN);
    expect(masked).not.toContain('eyJhbGci');
    expect(masked).not.toContain('someone@else.example');
  });

  it('redacts credential-bearing keys and keeps the type of an id', () => {
    const sanitized = sanitizeBody(
      {
        token: 'abc',
        refreshToken: 'def',
        updateId: 17911745123242,
        uploadRequests: [
          {
            requestUploadUrl: 'https://bucket.example/k?X-Amz-Signature=s',
            headers: { a: 'b' },
            filePath: 'metadata.json',
          },
        ],
        owner: 'someone@else.example',
        updates: [{ updateId: '17911745123242' }],
      },
      mask,
    );
    expect(sanitized).toEqual({
      token: '[redacted]',
      refreshToken: '[redacted]',
      updateId: 17911745123242,
      uploadRequests: [{ requestUploadUrl: '[redacted]', headers: '[redacted]', filePath: 'metadata.json' }],
      owner: '[email]',
      updates: [{ updateId: '17911745123242' }],
    });
  });

  it('cuts long lists and long strings', () => {
    expect(
      sanitizeBody(
        Array.from({ length: 9 }, (unused, index) => index),
        mask,
      ),
    ).toEqual([0, 1, 2, 3, 4, 5, '… (3 more)']);
    expect(String(sanitizeBody('x'.repeat(400), mask))).toHaveLength(300 + '… (400 chars)'.length);
  });
});

describe('the synthetic export', () => {
  it('is an export the publish protocol validates, with exactly one launch file and no assets', () => {
    const synthetic = writeSyntheticExport({
      root: temporaryDirectory(),
      platform: 'ios',
      appId: OTA_APP_ID,
      runtimeVersion: RUNTIME,
      label: 'A',
    });
    const validated = validateExport(synthetic.directory, 'ios', synthetic.bundleSha256);
    expect(validated.appId).toBe(OTA_APP_ID);
    expect(validated.assetPaths).toEqual([]);
    const files = buildUploadFiles(validated);
    expect(files.map((file) => [file.path, file.role])).toEqual([
      ['metadata.json', 'config'],
      ['expoConfig.json', 'config'],
      ['_expo/static/js/ios/rollout-proof-a.js', 'launch'],
    ]);
    // What the server checks on each entry: a canonical base64url SHA-256, and an md5 key on the launch file.
    for (const file of files) expect(file.hash).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(files[2].key).toMatch(/^[0-9a-f]{32}$/);
    expect(files[2].hash).toBe(synthetic.bundleHash);
  });

  it('is a few inert bytes that say what they are', () => {
    const synthetic = writeSyntheticExport({
      root: temporaryDirectory(),
      platform: 'android',
      appId: OTA_APP_ID,
      runtimeVersion: RUNTIME,
      label: 'B',
    });
    const bundle = readFileSync(join(synthetic.directory, '_expo/static/js/android/rollout-proof-b.js'), 'utf8');
    expect(bundle).toContain('Boardsesh OTA rollout proof');
    expect(bundle.length).toBeLessThan(300);
    // Comments only: nothing to execute.
    expect(bundle.split('\n').filter((line) => line !== '' && !line.startsWith('//'))).toEqual([]);
    const metadata = JSON.parse(readFileSync(join(synthetic.directory, 'metadata.json'), 'utf8')) as {
      fileMetadata: Record<string, unknown>;
    };
    expect(Object.keys(metadata.fileMetadata)).toEqual(['android']);
  });

  it('gives every label, platform and run different bytes, so the server never answers "no changes"', () => {
    const root = temporaryDirectory();
    const hashOf = (label: string, platform: 'ios' | 'android', runtimeVersion: string): string =>
      writeSyntheticExport({ root, platform, appId: OTA_APP_ID, runtimeVersion, label }).bundleHash;
    const hashes = [
      hashOf('A', 'ios', RUNTIME),
      hashOf('B', 'ios', RUNTIME),
      hashOf('A', 'android', RUNTIME),
      hashOf('A', 'ios', proofRuntimeVersion(NOW, 'ffffff')),
    ];
    expect(new Set(hashes).size).toBe(hashes.length);
  });
});

describe('simulated device ids', () => {
  it('are forty distinct ids that the Observe registry would not take for devices', () => {
    const ids = proofClientIds(RUNTIME, false);
    expect(new Set(ids).size).toBe(40);
    for (const id of ids) expect(id).toMatch(/^rollout-proof-20261005T101112Z-a1b2c3-device-\d{2}$/);
  });

  it('can be real UUIDs on request', () => {
    for (const id of proofClientIds(RUNTIME, true)) {
      expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    }
  });
});

describe('the step runner', () => {
  const noExchanges = (): never[] => [];
  const plain = (text: string): string => text;
  const run = (steps: StepDefinition[]) => runSteps(steps, noExchanges, plain);

  it('classifies a step by its findings', () => {
    expect(classifyStep([{ outcome: 'PASS', text: '' }])).toBe('PASS');
    expect(classifyStep([{ outcome: 'OBSERVED', text: '' }])).toBe('OBSERVED');
    expect(classifyStep([])).toBe('OBSERVED');
    expect(
      classifyStep([
        { outcome: 'PASS', text: '' },
        { outcome: 'OBSERVED', text: '' },
      ]),
    ).toBe('PASS');
    expect(
      classifyStep([
        { outcome: 'PASS', text: '' },
        { outcome: 'FAIL', text: '' },
        { outcome: 'OBSERVED', text: '' },
      ]),
    ).toBe('FAIL');
  });

  it('continues past an observed step and past a failed expectation', async () => {
    const results = await run([
      { id: 'one', title: 'Observe', run: async (recorder) => recorder.observe('seen') },
      { id: 'two', title: 'Fail softly', needs: ['one'], run: async (recorder) => recorder.expect(false, 'yes', 'no') },
      { id: 'three', title: 'Pass', needs: ['two'], run: async (recorder) => recorder.expect(true, 'yes', 'no') },
    ]);
    expect(results.map((step) => step.outcome)).toEqual(['OBSERVED', 'FAIL', 'PASS']);
    expect(results[1].findings).toEqual([{ outcome: 'FAIL', text: 'no' }]);
  });

  it('skips what needs a blocked step, and still returns every step', async () => {
    const ran: string[] = [];
    const results = await run([
      { id: 'a', title: 'Block', run: async (recorder) => recorder.block('the publish was refused') },
      { id: 'b', title: 'Needs a', needs: ['a'], run: async () => void ran.push('b') },
      { id: 'c', title: 'Needs b', needs: ['b'], run: async () => void ran.push('c') },
      { id: 'd', title: 'Needs nothing', run: async (recorder) => recorder.pass('ran') },
    ]);
    expect(results.map((step) => [step.id, step.outcome])).toEqual([
      ['a', 'FAIL'],
      ['b', 'SKIPPED'],
      ['c', 'SKIPPED'],
      ['d', 'PASS'],
    ]);
    expect(ran).toEqual([]);
    expect(results[0].findings).toEqual([{ outcome: 'FAIL', text: 'the publish was refused' }]);
    expect(results[1].skippedBecause).toBe('step a did not complete');
    expect(results[2].skippedBecause).toBe('step b did not complete');
    expect(results[3].skippedBecause).toBeNull();
  });

  it('treats a thrown error as a blocking failure and keeps the findings before it', async () => {
    const results = await run([
      {
        id: 'a',
        title: 'Throws',
        run: async (recorder) => {
          recorder.pass('first check held');
          throw new Error('socket hang up');
        },
      },
      { id: 'b', title: 'Needs a', needs: ['a'], run: async () => undefined },
    ]);
    expect(results[0].outcome).toBe('FAIL');
    expect(results[0].findings).toEqual([
      { outcome: 'PASS', text: 'first check held' },
      { outcome: 'FAIL', text: 'The step stopped on an error: socket hang up' },
    ]);
    expect(results[1].outcome).toBe('SKIPPED');
  });

  it('masks findings and hands each step the requests made during it', async () => {
    const pending = [[{ method: 'GET', path: '/one', status: 200, body: null, count: 1 }], []];
    const results = await runSteps(
      [
        { id: 'a', title: 'A', run: async (recorder) => recorder.observe(`saw ${ADMIN_EMAIL}`) },
        { id: 'b', title: 'B', run: async (recorder) => recorder.record('answer', 42) },
      ],
      () => pending.shift() ?? [],
      createMasker([ADMIN_EMAIL]),
    );
    expect(results[0].findings[0].text).toBe('saw [masked]');
    expect(results[0].exchanges).toHaveLength(1);
    expect(results[1].exchanges).toEqual([]);
    expect(results[1].data).toEqual({ answer: 42 });
  });
});

describe('the sequence against a fake server', () => {
  const runAgainst = async (quirks: RolloutServerQuirks = {}, uuidClientIds = false) => {
    const server = fakeRolloutServer(quirks);
    const report = await runRolloutProof({
      manifestUrl: `${FAKE_BASE_URL}/manifest`,
      adminEmail: ADMIN_EMAIL,
      adminPassword: ADMIN_PASSWORD,
      publishToken: PUBLISH_TOKEN,
      uuidClientIds,
      now: NOW,
      fetchImpl: server.fetchImpl,
      settleDelaysMs: [],
      probeSettleMs: 0,
      uploadPaceMs: 0,
    });
    return { server, report };
  };
  const outcomes = (report: ProofReport): Record<string, string> =>
    Object.fromEntries(report.steps.map((step) => [step.id, step.outcome]));
  const findings = (report: ProofReport, id: string): string =>
    (report.steps.find((step) => step.id === id)?.findings ?? [])
      .map((finding) => `${finding.outcome}: ${finding.text}`)
      .join('\n');

  it('runs every step, in order, and none fails', async () => {
    const { report } = await runAgainst();
    expect(report.steps.map((step) => step.id)).toEqual([
      'guards',
      'a',
      'b',
      'c',
      'd',
      'e',
      'f',
      'g',
      'h-start',
      'i',
      'h-finish',
      'j',
    ]);
    expect(outcomes(report)).toEqual({
      guards: 'PASS',
      a: 'PASS',
      b: 'PASS',
      c: 'PASS',
      d: 'PASS',
      e: 'PASS',
      f: 'PASS',
      g: 'PASS',
      'h-start': 'PASS',
      i: 'PASS',
      'h-finish': 'PASS',
      j: 'OBSERVED',
    });
    expect(report.ok).toBe(true);
    expect(report.branch).toBe('pr-rollout-proof');
    expect(report.runtimeVersion).toMatch(/^rollout-proof-20261005T101112Z-[0-9a-f]{6}$/);
  });

  it('records what the questions asked for', async () => {
    const { report } = await runAgainst();
    expect(findings(report, 'a')).toContain('The lease serialises updateId as a number.');
    expect(findings(report, 'a')).toContain('Manifest probes are meaningful for this run.');
    expect(findings(report, 'b')).toContain(
      'GET …/rollout returns 2 entries, one per platform (android, ios), not one for both.',
    );
    expect(findings(report, 'b')).toContain('updateId is a string, controlUpdateId a string');
    expect(findings(report, 'b')).toContain('PASS: ios: controlUpdateId is present and names A');
    expect(findings(report, 'c')).toContain('PASS: ios: a request with no EAS-Client-ID is served A, the control.');
    expect(findings(report, 'c')).toContain('Assignment is sticky.');
    expect(findings(report, 'd')).toContain(
      'Publishing at 100% during the rollout is refused with HTTP 409 at lease (ios).',
    );
    expect(findings(report, 'd')).toContain(
      'PASS: Republishing A (android) during the rollout is refused with HTTP 409.',
    );
    expect(findings(report, 'd')).toContain(
      'PASS: A rollback to embedded (android) during the rollout is refused with HTTP 409.',
    );
    expect(findings(report, 'e')).toContain('none removed');
    expect(findings(report, 'f')).toContain('health is absent from the answer');
    expect(findings(report, 'g')).toContain('a new id, neither A nor B');
    expect(findings(report, 'g')).toContain(
      "PASS: ios: devices are served A's bundle again (A (same bundle, new update id)).",
    );
    expect(findings(report, 'g')).toContain('PASS: Publishing is unlocked: update C at 100% was accepted.');
    expect(findings(report, 'i')).toContain(
      'PUT …/rollout with a wrong expectedUpdateId (sent as a string) is refused with HTTP 409.',
    );
    expect(findings(report, 'i')).toContain('sent as a JSON number is refused with HTTP 400');
    expect(findings(report, 'i')).toContain(
      'POST …/rollout/revert with a wrong expectedUpdateId is refused with HTTP 409.',
    );
    expect(findings(report, 'h-finish')).toContain('the anonymous request and all 40 simulated devices are served D');
    expect(findings(report, 'h-finish')).toContain('PASS: Publishing is unlocked: update E at 100% was accepted.');
    expect(findings(report, 'j')).toContain(
      'One PUT or revert acted on every platform that shares the runtime version',
    );
    expect(report.steps.find((step) => step.id === 'j')?.data.writeCalls).toEqual([
      expect.objectContaining({ operation: 'set 25%', calls: 1, platformsBefore: 2 }),
      expect.objectContaining({ operation: 'set 50%', calls: 1, platformsBefore: 2 }),
      expect.objectContaining({ operation: 'revert', calls: 1, platformsBefore: 2, platformsAfter: 'no live rollout' }),
      expect.objectContaining({ operation: 'finish', calls: 1, platformsBefore: 2, platformsAfter: 'no live rollout' }),
    ]);
  });

  it('only ever names the scratch branch and its own runtime version', async () => {
    const { server, report } = await runAgainst();
    const branchSegment = /\/(?:branch|requestUploadUrl|markUpdateAsUploaded|republish|rollback)\/([^/?]+)/;
    for (const request of server.requests) {
      const named = branchSegment.exec(request.path)?.[1];
      if (named !== undefined) expect(named, request.path).toBe('pr-rollout-proof');
      if (request.path.startsWith('/manifest')) {
        expect(request.headers['xprem-branch']).toBe('pr-rollout-proof');
        expect(request.headers['expo-channel-name']).toBe('production');
        expect(request.headers['expo-runtime-version']).toBe(report.runtimeVersion);
      }
      expect(request.method, request.path).not.toBe('DELETE');
    }
    const writes = server.requests
      .filter((request) => request.method !== 'GET')
      .map((request) => request.path.split('?')[0]);
    expect(writes.filter((path) => path.includes('/channels') || path.includes('/branches'))).toEqual([]);
    // Five real publishes of two platforms, plus the refused lease of step d.
    expect(writes.filter((path) => path.includes('/markUpdateAsUploaded/'))).toHaveLength(10);
    expect(writes.filter((path) => path.includes('/requestUploadUrl/'))).toHaveLength(11);
  });

  it('asks as devices the Observe registry ignores, unless told to send UUIDs', async () => {
    const isCohortProbe = (request: { path: string; headers: Record<string, string> }): boolean =>
      request.path === '/manifest' && request.headers['eas-client-id'] !== undefined;
    const { server, report } = await runAgainst();
    const probes = server.requests.filter(isCohortProbe);
    // Two asks in c, one after each raise in e and one after the finish: five batches of 40 per platform.
    expect(probes).toHaveLength(5 * 40 * 2);
    expect(new Set(probes.map((request) => request.headers['eas-client-id'])).size).toBe(40);
    for (const request of probes) expect(request.headers['eas-client-id']).toContain('-device-');
    expect(report.clientIdKind).toBe('non-uuid');

    const withUuids = await runAgainst({}, true);
    expect(withUuids.report.clientIdKind).toBe('uuid');
    for (const request of withUuids.server.requests.filter(isCohortProbe)) {
      expect(request.headers['eas-client-id']).toMatch(/^[0-9a-f-]{36}$/);
    }
  });

  it('prints no secret, no email and no presigned URL', async () => {
    const { report } = await runAgainst();
    const printed = `${formatTranscript(report)}\n${JSON.stringify(report)}`;
    for (const secret of [
      ADMIN_EMAIL,
      ADMIN_PASSWORD,
      PUBLISH_TOKEN,
      'session-jwt',
      'refresh-jwt',
      'SIGNATURE-SECRET',
      'X-Amz-Signature',
    ]) {
      expect(printed, secret).not.toContain(secret);
    }
    expect(printed).toContain('https://bucket.example/[presigned upload]');
  });

  it('prints a transcript with a summary row and a request list for every step', async () => {
    const { report } = await runAgainst();
    const transcript = formatTranscript(report);
    expect(transcript).toContain('| Step | Outcome | First finding |');
    for (const step of report.steps) expect(transcript).toContain(`| ${step.id}. ${step.title} | ${step.outcome} |`);
    expect(transcript).toContain(`POST /${OTA_APP_ID}/requestUploadUrl/pr-rollout-proof?runtimeVersion=`);
    expect(transcript).toContain('-> 409');
    expect(transcript).toMatch(/GET \/manifest \(x80\) -> 200/);
    expect(transcript).toContain('The branch `pr-rollout-proof` remains');
    expect(transcript).toContain('expires after 14 days');
  });

  it('fails step d when the publish lock does not hold, publishes nothing, and carries on', async () => {
    const { server, report } = await runAgainst({ leaseDuringRollout: true });
    expect(outcomes(report)).toMatchObject({ d: 'FAIL', e: 'PASS', g: 'PASS', 'h-finish': 'PASS' });
    expect(findings(report, 'd')).toContain(
      'FAIL: The server handed out an upload lease for a 100% publish while a rollout is live.',
    );
    expect(report.ok).toBe(false);
    // The lease it was handed is never uploaded to or finalized.
    const leased = server.requests.filter((request) => request.path.includes('/requestUploadUrl/'));
    const finalized = server.requests.filter((request) => request.path.includes('/markUpdateAsUploaded/'));
    expect(leased).toHaveLength(12);
    expect(finalized).toHaveLength(10);
  });

  it('skips the device counts when surfing does not serve the branch, instead of reporting nonsense', async () => {
    const { server, report } = await runAgainst({ surfingOff: true });
    expect(findings(report, 'a')).toContain(
      'was NOT answered with A from that branch (ios: noUpdateAvailable, android: noUpdateAvailable)',
    );
    expect(outcomes(report)).toMatchObject({ a: 'PASS', c: 'OBSERVED', e: 'PASS', g: 'PASS', 'h-finish': 'PASS' });
    expect(findings(report, 'c')).toMatch(
      /^OBSERVED: Skipped: step a showed that manifest probes are not answered from this branch/,
    );
    expect(server.requests.filter((request) => request.headers['eas-client-id'] !== undefined)).toEqual([]);
    expect(report.ok).toBe(true);
  });

  it('refuses outright when the server maps a channel to the branch', async () => {
    const { server, report } = await runAgainst({
      channels: [
        { releaseChannelId: 1, releaseChannelName: 'production', branchId: 1, branchName: 'production' },
        { releaseChannelId: 2, releaseChannelName: 'canary', branchId: 9, branchName: 'pr-rollout-proof' },
      ],
    });
    expect(report.steps[0].outcome).toBe('FAIL');
    expect(findings(report, 'guards')).toContain(
      'The server maps channel "canary" to "pr-rollout-proof". The rollout proof refuses to run.',
    );
    // j needs no earlier step and has nothing to report.
    expect(report.steps.slice(1).map((step) => step.outcome)).toEqual([
      ...Array.from({ length: 10 }, () => 'SKIPPED'),
      'OBSERVED',
    ]);
    expect(server.requests.filter((request) => request.method !== 'GET').map((request) => request.path)).toEqual([
      '/auth/login',
    ]);
    expect(report.ok).toBe(false);
  });

  it('carries on when the update list comes back in a shape the client cannot read', async () => {
    const { report } = await runAgainst({ updateListAnswer: { items: 'not a list' } });
    expect(findings(report, 'a')).toContain(
      'FAIL: The update list could not be read: xprem update list items is not a list.',
    );
    // The step failed an expectation but was not blocked: the rollout steps still run.
    expect(outcomes(report)).toMatchObject({ a: 'FAIL', b: 'PASS', e: 'PASS', g: 'FAIL', 'h-finish': 'FAIL' });
    expect(findings(report, 'g')).toContain('PASS: No rollout is active after revert.');
    expect(findings(report, 'h-finish')).toContain('PASS: Publishing is unlocked: update E at 100% was accepted.');
  });

  it('records how the server words a refused health read, and still asks both endpoints', async () => {
    const refusal = { status: 402, body: { status: 402, detail: 'Update health requires an Enterprise licence' } };
    const { server, report } = await runAgainst({ healthAnswer: refusal });
    expect(outcomes(report)).toMatchObject({ f: 'FAIL', g: 'PASS' });
    expect(findings(report, 'f')).toContain(
      'FAIL: Rollout health could not be read: Read update health failed (HTTP 402)',
    );
    expect(findings(report, 'f')).toContain('FAIL: observe/update-health/history could not be read');
    const healthStep = report.steps.find((step) => step.id === 'f');
    expect(
      healthStep?.exchanges.filter((exchange) => exchange.status === 402).map((exchange) => exchange.body),
    ).toContainEqual({
      status: 402,
      detail: 'Update health requires an Enterprise licence',
    });
    expect(server.requests.some((request) => request.path.includes('/observe/update-health/history'))).toBe(true);
  });

  it('does not read a token that may not republish as a lock that held', async () => {
    const { report } = await runAgainst({ refuseRepublishWith: 403 });
    expect(findings(report, 'd')).toContain(
      'OBSERVED: Republishing A (android) during the rollout answered HTTP 403: the publish token is not allowed to do it',
    );
    expect(findings(report, 'd')).toContain(
      'OBSERVED: A rollback to embedded (android) during the rollout answered HTTP 403',
    );
    expect(findings(report, 'd')).not.toContain('FAIL');
    expect(outcomes(report).d).toBe('PASS');
  });

  it('stops after a refused first publish and still reports every step', async () => {
    const { report } = await runAgainst({ refusePublishWith: 401 });
    expect(outcomes(report)).toMatchObject({
      guards: 'PASS',
      a: 'FAIL',
      b: 'SKIPPED',
      g: 'SKIPPED',
      'h-start': 'SKIPPED',
      'h-finish': 'SKIPPED',
    });
    expect(findings(report, 'a')).toContain('Publishing update A was refused at lease for ios: HTTP 401');
    expect(formatTranscript(report)).toContain(
      '| b. Publish update B with rolloutPercentage=10 | SKIPPED | step a did not complete |',
    );
  });

  it('refuses a wrong branch before any request', async () => {
    const server = fakeRolloutServer();
    await expect(
      runRolloutProof({
        manifestUrl: `${FAKE_BASE_URL}/manifest`,
        adminEmail: ADMIN_EMAIL,
        adminPassword: ADMIN_PASSWORD,
        publishToken: PUBLISH_TOKEN,
        branch: 'production',
        fetchImpl: server.fetchImpl,
      }),
    ).rejects.toThrow('The rollout proof only runs against "pr-rollout-proof", not "production".');
    expect(server.requests).toEqual([]);
  });

  it('refuses to start without the login or the publish token', async () => {
    const start = (overrides: { adminPassword?: string; publishToken?: string }) =>
      runRolloutProof({
        manifestUrl: `${FAKE_BASE_URL}/manifest`,
        adminEmail: ADMIN_EMAIL,
        adminPassword: ADMIN_PASSWORD,
        publishToken: PUBLISH_TOKEN,
        ...overrides,
      });
    await expect(start({ adminPassword: '' })).rejects.toThrow('Set OTA_ADMIN_EMAIL and OTA_ADMIN_PASSWORD.');
    await expect(start({ publishToken: '' })).rejects.toThrow('Set EOO_TOKEN (the publish token).');
  });
});

describe('arguments', () => {
  it('defaults to the scratch branch and a local output directory', () => {
    expect(parseProofArgs([])).toEqual({
      branch: 'pr-rollout-proof',
      outDir: 'ota-rollout-proof-out',
      uuidClientIds: false,
    });
    expect(parseProofArgs(['--', '--out-dir', 'out', '--uuid-client-ids', '--branch', 'production'])).toEqual({
      branch: 'production',
      outDir: 'out',
      uuidClientIds: true,
    });
  });

  it('rejects an unknown flag and a flag without a value', () => {
    expect(() => parseProofArgs(['--runtime-version', 'x'])).toThrow('Unknown argument: --runtime-version.');
    expect(() => parseProofArgs(['--out-dir'])).toThrow('--out-dir needs a value.');
  });
});
