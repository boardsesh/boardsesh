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
          file: `.boardsesh/app-store-creatives/${variant}/${locale}/search-results.mp4`,
          sha256: 'a'.repeat(64),
          provenance: `.boardsesh/app-store-creatives/${variant}/${locale}/search-results.manifest.json`,
          provenanceSha256: 'b'.repeat(64),
          poster: `.boardsesh/app-store-creatives/${variant}/${locale}/search-results.jpg`,
          posterSha256: 'c'.repeat(64),
        })),
      },
    ]),
  );
  mkdirSync(join(root, 'app-stores/apple'), { recursive: true });
  const manifest = { marketingVersion: '2.6.0', variants };
  writeFileSync(join(root, 'app-stores/apple/creative-assets.json'), JSON.stringify(manifest));
  return manifest;
}
function summarize(root: string, shipped = 'default,kilter,tension,moonboard,spray', searchOutcome = 'success') {
  const output = join(root, 'summary');
  const result = spawnSync('bash', ['-c', step('Summarize creative results').run!], {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      CREATIVE_ACTION: 'upload-and-place',
      SEARCH_OUTCOME: searchOutcome,
      SHIPPED_VARIANTS: shipped,
      RUNNER_TEMP: root,
      GITHUB_STEP_SUMMARY: output,
    },
  });
  expect(result.status, result.stderr).toBe(0);
  return readFileSync(output, 'utf8');
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
    expect(
      Object.keys(promote.env!).every((name) => name.startsWith('STORE_CREATIVES_R2_') || name === 'SEARCH_VARIANTS'),
    ).toBe(true);
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
  describe('ships only variants whose search entries changed in the push', () => {
    const repository = process.cwd();
    function searchSet(manifest: Record<string, unknown>, variant: string, sha: string) {
      const variants = manifest.variants as Record<string, { assets: unknown[] }>;
      variants[variant].assets = ['en-US', 'es', 'fr', 'de'].map((locale) => ({
        locale,
        placement: 'search-results',
        file: `.boardsesh/app-store-creatives/${variant}/${locale}/search-results.mp4`,
        sha256: sha.repeat(64),
        provenance: `.boardsesh/app-store-creatives/${variant}/${locale}/search-results.manifest.json`,
        provenanceSha256: 'b'.repeat(64),
        poster: `.boardsesh/app-store-creatives/${variant}/${locale}/search-results-poster.jpg`,
        posterSha256: 'c'.repeat(64),
        specId: 'search',
        placementGroup: 'search',
      }));
    }
    function push(
      before: (manifest: Record<string, unknown>) => void,
      after: (manifest: Record<string, unknown>) => void,
    ) {
      const root = directory();
      const upstream = join(root, 'upstream');
      const git = (cwd: string, ...args: string[]) => {
        const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
        expect(result.status, result.stderr).toBe(0);
        return result.stdout.trim();
      };
      mkdirSync(join(upstream, 'app-stores/apple'), { recursive: true });
      git(upstream, 'init', '-q');
      const base = JSON.parse(readFileSync('app-stores/apple/creative-assets.json', 'utf8')) as Record<string, unknown>;
      const write = (change: (manifest: Record<string, unknown>) => void, message: string) => {
        const manifest = structuredClone(base);
        change(manifest);
        writeFileSync(join(upstream, 'app-stores/apple/creative-assets.json'), JSON.stringify(manifest));
        git(upstream, 'add', '.');
        git(
          upstream,
          '-c',
          'user.name=t',
          '-c',
          'user.email=t@example.com',
          'commit',
          '-q',
          '--allow-empty',
          '-m',
          message,
        );
        return git(upstream, 'rev-parse', 'HEAD');
      };
      const beforeSha = write(before, 'before');
      write(after, 'after');
      const work = join(root, 'work');
      git(root, 'clone', '-q', '--depth=1', `file://${upstream}`, work);
      const bin = join(root, 'bin');
      mkdirSync(bin);
      writeFileSync(
        join(bin, 'vp'),
        // Stand in for `vp exec tsx SCRIPT ACTION ...`: run this checkout's script against the pushed manifest.
        `#!/bin/bash\n[ "$1 $2" = 'exec tsx' ] || exit 64\ncd ${JSON.stringify(repository)} && exec ${JSON.stringify(process.execPath)} --import tsx "$3" "$4" --manifest ${JSON.stringify(join(work, 'app-stores/apple/creative-assets.json'))} "\${@:5}"\n`,
        { mode: 0o755 },
      );
      const result = spawnSync('bash', ['-c', step('Validate each shipped search video matrix').run!], {
        cwd: work,
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH}`,
          BEFORE_SHA: beforeSha,
          RUNNER_TEMP: root,
          GITHUB_OUTPUT: join(root, 'output'),
          GITHUB_STEP_SUMMARY: join(root, 'summary'),
        },
      });
      return {
        status: result.status,
        stderr: result.stderr,
        output: result.status === 0 ? readFileSync(join(root, 'output'), 'utf8') : '',
        summary: result.status === 0 ? readFileSync(join(root, 'summary'), 'utf8') : '',
      };
    }
    it('ships a new kilter subset but never re-ships an earlier train default entry', () => {
      const result = push(
        (manifest) => {
          manifest.marketingVersion = '2.7.0';
          searchSet(manifest, 'default', 'a');
        },
        (manifest) => {
          manifest.marketingVersion = '2.8.0';
          searchSet(manifest, 'default', 'a');
          searchSet(manifest, 'kilter', 'd');
        },
      );
      expect(result.status, result.stderr).toBe(0);
      expect(result.output).toBe('variants=kilter\n');
      expect(result.summary).toContain('Shipping search videos for: kilter');
    }, 30_000);
    it('ships nothing, with a clear message, when no search entry changed', () => {
      const same = (manifest: Record<string, unknown>) => {
        manifest.marketingVersion = '2.7.0';
        searchSet(manifest, 'default', 'a');
      };
      const result = push(same, same);
      expect(result.status, result.stderr).toBe(0);
      expect(result.output).toBe('variants=\n');
      expect(result.summary).toContain('No search video entries changed in this push');
    }, 30_000);
    it('fails before promotion when a changed variant is incomplete', () => {
      const result = push(
        () => undefined,
        (manifest) => {
          manifest.marketingVersion = '2.7.0';
          searchSet(manifest, 'spray', 'a');
          (manifest.variants as Record<string, { assets: unknown[] }>).spray.assets.pop();
        },
      );
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('spray needs four search videos with posters');
    }, 30_000);
    it('feeds the shipped list to every later step and skips them when it is empty', () => {
      for (const name of ['Promote reviewed search videos', 'Fetch verified approved search videos']) {
        expect(step(name).if).toBe("github.event_name == 'push' && steps.search.outputs.variants != ''");
        expect(step(name).env?.SEARCH_VARIANTS).toBe('${{ steps.search.outputs.variants }}');
        expect(step(name).run).toContain('--placement search --variant "$SEARCH_VARIANTS"');
        expect(steps.indexOf(step('Validate each shipped search video matrix'))).toBeLessThan(
          steps.indexOf(step(name)),
        );
      }
      const lane = step('Run creative lane with ephemeral API key');
      expect(lane.if).toBe("github.event_name != 'push' || steps.search.outputs.variants != ''");
      expect(lane.env?.CREATIVE_VARIANT).toBe(
        "${{ github.event_name == 'push' && steps.search.outputs.variants || steps.operation.outputs.variant }}",
      );
    });
  });
  it('summarizes only the shipped variants, or says nothing shipped', () => {
    const root = directory();
    manifestFixture(root);
    for (const action of ['promotion', 'fetch'])
      writeFileSync(join(root, `creative-${action}-report.json`), JSON.stringify({ objects: 12, changed: 12 }));
    expect(summarize(root, 'kilter')).toContain('| Promoted or already approved | 4 |');
    expect(summarize(root, '')).toContain('No search video entries changed in this push');
    expect(summarize(root, '', 'failure')).toContain('Search video validation did not pass');
  });
  it('passes a shipped subset to the lane with unchanged guards', () => {
    const result = lane('upload-and-place', { CREATIVE_VARIANT: 'default,spray' });
    expect(result.status, result.stderr).toBe(0);
    expect(
      result.trace.every((entry) =>
        entry.includes('variant:default,spray allow_live:false allow_replace:false|search|key-present'),
      ),
    ).toBe(true);
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
    const content = summarize(root);
    expect(content.match(/\| 20 \|/g)).toHaveLength(4);
    expect(content).not.toContain('| 60 |');
    expect(content).toContain('Asset-review submission stays manual');
  });
  it.each([
    undefined,
    '{',
    'null',
    '{}',
    '{"variants":null}',
    '{"variants":[]}',
    '{"variants":{"kilter":null}}',
    '{"variants":{"kilter":{"assets":{}}}}',
  ])('summarizes an unavailable or malformed manifest without masking the upstream failure (%s)', (contents) => {
    const root = directory();
    if (contents !== undefined) {
      mkdirSync(join(root, 'app-stores/apple'), { recursive: true });
      writeFileSync(join(root, 'app-stores/apple/creative-assets.json'), contents);
    }
    for (const action of ['promotion', 'fetch'])
      writeFileSync(join(root, `creative-${action}-report.json`), JSON.stringify({ objects: 60, changed: 60 }));
    const content = summarize(root);
    expect(content).toContain('| Promoted or already approved | 0 |');
    expect(content).toContain('| Downloaded and SHA256 verified | 0 |');
    expect(content).toContain('Asset-review submission stays manual');
  });
  it.each([
    null,
    true,
    {},
    { objects: 0, changed: 0 },
    { objects: 59, changed: 59 },
    { objects: 61, changed: 61 },
    { objects: 60 },
    { objects: 60, changed: -1 },
    { objects: 60, changed: 61 },
    { objects: 60, changed: 0.5 },
  ])('does not claim storage completion for an invalid or incomplete report (%j)', (report) => {
    const root = directory();
    manifestFixture(root);
    for (const action of ['promotion', 'fetch'])
      writeFileSync(join(root, `creative-${action}-report.json`), JSON.stringify(report));
    const content = summarize(root);
    expect(content).toContain('| Promoted or already approved | 0 |');
    expect(content).toContain('| Downloaded and SHA256 verified | 0 |');
  });
  it('accepts already approved objects but requires every download to be verified', () => {
    const root = directory();
    manifestFixture(root);
    writeFileSync(join(root, 'creative-promotion-report.json'), JSON.stringify({ objects: 60, changed: 0 }));
    writeFileSync(join(root, 'creative-fetch-report.json'), JSON.stringify({ objects: 60, changed: 59 }));
    const content = summarize(root);
    expect(content).toContain('| Promoted or already approved | 20 |');
    expect(content).toContain('| Downloaded and SHA256 verified | 0 |');
  });
  it.each([null, true, {}, '{'])('handles non-array or malformed ASC reports (%j)', (report) => {
    const root = directory();
    manifestFixture(root);
    for (const action of ['upload', 'place'])
      writeFileSync(
        join(root, `creative-assets-${action}-report.json`),
        report === '{' ? report : JSON.stringify(report),
      );
    const content = summarize(root);
    expect(content).toContain('| Uploaded or already in Asset Library | 0 |');
    expect(content).toContain('| Placed or already assigned | 0 |');
  });
  it('ignores malformed ASC entries and header assets when counting videos', () => {
    const root = directory();
    manifestFixture(root);
    const entries = [
      null,
      true,
      {},
      { placement: 'search-results' },
      { placement: 'search-results', fileName: '' },
      { placement: 'search-results', fileName: 3 },
      { placement: 'search-results', fileName: ' ' },
      { placement: 'header', fileName: 'header.png' },
      { placement: 'search-results', fileName: 'video.mp4' },
    ];
    for (const action of ['upload', 'place'])
      writeFileSync(join(root, `creative-assets-${action}-report.json`), JSON.stringify(entries));
    const content = summarize(root);
    expect(content).toContain('| Uploaded or already in Asset Library | 1 |');
    expect(content).toContain('| Placed or already assigned | 1 |');
  });
  it('rejects missing inventory fields and conflicting destination hashes', () => {
    const root = directory();
    const manifest = manifestFixture(root);
    for (const action of ['promotion', 'fetch'])
      writeFileSync(join(root, `creative-${action}-report.json`), JSON.stringify({ objects: 60, changed: 60 }));
    manifest.variants.kilter.assets[0].provenanceSha256 = '';
    writeFileSync(join(root, 'app-stores/apple/creative-assets.json'), JSON.stringify(manifest));
    expect(summarize(root)).toContain('| Promoted or already approved | 0 |');
    manifest.variants.kilter.assets[0].provenanceSha256 = 'b'.repeat(64);
    manifest.variants.kilter.assets[0].poster = manifest.variants.kilter.assets[0].file;
    writeFileSync(join(root, 'app-stores/apple/creative-assets.json'), JSON.stringify(manifest));
    expect(summarize(root)).toContain('| Downloaded and SHA256 verified | 0 |');
  });
  it('preserves manual live/replacement approval and runs only the requested action', () => {
    const result = lane('place', { ALLOW_LIVE: 'true', ALLOW_REPLACE: 'true', CREATIVE_PLACEMENT: 'search' });
    expect(result.status, result.stderr).toBe(0);
    expect(result.trace).toHaveLength(1);
    expect(result.trace[0]).toContain('action:place variant:all allow_live:true allow_replace:true|search|key-present');
  });
});
