import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from '../testflight-notes';
import type { TestflightBuildReceipt } from '../lib/testflight-build';
import {
  fetchNativeNotesPullRequests,
  fetchOtaComments,
  generateTestflightNotes,
  hasIosNativeChange,
  nativeTestScenario,
  renderTestflightNotes,
  selectNativeNotesPullRequests,
  type NativeNotesPullRequest,
  type NativeTestScenario,
  type NotesCommandRunner,
  type OtaComment,
} from '../lib/testflight-notes';

const receipt: TestflightBuildReceipt = {
  version: '2.7.0',
  buildNumber: '2',
  sourceSha: 'a'.repeat(40),
  previousBuildTag: 'build-ios-v2.7.0-1-123456789abc',
  previousBuildSha: 'b'.repeat(40),
  sourceRunId: '1234',
  sourceRef: 'release/next',
  buildTag: 'build-ios-v2.7.0-2-abcdef123456',
};

function pullRequest(overrides: Partial<NativeNotesPullRequest> = {}): NativeNotesPullRequest {
  return {
    number: 42,
    title: 'fix(ios): Resume the connected board',
    body: '## Release Notes\nResume your board connection\n## Test plan\n1. With a board connected, lock your phone.\n2. Unlock your phone → the board stays connected.\n## Risk\nRisk: 5/5 — native board connection',
    mergedAt: '2026-10-25T12:00:00Z',
    mergeCommitOid: 'd'.repeat(40),
    headRefOid: 'c'.repeat(40),
    headRefName: 'fix/connection',
    headOwner: 'boardsesh',
    labels: ['native-fingerprint'],
    ...overrides,
  };
}

function otaComment(verdict: string = '⚠️ Native change', overrides: Partial<OtaComment> = {}): OtaComment {
  return {
    body: `<!-- mobile-ota-check -->\n### 📱 OTA compatibility\n| Platform | Verdict | Fingerprint |\n| --- | --- | --- |\n| iOS | ${verdict} | PR \`123456789abc\` · main \`abcdef123456\` |\n| Android | ⚠️ Native change | hashes |\n\nBranch \`fix/connection\` → \`main\` · commit \`ccccccc\`.`,
    updatedAt: '2026-10-25T11:00:00Z',
    authorLogin: 'github-actions[bot]',
    authorType: 'Bot',
    ...overrides,
  };
}

function scenario(overrides: Partial<NativeTestScenario> = {}): NativeTestScenario {
  return {
    prNumber: 42,
    title: 'Resume your board connection',
    steps: ['With a board connected, lock your phone.', 'Unlock → the board stays connected.'],
    risk: 5,
    mergedAt: '2026-10-25T12:00:00Z',
    ...overrides,
  };
}

function connection(pullRequests: NativeNotesPullRequest[], hasNextPage = false, endCursor: string | null = null) {
  return JSON.stringify({
    data: {
      repository: {
        pullRequests: {
          pageInfo: { hasNextPage, endCursor },
          nodes: pullRequests.map((candidate) => ({
            ...candidate,
            headRepositoryOwner: { login: candidate.headOwner },
            mergeCommit: candidate.mergeCommitOid ? { oid: candidate.mergeCommitOid } : null,
            labels: { nodes: candidate.labels.map((name) => ({ name })), pageInfo: { hasNextPage: false } },
          })),
        },
      },
    },
  });
}

describe('native PR selection', () => {
  it('uses merge-commit reachability, deduplicates streams, and excludes plumbing and JS', () => {
    const candidate = pullRequest();
    const selected = selectNativeNotesPullRequests(
      [
        candidate,
        candidate,
        pullRequest({ number: 43, labels: [] }),
        pullRequest({ number: 44, mergeCommitOid: 'e'.repeat(40) }),
        pullRequest({ number: 45, headRefName: 'main' }),
      ],
      new Set([candidate.mergeCommitOid!]),
      'boardsesh',
    );
    expect(selected.map((entry) => entry.number)).toEqual([42]);
  });

  it('keeps an ordinary contribution from a fork main branch', () => {
    const candidate = pullRequest({ headRefName: 'main', headOwner: 'contributor' });
    expect(selectNativeNotesPullRequests([candidate], new Set([candidate.mergeCommitOid!]), 'boardsesh')).toEqual([
      candidate,
    ]);
  });

  it('fails instead of guessing reachability for a missing native merge commit', () => {
    expect(() =>
      selectNativeNotesPullRequests([pullRequest({ mergeCommitOid: null })], new Set(), 'boardsesh'),
    ).toThrow('PR #42');
  });
});

