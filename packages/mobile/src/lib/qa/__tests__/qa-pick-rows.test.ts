import { describe, expect, it } from 'vitest';
import type { QaPreview, QaVerdict } from '@boardsesh/shared-schema';
import {
  MAX_LABEL_CHIPS,
  buildQaPickRows,
  fallbackRowTitle,
  filterQaPickRows,
  labelChipColor,
  parsePrQuery,
  qaPickListState,
  riskTone,
  visibleLabels,
  type QaPickRow,
} from '../qa-pick-rows';
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
    labels: [],
    otaBuild: 'ready',
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

describe('rows for a preview that is still building', () => {
  it('adds an unloadable row for a building PR with no branch yet', () => {
    // The whole point: the branch list is empty because nothing is published,
    // so without this the tester who just pushed sees nothing at all.
    const rows = buildQaPickRows({
      branches: [],
      previews: [preview(4792, { otaBuild: 'building' })],
      refusedPrNumber: null,
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      prNumber: 4792,
      branch: 'pr-4792',
      loadable: false,
      otaBuild: 'building',
      lastUpdateAt: null,
      title: 'Title 4792',
    });
  });

  it('keeps a published branch loadable while a newer bundle builds', () => {
    const rows = buildQaPickRows({
      branches: [branch(4792, '2026-08-25T09:00:00.000Z')],
      previews: [preview(4792, { otaBuild: 'building' })],
      refusedPrNumber: null,
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]?.loadable).toBe(true);
    expect(rows[0]?.otaBuild).toBe('building');
    expect(rows[0]?.lastUpdateAt).toBe('2026-08-25T09:00:00.000Z');
  });

  it('never emits two rows for one PR', () => {
    const rows = buildQaPickRows({
      branches: [branch(4792, '2026-08-25T09:00:00.000Z')],
      previews: [preview(4792, { otaBuild: 'building' })],
      refusedPrNumber: null,
    });
    expect(rows.map((row) => row.branch)).toEqual(['pr-4792']);
  });

  it('drops a branch-less preview that is not building', () => {
    // A ready, failed or torn-down preview with no branch cannot be loaded on
    // this build, so a row for it would be a dead end.
    for (const otaBuild of ['ready', 'failed', 'unavailable', 'unknown'] as const) {
      const rows = buildQaPickRows({
        branches: [],
        previews: [preview(4792, { otaBuild })],
        refusedPrNumber: null,
      });
      expect(rows).toHaveLength(0);
    }
  });

  it('sorts a building row by the PR update time, not to the bottom', () => {
    const rows = buildQaPickRows({
      branches: [branch(1, '2026-08-20T10:00:00.000Z')],
      previews: [
        preview(1, { risk: 3, updatedAt: '2026-08-20T10:00:00.000Z' }),
        preview(2, { risk: 3, otaBuild: 'building', updatedAt: '2026-08-26T10:00:00.000Z' }),
      ],
      refusedPrNumber: null,
    });
    // Same risk, neither tested — the fresher one leads, and the building row
    // has only its PR update time to be judged on.
    expect(rows.map((row) => row.prNumber)).toEqual([2, 1]);
  });

  it('carries the PR labels onto both kinds of row', () => {
    const labels = [{ name: 'backend', color: '006b75' }];
    const rows = buildQaPickRows({
      branches: [branch(1, '2026-08-25T09:00:00.000Z')],
      previews: [preview(1, { labels }), preview(2, { otaBuild: 'building', labels })],
      refusedPrNumber: null,
    });
    expect(rows.every((row) => row.labels[0]?.name === 'backend')).toBe(true);
  });
});

describe('visibleLabels', () => {
  it('puts backend first because it changes what a tester can conclude', () => {
    const shown = visibleLabels([
      { name: 'enhancement', color: 'a2eeef' },
      { name: 'backend', color: '006b75' },
    ]);
    expect(shown.map((label) => label.name)).toEqual(['backend', 'enhancement']);
  });

  it('drops the QA verdict labels, which the row already renders', () => {
    const shown = visibleLabels([
      { name: 'qa-approved', color: '0e8a16' },
      { name: 'qa-declined', color: 'd73a4a' },
      { name: 'bug', color: 'd73a4a' },
    ]);
    expect(shown.map((label) => label.name)).toEqual(['bug']);
  });

  it('caps how many chips a row can grow', () => {
    const many = Array.from({ length: 12 }, (_, index) => ({ name: `label-${index}`, color: 'ededed' }));
    expect(visibleLabels(many)).toHaveLength(MAX_LABEL_CHIPS);
  });
});

