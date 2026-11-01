/// <reference types="node" />

import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

// The automatic manual release submission and the workflows it shares locks with.
// Text and structure are pinned here; the decisions that live in shell are run
// under bash further down.

type Step = { id?: string; name?: string; if?: string; run?: string; uses?: string; env?: Record<string, string> };
type Job = {
  if?: string;
  needs?: string | string[];
  environment?: string;
  uses?: string;
  with?: Record<string, string>;
  secrets?: string;
  permissions?: Record<string, string>;
  concurrency?: Record<string, unknown>;
  outputs?: Record<string, string>;
  env?: Record<string, string>;
  steps?: Step[];
};
type Workflow = {
  name: string;
  on: Record<string, unknown>;
  concurrency?: Record<string, unknown>;
  permissions?: Record<string, string>;
  env?: Record<string, string>;
  jobs: Record<string, Job>;
};

const read = (name: string) => readFileSync(`.github/workflows/${name}`, 'utf8');
const load = (name: string) => parse(read(name), { strict: true, uniqueKeys: true }) as Workflow;
const flatten = (value: string | undefined) => (value ?? '').replace(/\s+/g, ' ').trim();

const submit = load('mobile-store-submit.yml');
const submitSource = read('mobile-store-submit.yml');
const draft = load('mobile-store-draft.yml');
const draftSource = read('mobile-store-draft.yml');
const step = (job: string, name: string) => {
  const found = submit.jobs[job]?.steps?.find((entry) => entry.name === name);
  if (!found) throw new Error(`no step "${name}" in ${job}`);
  return found;
};

describe('mobile-store-submit.yml triggers', () => {
  it('only runs on explicit dispatch and requires an exact build pair', () => {
    expect(Object.keys(submit.on)).toEqual(['workflow_dispatch']);
    const inputs = (submit.on['workflow_dispatch'] as { inputs: Record<string, Record<string, unknown>> }).inputs;
    expect(inputs['action']).toMatchObject({ type: 'choice', default: 'plan', options: ['plan', 'submit'] });
    for (const key of ['version', 'release_sha', 'ios_build_number', 'android_version_code']) {
      expect(inputs[key]).toMatchObject({ type: 'string', required: true });
      expect(inputs[key]).not.toHaveProperty('default');
    }
    expect(submit.jobs['target']?.if).toContain("github.event_name == 'workflow_dispatch'");
    expect(submit.jobs['draft']?.with?.['ios_build_number']).toBe('${{ needs.target.outputs.ios_build_number }}');
    expect(submit.jobs['draft']?.with?.['android_version_code']).toBe(
      '${{ needs.target.outputs.android_version_code }}',
    );
  });

  it('binds iOS status to the exact requested build', () => {
    expect(submit.jobs['status-ios']?.env?.['IOS_BUILD_NUMBER']).toBe('${{ needs.target.outputs.ios_build_number }}');
  });

  it('works only from main', () => {
    expect(flatten(submit.jobs['target']?.if)).toContain("github.ref == 'refs/heads/main'");
    for (const job of ['status-ios', 'status-android', 'draft', 'submit-ios', 'submit-android']) {
      expect(submit.jobs[job]?.needs, job).toContain('target');
    }
  });

  it('asks for read-only repository access, and actions: write only for the called draft', () => {
    expect(submit.permissions).toEqual({ contents: 'read' });
    expect(submit.jobs['draft']?.permissions).toEqual({ contents: 'read', actions: 'write' });
    for (const [name, job] of Object.entries(submit.jobs)) {
      if (name !== 'draft') expect(job.permissions, name).toBeUndefined();
    }
  });
});