describe('iOS fingerprint evidence', () => {
  it('includes iOS-native changes but excludes Android-only changes', () => {
    expect(hasIosNativeChange(pullRequest(), [otaComment()])).toBe(true);
    expect(hasIosNativeChange(pullRequest(), [otaComment('✅ Compatible')])).toBe(false);
  });

  it.each([
    ['missing', []],
    ['human-authored', [otaComment('⚠️ Native change', { authorLogin: 'contributor', authorType: 'User' })]],
    ['stale', [otaComment('⚠️ Native change', { body: otaComment().body.replace('ccccccc', 'ddddddd') })]],
    ['unknown', [otaComment('ℹ️ Unknown')]],
  ])('rejects %s evidence', (_description, comments) => {
    expect(() => hasIosNativeChange(pullRequest(), comments as OtaComment[])).toThrow('PR #42');
  });

  it('never falls back to an older positive result when the newest bot result is unknown', () => {
    expect(() =>
      hasIosNativeChange(pullRequest(), [
        otaComment(),
        otaComment('ℹ️ Unknown', { updatedAt: '2026-10-25T12:00:00Z' }),
      ]),
    ).toThrow('unknown');
  });
});

describe('native test summaries', () => {
  it('preserves ordered prerequisites and expected results even with no release note', () => {
    const candidate = pullRequest({
      body: '## Release Notes\nnone\n## Test plan\n1. Sign in and connect a board.\n2. Lock your phone → LEDs stay lit.\n## Risk\nRisk: 4/5 — native connection',
    });
    expect(nativeTestScenario(candidate)).toMatchObject({
      title: 'Resume the connected board',
      risk: 4,
      steps: ['Sign in and connect a board.', 'Lock your phone → LEDs stay lit.'],
    });
  });

  it('drops CI placeholders and author-side commands', () => {
    expect(
      nativeTestScenario(
        pullRequest({ body: '## Test plan\n1. CI green.\n2. Run vp test.\n3. Open Boardsesh → climbs appear.' }),
      )?.steps,
    ).toEqual(['Open Boardsesh → climbs appear.']);
    expect(nativeTestScenario(pullRequest({ body: '## Test plan\n1. CI green.' }))).toBeNull();
    expect(nativeTestScenario(pullRequest({ body: null }))).toBeNull();
  });

  it('prioritizes complete higher-risk plans, deduplicates plans, and caps scenarios at five', () => {
    const scenarios = Array.from({ length: 7 }, (_, index) =>
      scenario({ prNumber: index + 1, risk: index === 0 ? 5 : 1, steps: [`Open screen ${index} → results appear.`] }),
    );
    scenarios.push(scenario({ prNumber: 90, risk: 2, steps: scenarios[0].steps }));
    const result = renderTestflightNotes(receipt, scenarios, 'boardsesh/boardsesh');
    expect(result.includedPrNumbers).toEqual([1, 7, 6, 5, 4]);
    expect(result.omittedCount).toBe(2);
    expect(result.notes).toContain('More native test plans: https://github.com/boardsesh/boardsesh/compare/');
    expect(result.notes).not.toContain('(#90)');
  });

  it('counts UTF-8 bytes and omits complete oversized scenarios', () => {
    const oversized = scenario({ steps: [`Connect a board → ${'🧗'.repeat(1100)}`] });
    const small = scenario({ prNumber: 43, risk: 2, steps: ['Open Boardsesh → climbs appear.'] });
    const result = renderTestflightNotes(receipt, [oversized, small], 'boardsesh/boardsesh');
    expect(Buffer.byteLength(result.notes, 'utf8')).toBeLessThanOrEqual(4000);
    expect(result.includedPrNumbers).toEqual([43]);
    expect(result.notes).not.toContain('🧗');
  });

  it('honestly describes builds with no supplied native checks', () => {
    const result = renderTestflightNotes(receipt, [], 'boardsesh/boardsesh');
    expect(result.notes).toContain('No new native test steps were supplied');
    expect(result.includedPrNumbers).toEqual([]);
  });
});