describe('labelChipColor', () => {
  it('uses the label colour when it reads against the surface', () => {
    expect(labelChipColor('006b75', 'light')).toBe('#006b75');
    expect(labelChipColor('D73A4A', 'light')).toBe('#d73a4a');
    expect(labelChipColor('d73a4a', 'dark')).toBe('#d73a4a');
  });

  it('defers to the theme for a colour that would vanish on a light surface', () => {
    expect(labelChipColor('ffffff', 'light')).toBeNull();
    expect(labelChipColor('fef2c0', 'light')).toBeNull();
  });

  it('keeps a pale colour in dark mode, where it reads fine', () => {
    // GitHub's default `enhancement` is a2eeef — washed out on white, perfect
    // on a dark surface. Judging both themes by the light threshold threw the
    // colour away from most default labels for no reason.
    expect(labelChipColor('a2eeef', 'light')).toBeNull();
    expect(labelChipColor('a2eeef', 'dark')).toBe('#a2eeef');
    expect(labelChipColor('ffffff', 'dark')).toBe('#ffffff');
  });

  it('defers to the theme for a colour that would vanish on a dark surface', () => {
    expect(labelChipColor('000000', 'dark')).toBeNull();
    expect(labelChipColor('101010', 'dark')).toBeNull();
    expect(labelChipColor('000000', 'light')).toBe('#000000');
  });

  it('pins the thresholds, so an off-by-one is not silent', () => {
    // Greys, so luma is just the byte value: 0xC7=199, 0xC8=200, 0xC9=201 and
    // 0x3B=59, 0x3C=60, 0x3D=61. The comparisons are `> 200` and `< 60`, so 200
    // and 60 themselves are kept.
    expect(labelChipColor('c7c7c7', 'light')).toBe('#c7c7c7');
    expect(labelChipColor('c8c8c8', 'light')).toBe('#c8c8c8');
    expect(labelChipColor('c9c9c9', 'light')).toBeNull();

    expect(labelChipColor('3b3b3b', 'dark')).toBeNull();
    expect(labelChipColor('3c3c3c', 'dark')).toBe('#3c3c3c');
    expect(labelChipColor('3d3d3d', 'dark')).toBe('#3d3d3d');
  });

  it('defers to the theme for anything that is not six hex digits', () => {
    for (const scheme of ['light', 'dark'] as const) {
      expect(labelChipColor('#006b75', scheme)).toBeNull();
      expect(labelChipColor('', scheme)).toBeNull();
      expect(labelChipColor('nothex', scheme)).toBeNull();
    }
  });
});

function row(prNumber: number, title: string | null): QaPickRow {
  return {
    prNumber,
    branch: `pr-${prNumber}`,
    lastUpdateAt: '2026-08-25T10:00:00.000Z',
    updatedAt: '2026-08-25T10:00:00.000Z',
    title,
    author: 'marco',
    url: null,
    isDraft: false,
    risk: null,
    myVerdict: null,
    verdictIsStale: false,
    refused: false,
    loadable: true,
    otaBuild: 'ready',
    labels: [],
  };
}

const prNumbersOf = (rows: QaPickRow[]) => rows.map((entry) => entry.prNumber);

describe('parsePrQuery', () => {
  it('accepts every spelling a tester types for a PR number', () => {
    expect(parsePrQuery('5203')).toBe(5203);
    expect(parsePrQuery('#5203')).toBe(5203);
    expect(parsePrQuery('pr-5203')).toBe(5203);
    expect(parsePrQuery('PR 5203')).toBe(5203);
    expect(parsePrQuery('pr5203')).toBe(5203);
    expect(parsePrQuery('  #5203  ')).toBe(5203);
  });

  // Unlike `parsePrBranch`, which rejects `pr-05203` because our workflow never
  // publishes that name. This parses human input, and the branch name is
  // regenerated from the number.
  it('accepts a leading zero that the branch-name parser rejects', () => {
    expect(parsePrQuery('05203')).toBe(5203);
  });

  it('rejects anything that does not name exactly one PR', () => {
    expect(parsePrQuery('queue reducer')).toBeNull();
    expect(parsePrQuery('5203 queue')).toBeNull();
    expect(parsePrQuery('pr-')).toBeNull();
    expect(parsePrQuery('')).toBeNull();
    expect(parsePrQuery('0')).toBeNull();
    expect(parsePrQuery('999999999999999999999')).toBeNull();
  });
});