describe('the mobile-store-draft lock', () => {
  it('holds the store-draft group for the whole run, queued', () => {
    expect(submit.concurrency).toEqual({ group: 'mobile-store-draft', 'cancel-in-progress': false, queue: 'max' });
  });

  // GitHub keeps one pending run per group and replaces the rest unless every
  // member queues. A manual release submission must never be dropped behind a draft.
  it.each([
    'mobile-store-draft.yml',
    'mobile-store-review-submission.yml',
    'mobile-store-release-control.yml',
    'mobile-store-audit.yml',
  ])('%s queues in the same group', (name) => {
    const concurrency = load(name).concurrency as Record<string, string>;
    expect(concurrency['cancel-in-progress']).toBe(false);
    expect(concurrency['queue']).toBe('max');
    expect(concurrency['group']).toContain('mobile-store-draft');
  });

  it('finds every member of the group, so none is left without queue: max', () => {
    const members = readdirSync('.github/workflows').filter(
      (name) => read(name).includes("'mobile-store-draft'") || /group: mobile-store-draft$/m.test(read(name)),
    );
    expect(members.sort()).toEqual([
      'mobile-store-audit.yml',
      'mobile-store-draft.yml',
      'mobile-store-metadata.yml',
      'mobile-store-release-control.yml',
      'mobile-store-review-submission.yml',
      'mobile-store-submit.yml',
    ]);
  });

  // The iOS listing push joins at job level: a push between the submission's plan
  // and its submit would change the reviewed snapshot.
  it('puts the iOS listing push in the same queued lock, and cannot deadlock on it', () => {
    const metadata = load('mobile-store-metadata.yml');
    expect(metadata.jobs['ios']?.concurrency).toEqual({
      group: 'mobile-store-draft',
      'cancel-in-progress': false,
      queue: 'max',
    });
    // The submission pushes the text in its own job; it never starts or calls the
    // metadata workflow, which would wait on the lock this run holds.
    expect(submitSource).not.toContain('mobile-store-metadata.yml');
    expect(step('submit-ios', "Push listing text and What's New").run).toContain('bundle exec fastlane ios metadata');
    // The draft only dispatches it (no wait), so that run just queues behind the draft.
    expect(draftSource).toContain('bundle exec fastlane ios metadata');
    expect(draftSource).not.toMatch(/gh run watch|uses: \.\/\.github\/workflows\/mobile-store-metadata\.yml/);
  });

  // A called workflow's own concurrency applies too: in its caller's group it
  // would wait for the caller to finish, which waits for it.
  it('gives a called draft a per-run group of its own', () => {
    expect(draft.concurrency?.['group']).toBe(
      "${{ inputs.release_sha && format('mobile-store-draft-call-{0}', github.run_id) || 'mobile-store-draft' }}",
    );
    expect(submit.jobs['draft']?.uses).toBe('./.github/workflows/mobile-store-draft.yml');
    expect(submit.jobs['draft']?.with?.['release_sha']).toBe('${{ needs.target.outputs.release_sha }}');
  });
});