describe('GitHub and git reads', () => {
  it('creates separate nested output directories when invoked by the workflow', () => {
    const directory = mkdtempSync(join(tmpdir(), 'testflight-notes-'));
    try {
      const receiptPath = join(directory, 'receipt.json');
      const notesPath = join(directory, 'notes', 'what-to-test.txt');
      const plansPath = join(directory, 'archive', 'plans.json');
      writeFileSync(receiptPath, JSON.stringify({ ...receipt, previousBuildSha: receipt.sourceSha }));
      main(['--receipt', receiptPath, '--output', notesPath, '--plans-output', plansPath], () => '');
      expect(readFileSync(notesPath, 'utf8')).toContain('No new native test steps');
      expect(JSON.parse(readFileSync(plansPath, 'utf8')).receipt.sourceSha).toBe(receipt.sourceSha);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('paginates both release branches and deduplicates matching PRs', () => {
    const calls: string[][] = [];
    const runner: NotesCommandRunner = (_command, arguments_) => {
      calls.push(arguments_);
      return arguments_.includes('base=main') && !arguments_.includes('cursor=next')
        ? connection([], true, 'next')
        : connection([pullRequest()]);
    };
    expect(fetchNativeNotesPullRequests(runner, 'boardsesh/boardsesh', new Set(['d'.repeat(40)]))).toHaveLength(1);
    expect(calls).toHaveLength(3);
    expect(calls.some((arguments_) => arguments_.includes('base=release/next'))).toBe(true);
  });

  it('fails API errors and repeating pagination cursors', () => {
    expect(() =>
      fetchNativeNotesPullRequests(() => '{"errors":[{"message":"denied"}]}', 'boardsesh/boardsesh', new Set()),
    ).toThrow('Could not read merged PRs');
    expect(() =>
      fetchNativeNotesPullRequests(() => connection([], true, 'same'), 'boardsesh/boardsesh', new Set()),
    ).toThrow('Incomplete PR pagination');
    expect(() => fetchOtaComments(() => '{}', 'boardsesh/boardsesh', 42)).toThrow('PR #42');
  });

  it('uses the frozen SHA range and fetches comments only for newly included native PRs', () => {
    const calls: Array<[string, string[]]> = [];
    const runner: NotesCommandRunner = (command, arguments_) => {
      calls.push([command, arguments_]);
      if (command === 'git') return arguments_[0] === 'rev-list' ? 'd'.repeat(40) : '';
      if (arguments_.includes('graphql')) return connection([pullRequest(), pullRequest({ number: 43, labels: [] })]);
      const comment = otaComment();
      return JSON.stringify([
        [
          {
            body: comment.body,
            updated_at: comment.updatedAt,
            user: { login: comment.authorLogin, type: comment.authorType },
          },
        ],
      ]);
    };
    const result = generateTestflightNotes(receipt, runner, 'boardsesh/boardsesh');
    expect(calls).toContainEqual(['git', ['rev-list', receipt.sourceSha, '--not', receipt.previousBuildSha!]]);
    expect(calls.filter(([command, arguments_]) => command === 'gh' && arguments_.includes('--slurp'))).toHaveLength(1);
    expect(result.includedPrNumbers).toEqual([42]);
    expect(result.scenarios[0].steps[0]).toContain('With a board connected');
  });

  it('refuses missing baselines or unreadable git history', () => {
    expect(() =>
      generateTestflightNotes(
        { ...receipt, previousBuildTag: null, previousBuildSha: null },
        () => '',
        'boardsesh/boardsesh',
      ),
    ).toThrow('No previous native iOS build');
    expect(() =>
      generateTestflightNotes(
        receipt,
        () => {
          throw new Error('shallow history');
        },
        'boardsesh/boardsesh',
      ),
    ).toThrow('shallow history');
  });

  it('does not crawl GitHub for a same-commit native rebuild', () => {
    const calls: string[] = [];
    const result = generateTestflightNotes(
      { ...receipt, previousBuildSha: receipt.sourceSha },
      (command) => {
        calls.push(command);
        return '';
      },
      'boardsesh/boardsesh',
    );
    expect(calls).toEqual(['git', 'git']);
    expect(result.nativePrNumbers).toEqual([]);
    expect(result.notes).toContain('No new native test steps');
  });
});
