/// <reference types="node" />
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vite-plus/test';
import { parse } from 'yaml';

interface WorkflowStep {
  name?: string;
  uses?: string;
  run?: string;
  env?: Record<string, string>;
  with?: Record<string, unknown>;
  if?: string;
}
interface Workflow {
  on: {
    push: { branches: string[]; paths: string[] };
    workflow_dispatch: { inputs: Record<string, { default?: unknown }> };
  };
  jobs: { creatives: { if: string; environment: string; steps: WorkflowStep[] } };
}
const workflow = parse(readFileSync('.github/workflows/mobile-store-creatives.yml', 'utf8')) as Workflow;
const steps = workflow.jobs.creatives.steps;
function step(name: string): WorkflowStep {
  const result = steps.find((entry) => entry.name === name);
  if (!result?.run) throw new Error(`Missing workflow step: ${name}`);
  return result;
}
const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});
function directory() {
  const root = mkdtempSync(join(tmpdir(), 'creative-workflow-'));
  directories.push(root);
  return root;
}
function manifestFixture(root: string) {
  const variants = Object.fromEntries(
    ['default', 'kilter', 'tension', 'moonboard', 'spray'].map((variant) => [
      variant,
      {
        assets: ['en-US', 'es', 'fr', 'de'].map((locale) => ({
          locale,
          placement: 'search-results',
          poster: 'poster.jpg',
          posterSha256: 'a'.repeat(64),
        })),
      },
    ]),
  );
  mkdirSync(join(root, 'app-stores/apple'), { recursive: true });
  const manifest = { marketingVersion: '2.6.0', variants };
  writeFileSync(join(root, 'app-stores/apple/creative-assets.json'), JSON.stringify(manifest));
  return manifest;
}
function selection(event: string, action = 'plan', variant = 'all', placement = 'all') {
  const root = directory();
  const output = join(root, 'output');
  const result = spawnSync('bash', ['-c', step('Select creative operation').run!], {
    encoding: 'utf8',
    env: {
      ...process.env,
      EVENT_NAME: event,
      INPUT_ACTION: action,
      INPUT_VARIANT: variant,
      INPUT_PLACEMENT: placement,
      GITHUB_OUTPUT: output,
    },
  });
  expect(result.status, result.stderr).toBe(0);
  return readFileSync(output, 'utf8');
}
function lane(action: string, overrides: NodeJS.ProcessEnv = {}) {
  const root = directory();
  const bin = join(root, 'bin');
  mkdirSync(bin);
  writeFileSync(
    join(bin, 'bundle'),
    `#!/bin/bash
set -eu
printf '%s|%s|%s\\n' "$*" "$CREATIVE_PLACEMENT" "$(test -f "$ASC_KEY_PATH" && echo key-present)" >> "$TRACE"
if [ "$5" = 'action:place' ] && [ "\${FAIL_PLACE:-}" = true ]; then echo 'Existing placement requires allow_replace:true'; exit 19; fi
if [ "$5" = 'action:place' ] && [ "\${PROCESSING_ONCE:-}" = true ] && [ ! -f "$RUNNER_TEMP/retried" ]; then touch "$RUNNER_TEMP/retried"; echo 'Apple processing/review preparation must reach PREPARE_FOR_SUBMISSION'; exit 17; fi
printf '[]' > "$ASC_CREATIVES_OUTPUT"
`,
    { mode: 0o755 },
  );
  writeFileSync(join(bin, 'sleep'), '#!/bin/bash\nexit 0\n', { mode: 0o755 });
  const result = spawnSync('bash', ['-c', step('Run creative lane with ephemeral API key').run!], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      TRACE: join(root, 'trace'),
      RUNNER_TEMP: root,
      CREATIVE_ACTION: action,
      CREATIVE_VARIANT: 'all',
      CREATIVE_PLACEMENT: 'search',
      ALLOW_LIVE: 'false',
      ALLOW_REPLACE: 'false',
      APP_STORE_CONNECT_API_KEY_ID: 'test-id',
      APP_STORE_CONNECT_ISSUER_ID: 'test-issuer',
      ASC_PRIVATE_KEY_BASE64: Buffer.from('test-key').toString('base64'),
      ...overrides,
    },
  });
  const trace = readFileSync(join(root, 'trace'), 'utf8').trim().split('\n');
  return { ...result, trace, root };
}
describe('merged store video upload workflow', () => {
  it('runs only for the main manifest and checks out the immutable triggering commit', () => {
    expect(workflow.on.push).toEqual({ branches: ['main'], paths: ['app-stores/apple/creative-assets.json'] });
    expect(workflow.jobs.creatives.if).toBe("github.ref == 'refs/heads/main'");
    expect(workflow.jobs.creatives.environment).toBe('Production');
    expect(steps.find((entry) => entry.uses?.startsWith('actions/checkout@'))?.with).toMatchObject({
      ref: '${{ github.sha }}',
      'persist-credentials': false,
    });
    expect(workflow.on.workflow_dispatch.inputs.allow_live.default).toBe(false);
    expect(workflow.on.workflow_dispatch.inputs.allow_replace.default).toBe(false);
  });
  it('selects search-only upload/place on push and preserves manual action/variant', () => {
    expect(selection('push')).toBe('action=upload-and-place\nvariant=all\nplacement=search\n');
    expect(selection('workflow_dispatch', 'place', 'kilter')).toBe('action=place\nvariant=kilter\nplacement=all\n');
    expect(selection('workflow_dispatch', 'place', 'all', 'search')).toBe(
      'action=place\nvariant=all\nplacement=search\n',
    );
  });
  it('promotes then verifies downloads before exposing ASC credentials', () => {
    const promote = step('Promote reviewed search videos');
    const fetch = step('Fetch verified approved search videos');
    const upload = step('Run creative lane with ephemeral API key');
    expect(steps.indexOf(promote)).toBeLessThan(steps.indexOf(fetch));
    expect(steps.indexOf(fetch)).toBeLessThan(steps.indexOf(upload));
    expect(promote.run).toContain('promote --placement search');
    expect(fetch.run).toContain('fetch --placement search');
    expect(Object.keys(promote.env!)).toEqual(Object.keys(fetch.env!));
    expect(Object.keys(promote.env!).every((name) => name.startsWith('STORE_CREATIVES_R2_'))).toBe(true);
    expect(Object.keys(upload.env!).some((name) => name.startsWith('STORE_CREATIVES_R2_'))).toBe(false);
    expect(upload.env?.ALLOW_LIVE).toBe('${{ inputs.allow_live || false }}');
    expect(upload.env?.ALLOW_REPLACE).toBe('${{ inputs.allow_replace || false }}');
  });
  it('uploads then places with unchanged guards and distinct reports, removing the key', () => {
    const result = lane('upload-and-place');
    expect(result.status, result.stderr).toBe(0);
    expect(result.trace).toHaveLength(2);
    expect(result.trace[0]).toContain('action:upload');
    expect(result.trace[1]).toContain('action:place');
    expect(
      result.trace.every((entry) => entry.includes('allow_live:false allow_replace:false|search|key-present')),
    ).toBe(true);
    expect(readdirSync(result.root).filter((file) => file.endsWith('.p8'))).toEqual([]);
    expect(readdirSync(result.root)).toContain('creative-assets-upload-report.json');
    expect(readdirSync(result.root)).toContain('creative-assets-place-report.json');
  });
  it('retries Apple processing only and fails guard errors without retrying', () => {
    const processing = lane('upload-and-place', { PROCESSING_ONCE: 'true' });
    expect(processing.status, processing.stderr).toBe(0);
    expect(processing.trace).toHaveLength(3);
    const guarded = lane('upload-and-place', { FAIL_PLACE: 'true' });
    expect(guarded.status).toBe(19);
    expect(guarded.trace).toHaveLength(2);
  });
  it('requires a complete locale matrix with posters before any promotion', () => {
    const root = directory();
    const manifest = manifestFixture(root);
    const run = () =>
      spawnSync('bash', ['-c', step('Validate complete search video matrix').run!], { cwd: root, encoding: 'utf8' });
    expect(run().status).toBe(0);
    manifest.variants.kilter.assets[3].locale = 'en-US';
    writeFileSync(join(root, 'app-stores/apple/creative-assets.json'), JSON.stringify(manifest));
    expect(run().status).toBe(1);
    manifest.variants.kilter.assets[3].locale = 'de';
    manifest.variants.kilter.assets[3].poster = '';
    writeFileSync(join(root, 'app-stores/apple/creative-assets.json'), JSON.stringify(manifest));
    expect(run().status).toBe(1);
  });
  it('counts unique videos in summaries rather than objects or Spanish storefront copies', () => {
    const root = directory();
    manifestFixture(root);
    const report = Array.from({ length: 20 }, (_, index) => ({
      placement: 'search-results',
      fileName: `video-${index}.mp4`,
    }));
    report.push(report[1]);
    for (const action of ['upload', 'place'])
      writeFileSync(join(root, `creative-assets-${action}-report.json`), JSON.stringify(report));
    for (const action of ['promotion', 'fetch'])
      writeFileSync(join(root, `creative-${action}-report.json`), JSON.stringify({ objects: 60, changed: 60 }));
    const summary = join(root, 'summary');
    const result = spawnSync('bash', ['-c', step('Summarize creative results').run!], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, CREATIVE_ACTION: 'upload-and-place', RUNNER_TEMP: root, GITHUB_STEP_SUMMARY: summary },
    });
    expect(result.status, result.stderr).toBe(0);
    const content = readFileSync(summary, 'utf8');
    expect(content.match(/\| 20 \|/g)).toHaveLength(4);
    expect(content).not.toContain('| 60 |');
    expect(content).toContain('Asset-review submission stays manual');
  });
  it('preserves manual live/replacement approval and runs only the requested action', () => {
    const result = lane('place', { ALLOW_LIVE: 'true', ALLOW_REPLACE: 'true', CREATIVE_PLACEMENT: 'search' });
    expect(result.status, result.stderr).toBe(0);
    expect(result.trace).toHaveLength(1);
    expect(result.trace[0]).toContain('action:place variant:all allow_live:true allow_replace:true|search|key-present');
  });
});