describe('mobile-store-draft.yml as a called workflow', () => {
  const call = draft.on['workflow_call'] as {
    inputs: Record<string, { required?: boolean; type: string; default?: string }>;
    outputs: Record<string, { value: string }>;
  };

  it('keeps its own triggers unchanged and adds workflow_call', () => {
    expect(Object.keys(draft.on).sort()).toEqual(['workflow_call', 'workflow_dispatch', 'workflow_run']);
    expect(call.inputs['release_sha']).toMatchObject({ required: true, type: 'string' });
    expect(call.inputs['platform']).toMatchObject({ type: 'string', default: 'all' });
  });

  it('reports what it found, including drafts that finished green without writing', () => {
    expect(Object.fromEntries(Object.entries(call.outputs).map(([key, output]) => [key, output.value]))).toEqual({
      candidate_ready: '${{ jobs.release-candidate.outputs.candidate_ready }}',
      version: '${{ jobs.release-candidate.outputs.version }}',
      ios_build_number: '${{ jobs.release-candidate.outputs.ios_build_number }}',
      ios_build_tag: '${{ jobs.release-candidate.outputs.ios_build_tag }}',
      android_version_code: '${{ jobs.release-candidate.outputs.android_version_code }}',
      android_build_tag: '${{ jobs.release-candidate.outputs.android_build_tag }}',
      ios_draft: "${{ jobs.ios.outputs.draft || 'skipped' }}",
      android_draft: "${{ jobs.android.outputs.draft || 'skipped' }}",
    });
    expect(draft.jobs['ios']?.outputs?.['draft']).toBe(
      "${{ steps.draft.outcome == 'skipped' && 'failure' || steps.draft.outcome }}",
    );
    expect(draft.jobs['android']?.outputs?.['draft']).toBe(
      "${{ steps.guard.outcome != 'success' && 'failure' || steps.draft.outcome }}",
    );
  });

  it('reads the platform from inputs, which a called run fills, not from its caller’s dispatch', () => {
    expect(draftSource).not.toContain('github.event.inputs.platform');
    expect(flatten(draft.jobs['ios']?.if)).toContain("inputs.platform == 'ios' || inputs.platform == 'all'");
    expect(flatten(draft.jobs['android']?.if)).toContain("inputs.platform == 'android' || inputs.platform == 'all'");
  });

  // Main moves many times a day, so "the branch has not moved" would abort most
  // called runs. A pinned commit must stay in main's history instead.
  it('pins the selected release commit and checks it is in main instead of checking the branch head', () => {
    expect(draft.env?.['PINNED_RELEASE_SHA']).toBe('${{ inputs.release_sha }}');
    const compare =
      /gh api "repos\/\$\{GITHUB_REPOSITORY\}\/compare\/\$\{(?:PINNED|EXPECTED)_RELEASE_SHA\}\.\.\.main" --jq '\.status'/g;
    // Resolve, the post-fingerprint recheck, and both store jobs' prechecks.
    expect(draftSource.match(compare)).toHaveLength(4);
    expect(draftSource.match(/ahead\|identical\) ;;/g)?.length).toBeGreaterThanOrEqual(4);
    // The tag rechecks stay on every path.
    expect(draftSource.match(/assert_ref "tags\/\$EXPECTED_IOS_TAG" "\$EXPECTED_IOS_SHA"/g)).toHaveLength(2);
    expect(draftSource.match(/assert_ref "tags\/\$EXPECTED_ANDROID_TAG" "\$EXPECTED_ANDROID_SHA"/g)).toHaveLength(2);
  });

  // A later rebuild of the same version is not part of the manual release, so it is
  // never the manual release's candidate. Other drafts keep considering every tag.
  it("selects only builds in the selected release commit's history when pinned", () => {
    expect(draftSource).toContain('CANDIDATE_ANCESTOR_OF="$RELEASE_HEAD_SHA"');
    expect(draftSource).toContain('CANDIDATE_ANCESTOR_OF="$EXPECTED_RELEASE_SHA"');
    expect(draftSource.match(/scripts\/mobile-store-submit-target\.ts/g)).toHaveLength(2);
    const script = readFileSync('scripts/mobile-cut-release-tags.ts', 'utf8');
    expect(script).toContain("execFileSync('git', ['merge-base', '--is-ancestor', `${tagName}^{commit}`, ancestorOf]");
    // Unset (workflow_run and dispatch drafts): no filter.
    expect(script).toContain("const ancestorOf = process.env['CANDIDATE_ANCESTOR_OF'];\n  if (ancestorOf) {");
  });

  it('leaves listing and screenshot follow-ups to the submit workflow on a called run', () => {
    const iosSteps = draft.jobs['ios']?.steps ?? [];
    for (const name of [
      "Push listing text and What's New onto the drafted version",
      'Install screenshot tooling',
      'Fetch screenshot baseline',
      'Attach baseline screenshots to the draft',
      'Warn if no screenshot baseline has been published yet',
    ]) {
      expect(flatten(iosSteps.find((entry) => entry.name === name)?.if), name).toContain('!inputs.release_sha');
    }
  });

  // A version already in a review draft is resumed without the draft lane, which
  // cannot see that state and would try to create the version again.
  it('writes no Android draft and, in a plan or a resumed review draft, no draft at all', () => {
    expect(submit.jobs['draft']?.with?.['platform']).toBe(
      "${{ needs.target.outputs.mode == 'submit' && vars.STORE_AUTO_SUBMIT != 'off' && needs.status-ios.outputs.ios_status == 'pending' && needs.status-ios.outputs.ios_needs_draft == 'true' && 'ios' || 'none' }}",
    );
    expect(submit.jobs['draft']?.secrets).toBe('inherit');
  });
});

