import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { SHOWCASE_TAKES } from '../lib/showcase-video/takes';
import { STORE_SEARCH_VARIANTS, storeSearchTakeIds } from '../lib/showcase-video/store-search';

interface Step {
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
  strategy?: { 'max-parallel'?: number; matrix: { kind: string[]; locale?: string[] } };
}
interface Workflow {
  name: string;
  on: Record<string, Record<string, unknown>>;
  jobs: Record<string, Job>;
  concurrency?: { group: string; 'cancel-in-progress': boolean };
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
    expect(pipeline.concurrency).toEqual({ group: 'store-videos-v${{ inputs.version }}', 'cancel-in-progress': true });
    const { preflight, app, record, crew, render } = pipeline.jobs;
    expect(app.needs).toBe('preflight');
    expect(JSON.stringify(preflight)).toContain('Missing reviewed retained');
    expect(record.strategy?.['max-parallel']).toBe(3);
    expect(record.strategy?.matrix.kind).toHaveLength(5);
    for (const kind of STORE_SEARCH_VARIANTS) {
      const ordinary = storeSearchTakeIds(kind).filter((take) => take !== 'crew' && take !== 'lock-screen');
      for (const takeId of ordinary)
        expect(SHOWCASE_TAKES.find((take) => take.id === takeId)?.privateSession).toBe(false);
    }
    expect(crew.needs).toEqual(['app', 'record']);
    expect(JSON.stringify(crew)).toContain('for kind in default kilter tension');
    expect(render.strategy!.matrix.kind.length * render.strategy!.matrix.locale!.length).toBe(20);
    for (const job of [record, crew]) {
      const frames = job.steps?.find(
        (step) => step.uses === 'actions/upload-artifact@v4' && step.with?.['compression-level'] === 0,
      );
      expect(frames?.with?.['retention-days']).toBe(1);
    }
  });

  it('uses the screenshot cache and Maestro pin, and publishes only finalized search exports', () => {
    const pipeline = workflow('mobile-store-videos-pipeline');
    const screenshot = workflow('mobile-screenshots-ios');
    const videoKey = pipeline.jobs.app.steps?.find((step) => step.run?.includes('screenshot-sim-app-v1'))?.run;
    const screenshotKey = screenshot.jobs['ios-build'].steps?.find((step) =>
      step.run?.includes('screenshot-sim-app-v1'),
    )?.run;
    expect(videoKey).toBe(screenshotKey);
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
