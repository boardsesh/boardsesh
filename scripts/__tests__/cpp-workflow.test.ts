/// <reference types="node" />

import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { afterEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';

interface WorkflowStep {
  name?: string;
  uses?: string;
  run?: string;
  env?: Record<string, string>;
  if?: string;
}
interface WorkflowJob {
  steps: WorkflowStep[];
  needs?: string | string[];
  environment?: string;
  if?: string;
  strategy?: { 'max-parallel'?: number | string };
}
const workflow = parse(readFileSync('.github/workflows/mobile-screenshots-ios.yml', 'utf8')) as {
  jobs: Record<string, WorkflowJob>;
  concurrency: { group: string };
};
const directories: string[] = [];
afterEach(() => directories.splice(0).forEach((directory) => rmSync(directory, { recursive: true, force: true })));

function compute(overrides: NodeJS.ProcessEnv = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'cpp-workflow-'));
  directories.push(directory);
  const output = join(directory, 'outputs');
  const script = workflow.jobs.setup.steps.find(
    ({ name }) => name === 'Validate CPP selection and compute matrix',
  )?.run;
  if (!script) throw new Error('CPP matrix step is missing');
  const result = spawnSync('bash', ['-c', script], {
    encoding: 'utf8',
    env: {
      ...process.env,
      CPP_TARGET: 'all',
      CPP_ACTION: 'capture',
      FIXTURES_MODE: 'replay',
      LOCALES: '',
      UPLOAD_DEFAULT: 'false',
      PUBLISH_BASELINE: 'false',
      FIXTURE_SNAPSHOT: '',
      CPP_SCENARIO: '',
      CPP_RECORD_RUN_ID: '',
      FLOW: 'app-store',
      GATE: 'full',
      RENDER_MODE: '',
      BOARDS: '',
      FROZEN_NOW: '',
      EVENT_NAME: 'workflow_dispatch',
      GITHUB_REF: 'refs/heads/main',
      GITHUB_OUTPUT: output,
      ...overrides,
    },
  });
  return { ...result, output };
}