describe('store writes', () => {
  const writeCommands = [
    'fastlane ios metadata',
    'lib/store_release_control.rb',
    'action:submit',
    'mobile-store-submit-android.ts --apply',
  ];
  const writeSteps = Object.entries(submit.jobs).flatMap(([job, definition]) =>
    (definition.steps ?? [])
      .filter((entry) => writeCommands.some((command) => entry.run?.includes(command)))
      .map((entry) => ({ job, entry })),
  );

  it('finds one gated step per store write', () => {
    expect(writeSteps.map(({ job, entry }) => `${job}: ${entry.name}`)).toEqual([
      "submit-ios: Push listing text and What's New",
      'submit-ios: Release on approval',
      'submit-ios: Submit for App Review',
      'submit-android: Release to production at 100%',
    ]);
  });

  // STORE_AUTO_SUBMIT=off, or a dispatched plan, must reach every write.
  it('gates every write on the kill switch and the run mode, read again in each job', () => {
    for (const { job, entry } of writeSteps) {
      expect(flatten(entry.if), `${job}: ${entry.name}`).toMatch(/^env\.SUBMIT == 'true'( && .+)?$/);
    }
    for (const job of ['submit-ios', 'submit-android']) {
      expect(submit.jobs[job]?.env?.['SUBMIT'], job).toBe(
        "${{ needs.target.outputs.mode == 'submit' && vars.STORE_AUTO_SUBMIT != 'off' }}",
      );
    }
    // A plan reads both stores but writes nothing.
    expect(flatten(step('submit-android', 'Plan the Android release').if)).toBe("env.SUBMIT != 'true'");
    expect(step('submit-android', 'Plan the Android release').run).not.toContain('--apply');
    // With the kill switch off, hourly runs stop; a push or a dispatch still plans.
    expect(flatten(submit.jobs['target']?.if)).toContain("github.event_name == 'workflow_dispatch'");
    expect(step('target', 'Resolve the exact manual target').env).toMatchObject({
      STORE_AUTO_SUBMIT: '${{ vars.STORE_AUTO_SUBMIT }}',
      SUBMIT_ACTION: '${{ inputs.action }}',
    });
  });

  it('asks the stores before drafting, and submits only what they call pending', () => {
    expect(submit.jobs['target']?.environment).toBeUndefined();
    for (const job of ['status-ios', 'status-android']) {
      expect(submit.jobs[job]?.environment, job).toBe('Production');
      expect(flatten(submit.jobs[job]?.if), job).toBe("needs.target.outputs.proceed == 'true'");
      expect(submit.jobs[job]?.needs, job).toBe('target');
    }
    expect(flatten(submit.jobs['submit-ios']?.if)).toBe("needs.status-ios.outputs.ios_status == 'pending'");
    expect(flatten(submit.jobs['submit-android']?.if)).toBe("needs.status-android.outputs.android_status == 'pending'");
    for (const job of ['submit-ios', 'submit-android']) {
      expect(submit.jobs[job]?.environment, job).toBe('Production');
      expect(submit.jobs[job]?.steps?.[0]?.name, job).toBe('Require the exact verified candidate');
    }
    expect(step('status-ios', 'Where the iOS version stands').run).toContain(
      'bundle exec fastlane ios submission_status',
    );
    expect(step('status-android', 'Where the Android build stands').run).toContain(
      'mobile-store-submit-android.ts --status',
    );
  });

  // A store whose status cannot be read stops its own submission (its status job
  // fails, the run shows red) and nothing else.
  it('keeps each store independent of the other store failing its status read', () => {
    expect(submit.jobs['draft']?.needs).toEqual(['target', 'status-ios', 'status-android']);
    expect(flatten(submit.jobs['draft']?.if)).toBe(
      "!cancelled() && needs.target.result == 'success' && (needs.status-ios.outputs.ios_status == 'pending' || needs.status-android.outputs.android_status == 'pending')",
    );
    expect(submit.jobs['submit-ios']?.needs).toEqual(['target', 'status-ios', 'draft']);
    expect(submit.jobs['submit-android']?.needs).toEqual(['target', 'status-android', 'draft']);
    for (const job of ['status-ios', 'status-android']) {
      expect(JSON.stringify(submit.jobs[job]), job).not.toContain('continue-on-error');
    }
  });

  // The text goes first: it also creates any locale the version lacks.
  it('pushes the text, checks readiness, sets release on approval, plans, then submits', () => {
    const names = (submit.jobs['submit-ios']?.steps ?? []).map((entry) => entry.name);
    const order = [
      'Take the listing text from the selected release commit',
      "Push listing text and What's New",
      'Check the App Store version is ready',
      'Release on approval',
      'Plan the review submission',
      'Submit for App Review',
    ].map((name) => names.indexOf(name));
    expect(order.every((index) => index >= 0)).toBe(true);
    expect([...order].sort((left, right) => left - right)).toEqual(order);
    expect(step('submit-ios', 'Check the App Store version is ready').run).toContain(
      'fastlane ios audit surfaces:default',
    );
    expect(step('submit-ios', "Push listing text and What's New").run).toContain('"expected_version:$RELEASE_VERSION"');
    expect(step('submit-ios', 'Submit for App Review').env?.['REVIEW_SNAPSHOT_SHA256']).toBe(
      '${{ steps.plan.outputs.snapshot_sha256 }}',
    );
    // Only the default app page; custom product pages stay manual.
    expect(submitSource.match(/surfaces:default/g)).toHaveLength(3);
    expect(submitSource).not.toMatch(/surfaces:(?!default)/);
  });

  it('serializes the Android release with every Play production writer', () => {
    expect(submit.jobs['submit-android']?.concurrency).toEqual({
      group: 'play-production-track',
      'cancel-in-progress': false,
      queue: 'max',
    });
  });

  it('retains the readiness audit, plan and receipts', () => {
    for (const job of ['submit-ios', 'submit-android']) {
      const upload = submit.jobs[job]?.steps?.find((entry) => entry.uses === 'actions/upload-artifact@v4');
      expect(upload?.if, job).toBe('always()');
    }
  });
});

