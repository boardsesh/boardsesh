import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { SHOWCASE_TAKES } from '../lib/showcase-video/takes';
import { STORE_SEARCH_VARIANTS, storeSearchTakeIds } from '../lib/showcase-video/store-search';

interface Step {
  id?: string;
  name?: string;
  uses?: string;
  run?: string;
  if?: string;
  env?: Record<string, string>;
  with?: Record<string, unknown>;
}
interface Job {
  'timeout-minutes'?: number | string;
  if?: string;
  needs?: string | string[];
  environment?: string;
  uses?: string;
  steps?: Step[];
  outputs?: Record<string, string>;
  with?: Record<string, unknown>;
  strategy?: { 'max-parallel'?: number; matrix: { kind: string[] | string; locale?: string[] } };
}
interface Workflow {
  name: string;
  on: Record<string, Record<string, unknown>>;
  jobs: Record<string, Job>;
  concurrency?: { group: string; 'cancel-in-progress': boolean | string };
}
const workflow = (name: string): Workflow => parse(readFileSync(`.github/workflows/${name}.yml`, 'utf8')) as Workflow;

describe('store video workflow handoff', () => {
  it('preserves measurement and diagnostic dispatch modes beside the train entry', () => {
    const measure = workflow('mobile-store-videos-measure');
    expect(measure.name).toBe('Mobile Store Videos (Measure)');
    expect(measure.on).not.toHaveProperty('workflow_run');
    expect(measure.on.workflow_dispatch.inputs).toMatchObject({
      mode: { options: ['measure', 'diagnose-profile-filter', 'record-profile', 'record-english'], default: 'measure' },
    });
    expect(measure.jobs.record['timeout-minutes']).toContain("inputs.mode == 'record-english' && 60");
    expect(measure.jobs.record['timeout-minutes']).toContain('&& 45 || 180');
    const commands = measure.jobs.record.steps?.filter((step) => step.run?.includes('vp run video:record')) ?? [];
    expect(commands.map((step) => step.if)).toEqual([
      "inputs.mode == 'measure'",
      "inputs.mode == 'diagnose-profile-filter'",
      "inputs.mode == 'record-profile'",
      "inputs.mode == 'record-english'",
    ]);
    expect(commands[1].run).toContain('--diagnose-profile-filter');
    expect(commands[2].run).toContain('--only log');
    expect(commands[3].run).toContain('--kind moonboard --locale en-US --app-path');
    expect(measure.jobs.render.if).toBe("inputs.mode == 'measure'");
  });

  it('admits successful release-train drafts without filtering their reported main branch', () => {
    const entry = workflow('mobile-store-videos');
    expect(entry.on.workflow_run.workflows).toEqual(['Mobile Store Draft Submission']);
    expect(entry.on.workflow_run.branches).toBeUndefined();
    expect(entry.jobs.train.if).toContain("github.event.workflow_run.conclusion == 'success'");
    expect(entry.jobs.train.if).toContain('Mobile Store Draft (release/next)');
    expect(entry.jobs.train.if).toContain('github.event.workflow_run.head_repository.full_name == github.repository');
  });

  it.each([
    { scenario: 'unset enable flag', enabled: undefined, expected: false },
    { scenario: 'disabled automatic recording', enabled: 'false', expected: false },
    { scenario: 'enabled trusted draft', enabled: 'true', expected: true },
    { scenario: 'failed draft', enabled: 'true', conclusion: 'failure', expected: false },
    { scenario: 'unrelated draft', enabled: 'true', title: 'Mobile Store Draft (main)', expected: false },
    { scenario: 'foreign repository', enabled: 'true', repository: 'someone/boardsesh', expected: false },
    { scenario: 'manual dispatch while disabled', enabled: 'false', eventName: 'workflow_dispatch', expected: true },
    { scenario: 'manual dispatch without flag', enabled: undefined, eventName: 'workflow_dispatch', expected: true },
  ])('gates $scenario before credentials or macOS recording', (scenario) => {
    const condition = workflow('mobile-store-videos').jobs.train.if!;
    const admitted: unknown = runInNewContext(condition, {
      vars: { STORE_VIDEOS_ENABLED: scenario.enabled },
      github: {
        event_name: scenario.eventName ?? 'workflow_run',
        repository: 'boardsesh/boardsesh',
        event: {
          workflow_run: {
            conclusion: scenario.conclusion ?? 'success',
            display_title: scenario.title ?? 'Mobile Store Draft (release/next)',
            head_repository: { full_name: scenario.repository ?? 'boardsesh/boardsesh' },
          },
        },
      },
    });
    expect(admitted).toBe(scenario.expected);
  });

  it('checks closed trains without store secrets, dependency installation or environment approval', () => {
    const { train, editable, pipeline } = workflow('mobile-store-videos').jobs;
    expect(train.environment).toBeUndefined();
    expect(train.steps?.some((step) => step.run?.includes('--train-only'))).toBe(true);
    for (const job of [train, editable]) {
      const checkout = job.steps?.find((step) => step.uses === 'actions/checkout@v4');
      expect(checkout?.with?.['fetch-depth']).toBe(1);
      expect(checkout?.with?.['sparse-checkout-cone-mode']).toBe(false);
      expect(checkout?.with?.['sparse-checkout']).toContain('scripts/store-videos-gate.ts');
      for (const step of job.steps ?? []) {
        expect(step.uses ?? '').not.toContain('setup-vp');
        expect(step.run ?? '').not.toContain('vp install');
      }
    }
    expect(JSON.stringify(train)).not.toContain('APP_STORE_CONNECT');
    expect(editable.needs).toBe('train');
    expect(editable.if).toContain("needs.train.outputs.open == 'true'");
    expect(pipeline.needs).toBe('editable');
    expect(pipeline.if).toContain("needs.editable.outputs.open == 'true'");
  });

  it('publishes source provenance only for a successful iOS release/next draft', () => {
    const steps = workflow('mobile-store-draft').jobs.ios.steps ?? [];
    const artifact = steps.find((step) => step.with?.name === 'store-video-source');
    expect(artifact?.if).toBe("steps.draft.outcome == 'success' && env.RELEASE_BRANCH == 'release/next'");
    expect(artifact?.with?.path).toContain('source.json');
    const sourceWriter = steps.find((step) => step.run?.includes('sourceBranch:$sourceBranch'));
    expect(sourceWriter?.env?.SOURCE_SHA).toContain('needs.release-candidate.outputs.sha');
    expect(sourceWriter?.env?.SOURCE_IOS_BUILD).toContain('needs.release-candidate.outputs.ios_build_number');
  });

  it('excludes all live-session takes from the parallel matrix and serializes crew', () => {
    const pipeline = workflow('mobile-store-videos-pipeline');
    expect(pipeline.concurrency?.group).toBe('store-videos-v${{ inputs.version }}');
    const cancels = (eventName: string) =>
      runInNewContext(String(pipeline.concurrency?.['cancel-in-progress']).replace(/^\$\{\{\s*|\s*\}\}$/g, ''), {
        github: { event_name: eventName },
      }) as boolean;
    // A newer automatic draft supersedes the old pipeline; manual subset runs for one train queue instead.
    expect(cancels('workflow_run')).toBe(true);
    expect(cancels('workflow_dispatch')).toBe(false);
    const { preflight, app, record, crew, render } = pipeline.jobs;
    expect(app.needs).toBe('preflight');
    const prerequisites = preflight.steps?.find((step) => step.run?.includes('for name in'));
    for (const credential of [
      'STORE_CREATIVES_R2_AWS_ENDPOINT_URL',
      'STORE_CREATIVES_R2_AWS_ACCESS_KEY_ID',
      'STORE_CREATIVES_R2_AWS_SECRET_ACCESS_KEY',
    ]) {
      expect(prerequisites?.env?.[credential]).toBe(`\u0024{{ secrets.${credential} }}`);
      expect(prerequisites?.run).toContain(credential);
    }
    expect(record.strategy?.['max-parallel']).toBe(3);
    for (const kind of STORE_SEARCH_VARIANTS) {
      const ordinary = storeSearchTakeIds(kind).filter((take) => take !== 'crew' && take !== 'lock-screen');
      for (const takeId of ordinary)
        expect(SHOWCASE_TAKES.find((take) => take.id === takeId)?.privateSession).toBe(false);
    }
    expect(crew.needs).toEqual(['preflight', 'app', 'record']);
    const crewLoop = crew.steps?.find((step) => step.run?.includes('vp run video:record'));
    expect(crewLoop?.env?.CREW_KINDS).toBe('${{ needs.preflight.outputs.crew }}');
    expect(crewLoop?.run).toContain(`for kind in $(jq -r '.[]' <<< "$CREW_KINDS")`);
    expect(render.strategy?.matrix.locale).toEqual(['en-US', 'es', 'fr', 'de']);
    for (const job of [record, crew]) {
      const frames = job.steps?.find(
        (step) => step.uses === 'actions/upload-artifact@v4' && step.with?.['compression-level'] === 0,
      );
      expect(frames?.with?.['retention-days']).toBe(1);
    }
  });

  it('dispatches a variant subset and keeps automatic runs on every variant', () => {
    const entry = workflow('mobile-store-videos');
    const dispatch = entry.on.workflow_dispatch as { inputs: Record<string, { type: string; default: string }> };
    expect(dispatch.inputs.variants).toMatchObject({ type: 'string', default: 'all' });
    expect(entry.jobs.pipeline.with).toMatchObject({ variants: "${{ inputs.variants || 'all' }}" });
    const call = workflow('mobile-store-videos-pipeline').on.workflow_call as {
      inputs: Record<string, { required: boolean; default: string }>;
    };
    expect(call.inputs.variants).toMatchObject({ required: false, default: 'all' });
  });

  it('resolves the selection from the source storyboards before any macOS job', () => {
    const { preflight, record, crew, render } = workflow('mobile-store-videos-pipeline').jobs;
    const plan = preflight.steps?.find((step) => step.name?.startsWith('Resolve the selected variants'));
    expect(plan?.env?.VARIANTS).toBe('${{ inputs.variants }}');
    expect(plan?.run).toContain('vp exec tsx scripts/store-videos-gate.ts plan "$VARIANTS"');
    for (const output of ['variants', 'variants_csv', 'crew', 'live_activity', 'exports'])
      expect(preflight.outputs?.[output]).toBe(`\u0024{{ steps.plan.outputs.${output} }}`);
    expect(record.needs).toEqual(['preflight', 'app']);
    expect(record.strategy?.matrix.kind).toBe('${{ fromJSON(needs.preflight.outputs.variants) }}');
    expect(render.strategy?.matrix.kind).toBe('${{ fromJSON(needs.preflight.outputs.variants) }}');
    expect(crew.if).toBe("needs.preflight.outputs.crew != '[]'");
    const crewFrames = render.steps?.find((step) => step.with?.name === 'store-video-frames-crew');
    expect(crewFrames?.if).toBe('contains(fromJSON(needs.preflight.outputs.crew), matrix.kind)');
    const hydrate = render.steps?.find(
      (step) => step.name === 'Hydrate the retained ending in its actual source language',
    );
    expect(hydrate?.if).toBe('contains(fromJSON(needs.preflight.outputs.live_activity), matrix.kind)');
  });

  describe('preflight plan on a recording source', () => {
    const sha = 'e'.repeat(64);
    const footage = (target: string) => ({
      boardFamily: target,
      sha256: sha,
      key: `sources/live-activity/${sha}.zip`,
    });
    function preflight(options: { hasPlan: boolean; variants: string; footage: string[] }) {
      const step = workflow('mobile-store-videos-pipeline').jobs.preflight.steps?.find((entry) =>
        entry.name?.startsWith('Resolve the selected variants'),
      );
      const root = mkdtempSync(join(tmpdir(), 'store-video-preflight-'));
      try {
        for (const directory of ['scripts', 'app-stores/apple/live-activity-captures', 'bin'])
          mkdirSync(join(root, directory), { recursive: true });
        writeFileSync(
          join(root, 'scripts/store-videos-gate.ts'),
          options.hasPlan ? "if (command === 'plan') {}" : "if (command === 'takes') {}",
        );
        writeFileSync(
          join(root, 'app-stores/apple/live-activity-captures/manifest.json'),
          JSON.stringify({ footage: Object.fromEntries(options.footage.map((target) => [target, footage(target)])) }),
        );
        writeFileSync(join(root, 'bin/vp'), '#!/bin/bash\necho "vp $*" >> "$GITHUB_OUTPUT"\n', { mode: 0o755 });
        const result = spawnSync('bash', ['-c', step!.run!], {
          cwd: root,
          encoding: 'utf8',
          env: {
            ...process.env,
            PATH: `${join(root, 'bin')}:${process.env.PATH}`,
            VARIANTS: options.variants,
            GITHUB_OUTPUT: join(root, 'output'),
          },
        });
        return {
          status: result.status,
          stderr: result.stderr + result.stdout,
          output: result.status === 0 ? readFileSync(join(root, 'output'), 'utf8') : '',
        };
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
    it('uses the source plan when it has one', () => {
      expect(preflight({ hasPlan: true, variants: 'default', footage: [] })).toMatchObject({
        status: 0,
        output: 'vp exec tsx scripts/store-videos-gate.ts plan default\n',
      });
    });
    it('falls back to the full matrix and both physical takes on an older source', () => {
      const result = preflight({ hasPlan: false, variants: 'all', footage: ['kilter', 'tension'] });
      expect(result.status, result.stderr).toBe(0);
      expect(result.output).toContain('variants=["default","kilter","tension","moonboard","spray"]\n');
      expect(result.output).toContain('crew=["default","kilter","tension"]\n');
      expect(result.output).toContain('exports=20\n');
      const missing = preflight({ hasPlan: false, variants: 'all', footage: ['kilter'] });
      expect(missing.status).not.toBe(0);
      expect(missing.stderr).toContain('Missing reviewed retained tension footage');
    });
    it('refuses a subset on an older source', () => {
      const result = preflight({ hasPlan: false, variants: 'default', footage: ['kilter', 'tension'] });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('predates variant subsets');
    });
  });

  it.each([
    { scenario: 'crew recorded', record: 'success', crew: 'success', render: 'success', cancelled: false, runs: true },
    {
      scenario: 'no crew selected',
      record: 'success',
      crew: 'skipped',
      render: 'success',
      cancelled: false,
      runs: true,
    },
    { scenario: 'crew failed', record: 'success', crew: 'failure', render: 'skipped', cancelled: false, runs: false },
    { scenario: 'record failed', record: 'failure', crew: 'skipped', render: 'skipped', cancelled: false, runs: false },
    { scenario: 'cancelled run', record: 'success', crew: 'skipped', render: 'success', cancelled: true, runs: false },
  ])('renders and publishes after a skipped crew job only when recording succeeded ($scenario)', (scenario) => {
    const { render, publish } = workflow('mobile-store-videos-pipeline').jobs;
    const evaluate = (condition: string) =>
      runInNewContext(condition.replace(/^\$\{\{\s*|\s*\}\}$/g, ''), {
        cancelled: () => scenario.cancelled,
        needs: {
          record: { result: scenario.record },
          crew: { result: scenario.crew },
          render: { result: scenario.render },
        },
      }) as boolean;
    expect(evaluate(render.if!)).toBe(scenario.runs);
    expect(evaluate(publish.if!)).toBe(scenario.runs);
  });

  it.each([
    { variants: '["default"]', expected: '4', downloads: 4, ok: true },
    { variants: '["default","kilter","tension","moonboard","spray"]', expected: '20', downloads: 20, ok: true },
    { variants: '["default","spray"]', expected: '4', downloads: 8, ok: false },
    { variants: '[]', expected: '0', downloads: 0, ok: false },
  ])('collects exactly the selected exports ($variants)', ({ variants, expected, downloads, ok }) => {
    const step = workflow('mobile-store-videos-pipeline').jobs.publish.steps?.find(
      (entry) => entry.name === 'Collect the selected rendered exports',
    );
    expect(step?.env?.VARIANTS).toBe('${{ needs.preflight.outputs.variants }}');
    const root = mkdtempSync(join(tmpdir(), 'store-video-collect-'));
    try {
      writeFileSync(join(root, 'gh'), '#!/bin/bash\necho "$7" >> "$TRACE"\n', { mode: 0o755 });
      const result = spawnSync('bash', ['-c', step!.run!], {
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: `${root}:${process.env.PATH}`,
          TRACE: join(root, 'trace'),
          VARIANTS: variants,
          EXPECTED_EXPORTS: expected,
          GITHUB_RUN_ID: '1',
          GITHUB_REPOSITORY: 'boardsesh/boardsesh',
        },
      });
      expect(result.status === 0, result.stderr).toBe(ok);
      const trace = downloads ? readFileSync(join(root, 'trace'), 'utf8').trim().split('\n') : [];
      expect(trace).toHaveLength(downloads);
      if (variants === '["default"]')
        expect(trace).toEqual([
          'store-video-default-en-US',
          'store-video-default-es',
          'store-video-default-fr',
          'store-video-default-de',
        ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('finalizes, uploads and reviews only the selected variants', () => {
    const steps = workflow('mobile-store-videos-pipeline').jobs.publish.steps ?? [];
    const byName = (name: string) => steps.find((step) => step.name === name);
    const finalize = byName('Finalize search entries while retaining reviewed headers');
    expect(finalize?.env?.VARIANTS).toBe('${{ needs.preflight.outputs.variants_csv }}');
    expect(finalize?.run).toContain('--placement search --variant "$VARIANTS"');
    const upload = byName('Upload immutable review candidates');
    expect(upload?.env?.VARIANTS).toBe('${{ needs.preflight.outputs.variants_csv }}');
    expect(upload?.run).toContain('upload-candidates --placement search --variant "$VARIANTS"');
    const review = byName("Refresh the train's review PR with public posters and video links");
    expect(review?.env?.VIDEO_VARIANTS).toBe('${{ needs.preflight.outputs.variants_csv }}');
    expect(review?.run).toContain('"$VIDEO_VERSION" "$VIDEO_SOURCE_SHA" "$VIDEO_VARIANTS"');
    // Carried candidates are HEAD-checked before the review branch is pushed.
    expect(review?.env?.STORE_CREATIVES_R2_AWS_ENDPOINT_URL).toBe('${{ secrets.STORE_CREATIVES_R2_AWS_ENDPOINT_URL }}');
  });

  it('uses the screenshot cache and Maestro pin, and publishes only finalized search exports', () => {
    const pipeline = workflow('mobile-store-videos-pipeline');
    const screenshot = workflow('mobile-screenshots-ios');
    const videoKey = pipeline.jobs.app.steps?.find((step) => step.id === 'appkey');
    const screenshotKey = screenshot.jobs['ios-build'].steps?.find((step) => step.id === 'appkey');
    expect(videoKey?.run).toContain('ios-screenshot-app-cache.ts key');
    expect(videoKey?.env?.NATIVE_INPUT_HASH).toBe(screenshotKey?.env?.NATIVE_INPUT_HASH);
    const action = readFileSync('.github/actions/ios-store-video-tools/action.yml', 'utf8');
    const screenshotAction = readFileSync('.github/actions/ios-screenshot-shard/action.yml', 'utf8');
    const maestroHash = /MAESTRO_SHA256: ([a-f0-9]+)/.exec(action)?.[1];
    expect(maestroHash).toHaveLength(64);
    expect(screenshotAction).toContain(maestroHash);
    const publish = pipeline.jobs.publish;
    expect(publish.environment).toBe('Production');
    expect(JSON.stringify(publish)).toContain('--placement search');
    expect(JSON.stringify(publish)).toContain('upload-candidates');
    expect(JSON.stringify(publish)).not.toContain('approved/');
    expect(JSON.stringify(publish)).not.toContain('fastlane ios creatives');
  });

  it('rechecks train state and exact source before any candidate or review-PR write', () => {
    const publish = workflow('mobile-store-videos-pipeline').jobs.publish;
    const gateIndex = publish.steps!.findIndex(
      (step) => step.name === 'Recheck the open train immediately before publishing',
    );
    expect(gateIndex).toBeGreaterThan(0);
    const gate = publish.steps![gateIndex];
    expect(gate.env?.EXPECTED_SOURCE_SHA).toBe('${{ inputs.source_sha }}');
    expect(gate.run).toContain('node --experimental-strip-types scripts/store-videos-gate.ts gate');
    expect(gate.run).toContain('--pinned-sha "$EXPECTED_SOURCE_SHA" --pinned-version "$EXPECTED_VERSION"');
    expect(gate.run).toContain('"$source_sha" != "$EXPECTED_SOURCE_SHA"');
    for (const step of publish.steps!.slice(gateIndex + 1))
      expect(step.if).toBe("steps.final-gate.outputs.open == 'true'");
  });
});