describe('filterQaPickRows', () => {
  const rows = [row(5203, 'Fix the queue reducer'), row(4792, 'Add a café filter'), row(1523, null)];

  it('returns the same array when nothing is typed', () => {
    // Identity, not equality: the screen hands this straight to a virtualized
    // list, and a fresh array every render would defeat its bail-out.
    expect(filterQaPickRows(rows, '')).toBe(rows);
    expect(filterQaPickRows(rows, '   ')).toBe(rows);
  });

  it('matches a title substring regardless of case', () => {
    expect(prNumbersOf(filterQaPickRows(rows, 'QUEUE'))).toEqual([5203]);
  });

  it('matches across diacritics', () => {
    expect(prNumbersOf(filterQaPickRows(rows, 'cafe'))).toEqual([4792]);
  });

  it('requires every typed word, in any order', () => {
    expect(prNumbersOf(filterQaPickRows(rows, 'fix queue'))).toEqual([5203]);
    expect(prNumbersOf(filterQaPickRows(rows, 'queue fix'))).toEqual([5203]);
    expect(prNumbersOf(filterQaPickRows(rows, 'fix filter'))).toEqual([]);
  });

  // The list has to be able to narrow all the way to nothing, because reaching
  // zero matches is what offers the escape hatch.
  it('matches a PR number by prefix, never by its tail', () => {
    expect(prNumbersOf(filterQaPickRows(rows, '5'))).toEqual([5203]);
    expect(prNumbersOf(filterQaPickRows(rows, '520'))).toEqual([5203]);
    expect(prNumbersOf(filterQaPickRows(rows, '5203'))).toEqual([5203]);
    expect(prNumbersOf(filterQaPickRows(rows, '203'))).toEqual([]);
  });

  it('finds every spelling of a number', () => {
    expect(prNumbersOf(filterQaPickRows(rows, '#4792'))).toEqual([4792]);
    expect(prNumbersOf(filterQaPickRows(rows, 'pr-4792'))).toEqual([4792]);
  });

  // Testing is never blocked on metadata, and neither is finding the row.
  it('finds a row the backend could not name, by number or branch', () => {
    expect(prNumbersOf(filterQaPickRows(rows, '1523'))).toEqual([1523]);
    expect(prNumbersOf(filterQaPickRows(rows, 'pr-1523'))).toEqual([1523]);
  });
});

describe('qaPickListState', () => {
  const base = { isPending: false, isError: false, surfingOff: false, hasQuery: false };
  const rows = [row(5203, 'Fix the queue reducer')];

  it('reports the channel serving no previews ahead of everything else', () => {
    expect(qaPickListState({ ...base, isPending: true, surfingOff: true, rows: [], visibleRows: [] }).kind).toBe(
      'surfing-off',
    );
  });

  it('reports loading, then an unreachable server', () => {
    expect(qaPickListState({ ...base, isPending: true, rows: [], visibleRows: [] }).kind).toBe('loading');
    expect(qaPickListState({ ...base, isError: true, rows: [], visibleRows: [] }).kind).toBe('unreachable');
  });

  it('separates "nothing published" from "nothing matches what you typed"', () => {
    expect(qaPickListState({ ...base, rows: [], visibleRows: [] }).kind).toBe('empty');
    expect(qaPickListState({ ...base, hasQuery: true, rows, visibleRows: [] }).kind).toBe('no-match');
  });

  // An empty list is the signature of a fingerprint drift — exactly when someone
  // hands a tester a PR number — so the escape hatch has to win here.
  it('prefers no-match over empty when a query is typed and nothing is published', () => {
    expect(qaPickListState({ ...base, hasQuery: true, rows: [], visibleRows: [] }).kind).toBe('no-match');
  });

  it('hands back the filtered rows, not the unfiltered ones', () => {
    const state = qaPickListState({ ...base, hasQuery: true, rows: [...rows, row(1, 'Other')], visibleRows: rows });
    expect(state).toEqual({ kind: 'rows', rows });
  });
});