describe('release on approval and 100% stay on the automatic path', () => {
  // The shared draft lane, the hand-run release control and the hand-run review
  // submission keep MANUAL; only mobile-store-submit.yml asks for AFTER_APPROVAL.
  it('asks for AFTER_APPROVAL only from mobile-store-submit.yml', () => {
    const askers = readdirSync('.github/workflows').filter((name) => read(name).includes('AFTER_APPROVAL'));
    expect(askers).toEqual(['mobile-store-submit.yml']);
    expect(step('submit-ios', 'Release on approval').env?.['STORE_RELEASE_TYPE']).toBe('AFTER_APPROVAL');
    expect(step('submit-ios', 'Submit for App Review').run).toContain('release_type:AFTER_APPROVAL');
    const fastfile = readFileSync('fastlane/Fastfile', 'utf8');
    const iosDraftLane = fastfile.slice(
      fastfile.indexOf('lane :draft_submission do'),
      fastfile.indexOf('lane :creatives do'),
    );
    expect(iosDraftLane).toContain('automatic_release: false,');
    expect(fastfile).toContain('release_type: (options[:release_type] || "MANUAL").to_s');
    expect(readFileSync('fastlane/lib/store_release_control.rb', 'utf8')).toContain(
      'ENV.fetch("STORE_RELEASE_TYPE", "MANUAL")',
    );
  });

  it('releases Android at 100% through Android Production Release’s own code', () => {
    const script = readFileSync('scripts/mobile-store-submit-android.ts', 'utf8');
    expect(script).toContain("import { promoteAndroidProduction } from './mobile-store-android-production';");
    expect(script.match(/rolloutPercent: 100/g)).toHaveLength(2);
    expect(script).not.toMatch(/rolloutPercent: (?!100)/);
    expect(submitSource).not.toContain('ANDROID_ROLLOUT_PERCENT');
  });
});

// ─── Executed ───────────────────────────────────────────────────────────────────

type ScriptRun = { status: number | null; stdout: string; outputs: Record<string, string> };

function runScript(script: string, env: Record<string, string>, stubs: Record<string, string> = {}): ScriptRun {
  const sandbox = mkdtempSync(join(tmpdir(), 'store-submit-step-'));
  try {
    const bin = join(sandbox, 'bin');
    mkdirSync(bin);
    for (const [command, body] of Object.entries(stubs)) {
      writeFileSync(join(bin, command), body);
      chmodSync(join(bin, command), 0o755);
    }
    const outputPath = join(sandbox, 'github-output');
    writeFileSync(outputPath, '');
    writeFileSync(join(sandbox, 'step.sh'), script);
    const result = spawnSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', join(sandbox, 'step.sh')], {
      cwd: sandbox,
      encoding: 'utf8',
      env: {
        PATH: `${bin}:${process.env.PATH ?? ''}`,
        HOME: sandbox,
        GITHUB_OUTPUT: outputPath,
        GITHUB_REPOSITORY: 'boardsesh/boardsesh',
        NATIVE_SOURCE_RUN_ID: '',
        ...env,
      },
    });
    const outputs: Record<string, string> = {};
    for (const line of readFileSync(outputPath, 'utf8').split('\n')) {
      const separator = line.indexOf('=');
      if (separator > 0) outputs[line.slice(0, separator)] = line.slice(separator + 1);
    }
    return { status: result.status, stdout: result.stdout, outputs };
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
}

