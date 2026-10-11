/// <reference types="node" />

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';

interface WorkflowStep {
  name?: string;
  uses?: string;
  run?: string;
  env?: Record<string, string>;
}
interface WorkflowJob {
  steps: WorkflowStep[];
  needs?: string | string[];
  environment?: string;
  if?: string;
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
      GITHUB_OUTPUT: output,
      ...overrides,
    },
  });
  return { ...result, output };
}

describe('CPP workflow isolation and matrix', () => {
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
    const pack = candidate.steps.find(({ name }) => name === 'Merge and prepare immutable CPP candidate');
    expect(pack?.run).toContain('"${#manifests[@]}" -ne "$expected"');
    expect(pack?.run).toContain('--cpp --refresh-photo-urls');
    expect(pack?.run).toContain('screenshot-fixtures-publish.ts --archive');
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
  });
});