describe('CPP workflow isolation and matrix', () => {
  it.each([
    { recordRun: '123', setup: 'success', capture: 'skipped', expected: true },
    { recordRun: '', setup: 'success', capture: 'success', expected: true },
    { recordRun: '', setup: 'success', capture: 'failure', expected: false },
    { recordRun: '123', setup: 'failure', capture: 'skipped', expected: false },
  ])('evaluates the real candidate dependency condition %j', ({ recordRun, setup, capture, expected }) => {
    const condition = workflow.jobs['cpp-prepare-record']
      .if!.replace(/^\$\{\{\s*|\s*\}\}$/g, '')
      .replaceAll('needs.cpp-capture.', 'needs.capture.');
    expect(
      runInNewContext(condition, {
        cancelled: () => false,
        needs: { setup: { result: setup }, capture: { result: capture } },
        inputs: { cpp_record_run_id: recordRun, fixtures: 'record', cpp_target: 'moonboard' },
      }),
    ).toBe(expected);
  });
  it('reuses only one unchanged English record target and verifies sources before credentials', () => {
    const result = compute({
      CPP_TARGET: 'moonboard',
      CPP_RECORD_RUN_ID: '38447346114',
      CPP_ACTION: 'capture',
      FIXTURES_MODE: 'record',
      LOCALES: 'en-US',
    });
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(JSON.parse(readFileSync(result.output, 'utf8').trim().slice('matrix='.length)).include).toHaveLength(4);
    for (const name of ['ios-build', 'cpp-bootstrap', 'cpp-capture'])
      expect(workflow.jobs[name].if).toContain("(inputs.cpp_record_run_id || '') == ''");
    const steps = workflow.jobs['cpp-prepare-record'].steps;
    const credentialIndex = steps.findIndex((step) => step.env?.SCREENSHOT_USER_PASSWORD !== undefined);
    for (const name of [
      'Verify and download retained native records before credentials',
      'Merge immutable CPP recording shards',
      'Validate retained newest merged source before credentials',
    ])
      expect(steps.findIndex((step) => step.name === name)).toBeLessThan(credentialIndex);
    expect(workflow.jobs['cpp-prepare-record'].if).toContain("needs.setup.result == 'success'");
    expect(workflow.jobs['cpp-prepare-record'].if).toContain("(inputs.cpp_record_run_id || '') != ''");
    expect(workflow.jobs['cpp-finalize'].if).toContain("needs.cpp-capture.result == 'success'");
    expect(steps.find((step) => step.name === 'Download real recorded CPP shards')?.if).toContain(
      "(inputs.cpp_record_run_id || '') == ''",
    );
    expect(steps.find((step) => step.name === 'Prepare immutable CPP candidate')?.run).toContain(
      '$CPP_TARGET.provenance.json',
    );
  });
  it.each([
    { CPP_RECORD_RUN_ID: '12; bad' },
    { CPP_TARGET: 'all' },
    { CPP_TARGET: 'none' },
    { FIXTURES_MODE: 'replay' },
    { CPP_ACTION: 'stage-assets' },
    { EVENT_NAME: 'workflow_run' },
    { LOCALES: '' },
    { LOCALES: 'es' },
    { FLOW: 'onboarding' },
    { GATE: 'probe' },
    { RENDER_MODE: 'aura' },
    { BOARDS: 'MoonBoard' },
    { FROZEN_NOW: '2026-10-01' },
    { CPP_SCENARIO: '{}' },
    { FIXTURE_SNAPSHOT: 'https://example.test' },
    { UPLOAD_DEFAULT: 'true' },
    { PUBLISH_BASELINE: 'true' },
  ])('rejects contradictory retained-record input %j', (overrides) => {
    const result = compute({
      CPP_TARGET: 'moonboard',
      CPP_RECORD_RUN_ID: '38447346114',
      CPP_ACTION: 'capture',
      FIXTURES_MODE: 'record',
      LOCALES: 'en-US',
      ...overrides,
    });
    expect(result.status).not.toBe(0);
  });
  it('serializes only CPP record shards sharing an owned session and preserves eight parallel replay shards', () => {
    expect(workflow.jobs['cpp-capture'].strategy?.['max-parallel']).toBe(
      "${{ inputs.fixtures == 'record' && 1 || 8 }}",
    );
  });
  it.each([4, 3, 0, 5])('discovers exactly four genuine shard manifests without rg (downloaded: %i)', (count) => {
    const directory = mkdtempSync(join(tmpdir(), 'cpp-manifest-discovery-'));
    directories.push(directory);
    const binaries = join(directory, 'bin');
    const recordings = join(directory, 'cpp-recordings');
    mkdirSync(binaries);
    mkdirSync(recordings);
    for (const name of ['find', 'sort', 'jq', 'mkdir']) {
      const binary = spawnSync('/bin/bash', ['-c', `command -v ${name}`], { encoding: 'utf8' });
      if (binary.status !== 0) throw new Error(`Required discovery test dependency missing: ${name}`);
      symlinkSync(binary.stdout.trim(), join(binaries, name));
    }
    const callsFile = join(directory, 'producer-calls');
    // Only downstream producers are mocked. Discovery, ordering, jq's matrix
    // count and the guard execute the exact checked-in workflow shell script.
    writeFileSync(join(binaries, 'vp'), '#!/bin/bash\nprintf "%s\\0" __CPP_CALL__ "$@" >> "$CPP_TEST_CALLS"\n', {
      mode: 0o755,
    });
    const shardNames = ['z-phone', 'a tablet', 'b tablet\n', '.hidden-shard', 'extra-shard'];
    const expectedDirectories = shardNames.slice(0, count).map((name) => join(recordings, name));
    for (const shard of expectedDirectories) {
      mkdirSync(shard);
      writeFileSync(join(shard, 'manifest.json'), '{}');
      writeFileSync(join(shard, 'other-file.json'), '{}');
      mkdirSync(join(shard, 'nested'));
      // A directory with this name must never count as a recorded manifest.
      mkdirSync(join(shard, 'nested', 'manifest.json'));
    }
    const script = workflow.jobs['cpp-prepare-record'].steps.find(
      ({ name }) => name === 'Merge immutable CPP recording shards',
    )?.run;
    if (!script) throw new Error('CPP preparation step missing');
    const env = {
      ...process.env,
      PATH: binaries,
      RUNNER_TEMP: directory,
      CPP_TARGET: 'kilter',
      CPP_MATRIX: JSON.stringify({ include: Array.from({ length: 4 }, (_, index) => ({ device: index })) }),
      GITHUB_STEP_SUMMARY: join(directory, 'summary'),
      CPP_TEST_CALLS: callsFile,
    };
    expect(spawnSync('/bin/bash', ['-c', 'command -v rg'], { env }).status).toBe(1);
    const result = spawnSync('/bin/bash', ['-c', script], { encoding: 'utf8', env });
    if (count !== 4) {
      expect(result.status).not.toBe(0);
      expect(result.stdout).toContain('Recorded CPP artifacts do not cover every requested shard.');
      expect(() => readFileSync(callsFile)).toThrow();
      return;
    }
    expect(result.status, result.stdout + result.stderr).toBe(0);
    const calls = readFileSync(callsFile, 'utf8')
      .split('__CPP_CALL__\0')
      .slice(1)
      .map((call) => call.split('\0').slice(0, -1));
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual([
      'run',
      'mobile:screenshot-fixtures-merge',
      '--',
      '--out',
      join(directory, 'cpp-merged'),
      '--on-conflict',
      'newest',
      ...expectedDirectories.sort(),
    ]);
    expect(result.stderr).not.toContain('command not found');
  });
  it('expands four targets, four app locales, and four devices into 64 unique capture shards', () => {
    const result = compute();
    expect(result.status, result.stdout + result.stderr).toBe(0);
    const matrix = JSON.parse(readFileSync(result.output, 'utf8').trim().slice('matrix='.length)) as {
      include: Array<{ target: string; locale: string; device: { slug: string } }>;
    };
    expect(matrix.include).toHaveLength(64);
    expect(new Set(matrix.include.map(({ target, locale, device }) => `${target}/${locale}/${device.slug}`)).size).toBe(
      64,
    );
    expect(matrix.include.filter(({ target }) => target === 'spray')).toHaveLength(16);
  });

  it('narrows capture-only English runs without losing either phone or iPad size', () => {
    const result = compute({ CPP_TARGET: 'moonboard', LOCALES: 'en-US' });
    expect(result.status, result.stdout + result.stderr).toBe(0);
    const matrix = JSON.parse(readFileSync(result.output, 'utf8').trim().slice('matrix='.length));
    expect(matrix.include).toHaveLength(4);
    expect(
      matrix.include.every(
        (entry: { target: string; locale: string }) => entry.target === 'moonboard' && entry.locale === 'en-US',
      ),
    ).toBe(true);
  });

  it('stages all four targets through the full native replay matrix', () => {
    const result = compute({ CPP_ACTION: 'stage-assets' });
    expect(result.status, result.stdout + result.stderr).toBe(0);
    const matrix = JSON.parse(readFileSync(result.output, 'utf8').trim().slice('matrix='.length)) as {
      include: Array<{ target: string; locale: string; device: { slug: string } }>;
    };
    expect(matrix.include).toHaveLength(64);
    expect(new Set(matrix.include.map(({ target, locale, device }) => `${target}/${locale}/${device.slug}`)).size).toBe(
      64,
    );
  });

  it.each([
    { CPP_TARGET: 'none' },
    { GITHUB_REF: 'refs/heads/feature' },
    { EVENT_NAME: 'workflow_run' },
    { FIXTURES_MODE: 'record' },
    { FIXTURES_MODE: 'live' },
    { LOCALES: 'en-US' },
    { UPLOAD_DEFAULT: 'true' },
    { PUBLISH_BASELINE: 'true' },
  ])('rejects staging without a trusted main full replay selection: %j', (overrides) => {
    const result = compute({ CPP_ACTION: 'stage-assets', ...overrides });
    expect(result.status).not.toBe(0);
  });

  it('checks staging source SHA and main before requesting Apple credentials', () => {
    const steps = workflow.jobs['cpp-finalize'].steps;
    const guardIndex = steps.findIndex(({ name }) => name === 'Verify trusted source for CPP asset staging');
    expect(guardIndex).toBeGreaterThanOrEqual(0);
    expect(guardIndex).toBeLessThan(steps.findIndex(({ uses }) => uses === './.github/actions/asc-cpp'));
    const script = steps[guardIndex].run!;
    const sourceSha = spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim();
    const runGuard = (overrides: NodeJS.ProcessEnv = {}) =>
      spawnSync('bash', ['-c', script], {
        encoding: 'utf8',
        env: {
          ...process.env,
          SOURCE_SHA: sourceSha,
          GITHUB_EVENT_NAME: 'workflow_dispatch',
          GITHUB_REF: 'refs/heads/main',
          ...overrides,
        },
      });
    const successful = runGuard();
    expect(successful.status, successful.stdout + successful.stderr).toBe(0);
    expect(runGuard({ SOURCE_SHA: 'different-commit' }).status).not.toBe(0);
    expect(runGuard({ GITHUB_REF: 'refs/heads/feature' }).status).not.toBe(0);
    expect(runGuard({ GITHUB_EVENT_NAME: 'workflow_run' }).status).not.toBe(0);
  });

  it.each([
    { CPP_ACTION: 'submit', LOCALES: 'en-US' },
    { CPP_ACTION: 'upload', FIXTURES_MODE: 'live' },
    { CPP_TARGET: 'all', FIXTURES_MODE: 'record' },
    { FIXTURE_SNAPSHOT: 'https://example.com/candidate.json' },
    { CPP_TARGET: 'kilter', UPLOAD_DEFAULT: 'true' },
    { CPP_TARGET: 'kilter', PUBLISH_BASELINE: 'true' },
    { CPP_TARGET: '../default', CPP_ACTION: 'submit' },
    { LOCALES: 'en-US,en-US' },
  ])('refuses a partial, mixed, or unsafe publication: %j', (overrides) => {
    const result = compute(overrides);
    expect(result.status).not.toBe(0);
  });

  it('prepares a real scenario once before record shards and preserves manual scenario overrides', () => {
    const result = compute({ CPP_TARGET: 'spray', FIXTURES_MODE: 'record', LOCALES: 'en-US' });
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(workflow.jobs['cpp-capture'].needs).toEqual(['setup', 'ios-build', 'cpp-bootstrap']);
    const bootstrapSteps = workflow.jobs['cpp-bootstrap'].steps;
    const seed = bootstrapSteps.find(({ name }) => name === 'Prepare genuine private demo boards and session');
    expect(seed?.run).toContain('--apply --seed-demo-content');
    expect(seed?.run).toContain('--accepted-source-hashes');
    expect(seed?.env?.SCREENSHOT_USER_PASSWORD).toContain('secrets.SCREENSHOT_USER_PASSWORD');
    expect(bootstrapSteps.filter(({ uses }) => uses === './.github/actions/asc-cpp')).toHaveLength(0);
    expect(workflow.concurrency.group).toContain("inputs.fixtures == 'record'");
  });

  it('packages only successful genuine record shards into an offline candidate', () => {
    const candidate = workflow.jobs['cpp-prepare-record'];
    expect(candidate.needs).toEqual(['setup', 'cpp-capture']);
    expect(candidate.if).toContain("needs.cpp-capture.result == 'success'");
    expect(candidate.if).toContain("inputs.fixtures == 'record'");
    const pack = candidate.steps.find(({ name }) => name === 'Merge immutable CPP recording shards');
    expect(pack?.run).toContain('"${#manifests[@]}" -ne "$expected"');
    const prepare = candidate.steps.find(({ name }) => name === 'Prepare immutable CPP candidate');
    expect(prepare?.run).toContain('--cpp --refresh-photo-urls');
    expect(prepare?.run).toContain('screenshot-fixtures-publish.ts --archive');
    expect(candidate.steps.some(({ uses }) => uses === './.github/actions/asc-cpp')).toBe(false);
    expect(candidate.environment).toBeUndefined();
  });

  it('keeps default listing baseline publication in its original finalize job', () => {
    const names = workflow.jobs['ios-finalize'].steps.map(({ name }) => name);
    expect(names).toContain('Publish screenshot baseline');
    expect(names).toContain('Upload screenshots artifact');
    expect(workflow.jobs['cpp-finalize'].steps.map(({ name }) => name)).not.toContain('Publish screenshot baseline');
    expect(workflow.jobs['cpp-finalize'].needs).toEqual(['setup', 'cpp-capture']);
  });

  it('validates export pixels before the protected App Store action and serializes CPP writers', () => {
    const steps = workflow.jobs['cpp-finalize'].steps;
    expect(
      steps.findIndex(({ name }) => name === 'Validate every CPP export before requesting Apple credentials'),
    ).toBeLessThan(steps.findIndex(({ uses }) => uses === './.github/actions/asc-cpp'));
    expect(workflow.jobs['cpp-finalize'].environment).toBe('Production');
    expect(workflow.jobs['cpp-plan'].environment).toBe('Production');
    expect(workflow.concurrency.group).toContain("inputs.cpp_action == 'upload'");
    expect(workflow.concurrency.group).toContain("inputs.cpp_action == 'submit'");
    expect(workflow.concurrency.group).toContain("inputs.cpp_action == 'stage-assets'");
    expect(workflow.jobs['cpp-finalize'].if).toContain("inputs.cpp_action == 'stage-assets'");
  });
});
