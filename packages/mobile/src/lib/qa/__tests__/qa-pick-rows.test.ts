import { describe, expect, it } from 'vitest';
import type { QaPreview, QaVerdict } from '@boardsesh/shared-schema';
import { buildQaPickRows, fallbackRowTitle, riskTone } from '../qa-pick-rows';
import type { QaPrBranch } from '../qa-surf';

function branch(prNumber: number, lastUpdateAt: string): QaPrBranch {
  return { prNumber, branch: `pr-${prNumber}`, lastUpdateAt };
}

function preview(prNumber: number, overrides: Partial<QaPreview> = {}): QaPreview {
  return {
    prNumber,
    branch: `pr-${prNumber}`,
    title: `Title ${prNumber}`,
    url: `https://github.com/boardsesh/boardsesh/pull/${prNumber}`,
    author: 'marco',
    isDraft: false,
    headSha: 'head-sha',
    headCommittedAt: '2026-08-25T10:00:00.000Z',
    updatedAt: '2026-08-25T10:00:00.000Z',
    risk: 3,
    riskReason: 'Touches the queue reducer',
    testPlan: null,
    testPlanSteps: [],
    myLatestVerdict: null,
    ...overrides,
  };
}

function verdict(overrides: Partial<QaVerdict> = {}): QaVerdict {
  return {
    id: 'verdict-1',
    prNumber: 1,
    branch: 'pr-1',
    verdict: 'approved',
    comment: null,
    headSha: 'head-sha',
    createdAt: '2026-08-25T12:00:00.000Z',
    githubCommentUrl: null,
    ...overrides,
  };
}

describe('buildQaPickRows', () => {
  it('joins each loadable branch with its PR metadata', () => {
    const rows = buildQaPickRows({
      branches: [branch(10, '2026-08-25T10:00:00.000Z')],
      previews: [preview(10, { title: 'Fix the relight', author: 'nic', risk: 4, isDraft: true })],
      refusedPrNumber: null,
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      prNumber: 10,
      branch: 'pr-10',
      title: 'Fix the relight',
      author: 'nic',
      risk: 4,
      isDraft: true,
      refused: false,
    });
  });

  it('keeps a branch the backend knows nothing about', () => {
    // GitHub being down must not stop a tester loading the branch: the row is
    // rendered bare rather than dropped.
    const rows = buildQaPickRows({
      branches: [branch(10, '2026-08-25T10:00:00.000Z')],
      previews: [],
      refusedPrNumber: null,
    });

    expect(rows).toHaveLength(1);
    expect(rows[0].title).toBeNull();
    expect(rows[0].author).toBeNull();
    expect(rows[0].risk).toBeNull();
  });

  it('drops a preview with no loadable branch', () => {
    // This build cannot serve it, so offering it would be a dead end.
    const rows = buildQaPickRows({ branches: [], previews: [preview(10)], refusedPrNumber: null });
    expect(rows).toEqual([]);
  });

  it('marks the branch the server refused to serve here', () => {
    const rows = buildQaPickRows({
      branches: [branch(10, '2026-08-25T10:00:00.000Z'), branch(11, '2026-08-24T10:00:00.000Z')],
      previews: [],
      refusedPrNumber: 10,
    });

    expect(rows.find((row) => row.prNumber === 10)?.refused).toBe(true);
    expect(rows.find((row) => row.prNumber === 11)?.refused).toBe(false);
  });

  it('carries this tester’s own verdict', () => {
    const rows = buildQaPickRows({
      branches: [branch(10, '2026-08-25T10:00:00.000Z')],
      previews: [preview(10, { myLatestVerdict: verdict({ verdict: 'declined' }) })],
      refusedPrNumber: null,
    });

    expect(rows[0].myVerdict).toBe('declined');
    expect(rows[0].verdictIsStale).toBe(false);
  });

  it('flags a verdict filed against an earlier head commit', () => {
    const rows = buildQaPickRows({
      branches: [branch(10, '2026-08-25T10:00:00.000Z')],
      previews: [preview(10, { headSha: 'new-sha', myLatestVerdict: verdict({ headSha: 'old-sha' }) })],
      refusedPrNumber: null,
    });

    expect(rows[0].verdictIsStale).toBe(true);
  });

  it('does not call a verdict stale when the head sha is unknown', () => {
    const rows = buildQaPickRows({
      branches: [branch(10, '2026-08-25T10:00:00.000Z')],
      previews: [preview(10, { myLatestVerdict: verdict({ headSha: null }) })],
      refusedPrNumber: null,
    });

    expect(rows[0].verdictIsStale).toBe(false);
  });
});

describe('buildQaPickRows ordering', () => {
  it('puts untested PRs ahead of ones this tester already judged', () => {
    const rows = buildQaPickRows({
      branches: [branch(10, '2026-08-26T10:00:00.000Z'), branch(11, '2026-08-20T10:00:00.000Z')],
      previews: [preview(10, { risk: 5, myLatestVerdict: verdict() }), preview(11, { risk: 1 })],
      refusedPrNumber: null,
    });

    // 11 is older AND lower-risk, but nobody has run it — that wins.
    expect(rows.map((row) => row.prNumber)).toEqual([11, 10]);
  });

  it('orders untested PRs riskiest first', () => {
    const rows = buildQaPickRows({
      branches: [branch(10, '2026-08-26T10:00:00.000Z'), branch(11, '2026-08-20T10:00:00.000Z')],
      previews: [preview(10, { risk: 2 }), preview(11, { risk: 5 })],
      refusedPrNumber: null,
    });

    expect(rows.map((row) => row.prNumber)).toEqual([11, 10]);
  });

  it('sinks a PR that never declared its risk', () => {
    // Silence is not urgency: an undeclared risk sorts below every stated one.
    const rows = buildQaPickRows({
      branches: [branch(10, '2026-08-26T10:00:00.000Z'), branch(11, '2026-08-20T10:00:00.000Z')],
      previews: [preview(10, { risk: null }), preview(11, { risk: 1 })],
      refusedPrNumber: null,
    });

    expect(rows.map((row) => row.prNumber)).toEqual([11, 10]);
  });

  it('breaks a risk tie on freshness', () => {
    const rows = buildQaPickRows({
      branches: [branch(10, '2026-08-20T10:00:00.000Z'), branch(11, '2026-08-26T10:00:00.000Z')],
      previews: [preview(10, { risk: 3 }), preview(11, { risk: 3 })],
      refusedPrNumber: null,
    });

    expect(rows.map((row) => row.prNumber)).toEqual([11, 10]);
  });

  it('does not scramble the list on an unparseable timestamp', () => {
    const rows = buildQaPickRows({
      branches: [branch(10, 'not a date'), branch(11, '2026-08-26T10:00:00.000Z')],
      previews: [],
      refusedPrNumber: null,
    });

    expect(rows.map((row) => row.prNumber)).toEqual([11, 10]);
  });
});

describe('riskTone', () => {
  it('buckets the declared 1-5 risk green through red', () => {
    expect(riskTone(1)).toBe('low');
    expect(riskTone(2)).toBe('low');
    expect(riskTone(3)).toBe('medium');
    expect(riskTone(4)).toBe('high');
    expect(riskTone(5)).toBe('high');
  });

  it('is unknown when the PR never declared one', () => {
    expect(riskTone(null)).toBe('unknown');
    expect(riskTone(Number.NaN)).toBe('unknown');
  });
});

describe('fallbackRowTitle', () => {
  it('names the branch when the PR cannot be named', () => {
    expect(fallbackRowTitle(4792)).toBe('pr-4792');
  });
});
