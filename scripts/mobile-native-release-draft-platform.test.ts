import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

type WorkflowStep = { name?: string; run?: string; if?: string; env?: Record<string, string> };
type WorkflowJob = { if?: string; outputs?: Record<string, string>; steps: WorkflowStep[] };
const workflow = parse(
  readFileSync(new URL('../.github/workflows/mobile-store-draft.yml', import.meta.url), 'utf8'),
) as {
  jobs: Record<string, WorkflowJob>;
};
const candidate = workflow.jobs['release-candidate'];
const stepNamed = (name: string) => candidate.steps.find((step) => step.name === name)!;

describe('independent automatic store drafts', () => {
  it('keeps workflow-call public submissions paired and routes uploaded receipts to their platform', () => {
    const resolve = stepNamed('Resolve the release branch').run!;
    const pinned = resolve.slice(
      resolve.indexOf('if [ -n "$PINNED_RELEASE_SHA" ]'),
      resolve.indexOf('case "$RELEASE_BRANCH"'),
    );
    expect(pinned).toContain('echo "platform=all"');
    expect(resolve).toContain(`sed -n 's/^platform=//p' "$source_file"`);
    expect(workflow.jobs.ios.if).toContain("outputs.platform != 'android'");
    expect(workflow.jobs.android.if).toContain("outputs.platform != 'ios'");
  });

  it('checks and rechecks only the selected single-store candidate', () => {
    for (const name of [
      'Select exact uploaded builds for the release-branch version',
      'Recheck the release branch after fingerprint comparison',
    ]) {
      const step = stepNamed(name);
      expect(step.env?.DRAFT_PLATFORM).toBe('${{ steps.ref.outputs.platform }}');
      expect(step.run).toContain('elif [ "$DRAFT_PLATFORM" != all ]; then');
      expect(step.run).toContain('CANDIDATE_PLATFORM="$DRAFT_PLATFORM"');
      expect(step.run).toContain('CANDIDATE_ANCESTOR_OF=');
    }
    const comparison = stepNamed("Verify tagged builds match the release branch's native state").run!;
    expect(comparison).toContain('if [ -n "$EXPECTED_IOS_TAG" ]; then');
    expect(comparison).toContain('if [ -n "$EXPECTED_ANDROID_TAG" ]; then');
  });

  it('keeps every workflow shell block syntactically valid', () => {
    for (const job of Object.values(workflow.jobs)) {
      for (const step of job.steps ?? []) {
        if (step.run) expect(() => execFileSync('bash', ['-n'], { input: step.run })).not.toThrow();
      }
    }
  });
});

describe('uploaded draft CLI without store or network access', () => {
  const source = fileURLToPath(new URL('./mobile-cut-release-tags.ts', import.meta.url));
  const ios = 'build-ios-v2.8.0-7-aaaaaaaaaaaa';
  const android = 'build-android-v2.8.1-2000200-bbbbbbbbbbbb';
  function runCandidate(tags: string[], platform?: string) {
    const directory = mkdtempSync(join(tmpdir(), 'draft-platform-'));
    const fakeGit = join(directory, 'git');
    writeFileSync(
      fakeGit,
      `#!/bin/sh
case "$1" in
  fetch|merge-base) exit 0 ;;
  tag) printf '%s\\n' "$DRAFT_TEST_TAGS" ;;
  rev-list) printf '%s\\n' aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa ;;
  *) exit 99 ;;
esac
`,
    );
    chmodSync(fakeGit, 0o755);
    try {
      return execFileSync(process.execPath, ['--import', 'tsx', source], {
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: `${directory}:${process.env.PATH}`,
          DRAFT_TEST_TAGS: tags.join('\n'),
          CHECK_ONLY: 'true',
          CANDIDATE_ONLY: 'true',
          UPLOADED_ONLY: 'true',
          HEAD_VERSION: '2.8.1',
          CANDIDATE_PLATFORM: platform ?? '',
          CANDIDATE_ANCESTOR_OF: 'a'.repeat(40),
          GITHUB_OUTPUT: join(directory, 'output'),
        },
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }

  it('allows an Android draft while iOS remains on its accepted version', () => {
    const output = runCandidate([ios, android], 'android');
    expect(output).toContain('candidates_found=true');
    expect(output).toContain(`android_build_tag=${android}`);
    expect(output).not.toContain('ios_build_tag=');
    expect(output).toContain('cut_count=0');
  });

  it('retains paired readiness for the public submission caller', () => {
    expect(runCandidate([ios, android])).toContain('candidates_found=false');
  });

  it('refuses an ambiguous highest upload instead of falling back', () => {
    const output = runCandidate([android, 'build-android-v2.8.1-2000200-cccccccccccc'], 'android');
    expect(output).toContain('candidates_found=false');
  });
});

describe('store writer final receipt rechecks', () => {
  function recheck(platform: 'ios' | 'android', paired: boolean, moved = false) {
    const directory = mkdtempSync(join(tmpdir(), 'draft-writer-'));
    const script = workflow.jobs[platform].steps.find(
      (step) => step.name === 'Recheck the pinned release branch and uploaded builds',
    )!.run!;
    const fakeGh = join(directory, 'gh');
    writeFileSync(
      fakeGh,
      `#!/bin/sh
case "$2" in
  */compare/*) printf '%s\\n' ahead ;;
  */tags/build-ios-*) printf '%s\\n' "$MOCK_IOS_SHA" ;;
  */tags/build-android-*) printf '%s\\n' "$MOCK_ANDROID_SHA" ;;
  *) exit 99 ;;
esac
`,
    );
    chmodSync(fakeGh, 0o755);
    try {
      return execFileSync('bash', ['-c', script], {
        encoding: 'utf8',
        stdio: 'pipe',
        env: {
          ...process.env,
          PATH: `${directory}:${process.env.PATH}`,
          GITHUB_REPOSITORY: 'test/repo',
          EXPECTED_RELEASE_SHA: 'a'.repeat(40),
          EXPECTED_IOS_TAG: platform === 'ios' || paired ? 'build-ios-v2.8.1-1-aaaaaaaaaaaa' : '',
          EXPECTED_IOS_SHA: platform === 'ios' || paired ? 'a'.repeat(40) : '',
          EXPECTED_ANDROID_TAG: platform === 'android' || paired ? 'build-android-v2.8.1-2000001-bbbbbbbbbbbb' : '',
          EXPECTED_ANDROID_SHA: platform === 'android' || paired ? 'b'.repeat(40) : '',
          MOCK_IOS_SHA: moved ? 'c'.repeat(40) : 'a'.repeat(40),
          MOCK_ANDROID_SHA: moved ? 'c'.repeat(40) : 'b'.repeat(40),
        },
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }

  it.each(['ios', 'android'] as const)(
    'admits a %s-only draft without looking up an empty companion ref',
    (platform) => {
      expect(() => recheck(platform, false)).not.toThrow();
    },
  );
  it.each(['ios', 'android'] as const)('still verifies both receipts for a paired %s draft', (platform) => {
    expect(() => recheck(platform, true)).not.toThrow();
    expect(() => recheck(platform, true, true)).toThrow();
  });
});