describe('the decisions, executed', { timeout: 30_000 }, () => {
  const SHA = 'c'.repeat(40);
  // `gh api .../compare/...` answers $STUB_COMPARE; nothing else is expected.
  const ghStub = `#!/usr/bin/env bash\ncase "$*" in *compare*) printf '%s\\n' "$STUB_COMPARE" ;; *) exit 9 ;; esac\n`;
  const resolve = draft.jobs['release-candidate']?.steps?.find((entry) => entry.id === 'ref')?.run ?? '';

  it('pins a selected release commit that is in main, and refuses one that is not', () => {
    for (const compare of ['ahead', 'identical']) {
      const run = runScript(
        resolve,
        { PINNED_RELEASE_SHA: SHA, RELEASE_BRANCH: 'main', STUB_COMPARE: compare },
        { gh: ghStub },
      );
      expect(run.status, compare).toBe(0);
      expect(run.outputs['sha']).toBe(SHA);
    }
    for (const compare of ['diverged', 'behind', '']) {
      const run = runScript(
        resolve,
        { PINNED_RELEASE_SHA: SHA, RELEASE_BRANCH: 'main', STUB_COMPARE: compare },
        { gh: ghStub },
      );
      expect(run.status, compare).not.toBe(0);
      expect(run.outputs['sha']).toBeUndefined();
    }
  });

  it('refuses a short SHA, or a pinned run from anywhere but main', () => {
    expect(
      runScript(
        resolve,
        { PINNED_RELEASE_SHA: 'c'.repeat(12), RELEASE_BRANCH: 'main', STUB_COMPARE: 'ahead' },
        { gh: ghStub },
      ).status,
    ).not.toBe(0);
    expect(
      runScript(
        resolve,
        { PINNED_RELEASE_SHA: SHA, RELEASE_BRANCH: 'release/next', STUB_COMPARE: 'ahead' },
        { gh: ghStub },
      ).status,
    ).not.toBe(0);
  });

  const requireIos = step('submit-ios', 'Require the exact verified candidate').run ?? '';
  const ready = {
    CANDIDATE_READY: 'true',
    TARGET_VERSION: '2.7.0',
    RELEASE_VERSION: '2.7.0',
    IOS_BUILD_NUMBER: '12',
    IOS_DRAFT: 'success',
    NEEDS_DRAFT: 'true',
    SUBMIT: 'true',
  };

  it('fails the iOS submission unless the draft produced a verified candidate', () => {
    expect(runScript(requireIos, ready).status).toBe(0);
    for (const broken of [
      { CANDIDATE_READY: '' },
      { CANDIDATE_READY: 'false' },
      { RELEASE_VERSION: '2.7.1' },
      { IOS_BUILD_NUMBER: '' },
      { IOS_DRAFT: 'failure' },
      { IOS_DRAFT: 'skipped' },
    ]) {
      expect(runScript(requireIos, { ...ready, ...broken }).status, JSON.stringify(broken)).not.toBe(0);
    }
    // A plan writes no draft, nor does resuming a review draft: a skipped draft is expected there.
    expect(runScript(requireIos, { ...ready, SUBMIT: 'false', IOS_DRAFT: 'skipped' }).status).toBe(0);
    expect(runScript(requireIos, { ...ready, NEEDS_DRAFT: 'false', IOS_DRAFT: 'skipped' }).status).toBe(0);
  });

  it('fails the Android release unless the draft produced a verified candidate', () => {
    const requireAndroid = step('submit-android', 'Require the exact verified candidate').run ?? '';
    const androidReady = {
      CANDIDATE_READY: 'true',
      DRAFT_VERSION: '2.7.0',
      TARGET_VERSION: '2.7.0',
      ANDROID_VERSION_CODE: '2001310',
    };
    expect(runScript(requireAndroid, androidReady).status).toBe(0);
    for (const broken of [{ CANDIDATE_READY: 'false' }, { DRAFT_VERSION: '' }, { ANDROID_VERSION_CODE: 'abc' }]) {
      expect(runScript(requireAndroid, { ...androidReady, ...broken }).status, JSON.stringify(broken)).not.toBe(0);
    }
  });
});
