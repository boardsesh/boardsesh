import { describe, it, expect } from 'vitest';
import {
  extractReleaseNotes,
  isNoReleaseNoteBoxChecked,
  categorize,
  buildEntries,
  isContentEqual,
  renderChangelogMarkdown,
  type RawPullRequest,
  type ChangelogData,
  type ChangelogEntry,
} from '../lib/changelog-transform';

describe('extractReleaseNotes', () => {
  it('returns the first line as title and the rest as body', () => {
    const body = [
      '## Summary',
      'Internal refactor blah blah.',
      '',
      '## Release Notes',
      'Resume sessions where you left off',
      'Reopen mid-climb and your queue is still there.',
      '',
      '## Test plan',
      'Ran it.',
    ].join('\n');
    expect(extractReleaseNotes(body)).toEqual({
      title: 'Resume sessions where you left off',
      body: 'Reopen mid-climb and your queue is still there.',
    });
  });

  it('returns title only when the section is a single line', () => {
    expect(extractReleaseNotes('## Release Notes\nQueue sync is faster')).toEqual({
      title: 'Queue sync is faster',
    });
  });

  it('strips HTML comments and bullet markers', () => {
    const body = [
      '## Release Notes',
      '<!-- describe what the user gets, not what the feature does -->',
      '- Faster board lighting',
      '* Fewer dropped frames',
      '1. Snappier search',
    ].join('\n');
    expect(extractReleaseNotes(body)).toEqual({
      title: 'Faster board lighting',
      body: 'Fewer dropped frames\nSnappier search',
    });
  });

  it('accepts ### and is case-insensitive on the heading', () => {
    expect(extractReleaseNotes('### release notes\nNew thing')).toEqual({ title: 'New thing' });
  });

  it('returns null when the heading is missing', () => {
    expect(extractReleaseNotes('## Summary\nNo release notes here.')).toBeNull();
  });

  it('returns null for an empty section (only a comment)', () => {
    expect(extractReleaseNotes('## Release Notes\n<!-- nothing here -->\n\n## Test plan\nx')).toBeNull();
  });

  it('returns null when the content is exactly "none" (case-insensitive)', () => {
    expect(extractReleaseNotes('## Release Notes\nNone')).toBeNull();
    expect(extractReleaseNotes('## Release Notes\n- none')).toBeNull();
    // Multiple `none` placeholders must not slip through as a junk entry.
    expect(extractReleaseNotes('## Release Notes\n- none\n- none')).toBeNull();
    // A `none` marker with a parenthetical/punctuated explanation is still skip.
    expect(extractReleaseNotes('## Release Notes\n- none (CI / release-plumbing only)')).toBeNull();
    expect(extractReleaseNotes('## Release Notes\nNone — internal refactor')).toBeNull();
    expect(extractReleaseNotes('## Release Notes\nnone.')).toBeNull();
    // But a real sentence starting with the word "none" is kept.
    expect(extractReleaseNotes('## Release Notes\nNone of the old buttons jump anymore')).toEqual({
      title: 'None of the old buttons jump anymore',
    });
  });

  it('drops "none" lines mixed with real notes', () => {
    const body = '## Release Notes\n- none\n- Queue sync is faster';
    expect(extractReleaseNotes(body)).toEqual({ title: 'Queue sync is faster' });
  });

  it('does not treat a heading inside a fenced code block as the section end', () => {
    const body = '## Release Notes\nFixed the export\n```\n# not a heading\n```\n## Test plan\nx';
    expect(extractReleaseNotes(body)?.title).toBe('Fixed the export');
  });

  it('returns null for empty/missing bodies', () => {
    expect(extractReleaseNotes('')).toBeNull();
    expect(extractReleaseNotes(null)).toBeNull();
    expect(extractReleaseNotes(undefined)).toBeNull();
  });

  it('strips the "No release note needed" checkbox line (checked or not)', () => {
    // Checked box, nothing else → no entry.
    expect(
      extractReleaseNotes('## Release Notes\n- [x] No release note needed (internal / technical change)'),
    ).toBeNull();
    // Unchecked box left in the template, but real notes written → notes win.
    expect(
      extractReleaseNotes(
        '## Release Notes\n- [ ] No release note needed (internal / technical change)\n- Resume where you left off',
      ),
    ).toEqual({ title: 'Resume where you left off' });
  });
  it('stops the section at the next heading of any level', () => {
    const body = '## Release Notes\nThe note\n# Another top heading\nNot included';
    expect(extractReleaseNotes(body)).toEqual({ title: 'The note' });
  });

  it('stops the section at the PR footer / horizontal rule (no heading to bound it)', () => {
    // The auto-generated footer right after the notes must not leak in.
    const footered =
      '## Release Notes\n- none\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)\nhttps://claude.ai/code/session_x';
    expect(extractReleaseNotes(footered)).toBeNull();
    // A real note is kept, but the trailing footer is excluded.
    const withNote = '## Release Notes\nQueue sync is faster\n\n---\n🤖 Generated with [Claude Code](x)';
    expect(extractReleaseNotes(withNote)).toEqual({ title: 'Queue sync is faster' });
  });
});

describe('isNoReleaseNoteBoxChecked', () => {
  it('is true only when the checkbox is ticked', () => {
    expect(
      isNoReleaseNoteBoxChecked('## Release Notes\n- [x] No release note needed (internal / technical change)'),
    ).toBe(true);
    expect(isNoReleaseNoteBoxChecked('- [X] No release note needed')).toBe(true);
    expect(
      isNoReleaseNoteBoxChecked('## Release Notes\n- [ ] No release note needed (internal / technical change)'),
    ).toBe(false);
    expect(isNoReleaseNoteBoxChecked('## Release Notes\n- A real user-facing change')).toBe(false);
    expect(isNoReleaseNoteBoxChecked('')).toBe(false);
    expect(isNoReleaseNoteBoxChecked(null)).toBe(false);
  });
});

describe('categorize', () => {
  it('maps feat→new, fix→fixed, perf/refactor→improved', () => {
    expect(categorize('feat(mobile): add changelog screen')).toBe('new');
    expect(categorize('fix(queue): stop the drift')).toBe('fixed');
    expect(categorize('perf(web): trim the bundle')).toBe('improved');
    expect(categorize('refactor: tidy the reducer')).toBe('improved');
  });

  it('defaults to improved for other types and non-conventional titles', () => {
    expect(categorize('chore(deps): bump expo')).toBe('improved');
    expect(categorize('docs: update readme')).toBe('improved');
    expect(categorize('Just a plain title')).toBe('improved');
  });
});

describe('buildEntries', () => {
  const base: RawPullRequest = {
    number: 1,
    title: 'feat(mobile): something',
    body: '## Release Notes\nA new thing',
    mergedAt: '2026-06-10T10:00:00Z',
    url: 'https://github.com/boardsesh/boardsesh/pull/1',
    labels: [],
  };

  it('keeps PRs with release notes and maps them to entries', () => {
    const [entry] = buildEntries([base]);
    expect(entry).toEqual({
      prNumber: 1,
      category: 'new',
      title: 'A new thing',
      mergedAt: '2026-06-10T10:00:00Z',
      prUrl: 'https://github.com/boardsesh/boardsesh/pull/1',
    });
  });

  it('drops PRs without a release notes section', () => {
    expect(buildEntries([{ ...base, body: '## Summary\nno notes' }])).toEqual([]);
  });

  it('drops PRs carrying the skip-changelog label', () => {
    expect(buildEntries([{ ...base, labels: ['skip-changelog'] }])).toEqual([]);
  });

  it('drops PRs that are not merged (no mergedAt)', () => {
    expect(buildEntries([{ ...base, mergedAt: null }])).toEqual([]);
  });

  it('dedupes by prNumber (first occurrence wins)', () => {
    const dupe = { ...base, title: 'fix(mobile): later', body: '## Release Notes\nlater copy' };
    const result = buildEntries([base, dupe]);
    expect(result).toHaveLength(1);
    expect(result[0].title).toBe('A new thing');
  });

  it('sorts newest-first by mergedAt', () => {
    const older: RawPullRequest = {
      ...base,
      number: 2,
      mergedAt: '2026-06-05T10:00:00Z',
      body: '## Release Notes\nOlder',
    };
    const newer: RawPullRequest = {
      ...base,
      number: 3,
      mergedAt: '2026-06-12T10:00:00Z',
      body: '## Release Notes\nNewer',
    };
    expect(buildEntries([older, newer]).map((entry) => entry.prNumber)).toEqual([3, 2]);
  });
});

describe('isContentEqual', () => {
  const entries = [
    {
      prNumber: 1,
      category: 'new' as const,
      title: 'A',
      mergedAt: '2026-06-10T10:00:00Z',
      prUrl: 'u',
    },
  ];

  it('is true when only generatedAt differs', () => {
    const first: ChangelogData = { generatedAt: '2026-06-10T00:00:00Z', entries };
    const second: ChangelogData = { generatedAt: '2026-06-19T00:00:00Z', entries };
    expect(isContentEqual(first, second)).toBe(true);
  });

  it('is false when entries differ', () => {
    const first: ChangelogData = { generatedAt: 'x', entries };
    const second: ChangelogData = { generatedAt: 'x', entries: [] };
    expect(isContentEqual(first, second)).toBe(false);
  });
});

describe('renderChangelogMarkdown', () => {
  const entry = (over: Partial<ChangelogEntry> & { prNumber: number }): ChangelogEntry => ({
    category: 'new',
    title: `Title ${over.prNumber}`,
    mergedAt: '2026-06-19T12:00:00Z',
    prUrl: `https://github.com/boardsesh/boardsesh/pull/${over.prNumber}`,
    ...over,
  });

  it('returns the preamble only when there are no entries', () => {
    const md = renderChangelogMarkdown([]);
    expect(md.startsWith('# Changelog')).toBe(true);
    expect(md).not.toContain('## 20'); // no dated section
  });

  it('groups by date then New/Improved/Fixed, newest date first, with PR links', () => {
    const md = renderChangelogMarkdown([
      entry({ prNumber: 10, category: 'new', title: 'Newer day feature', mergedAt: '2026-06-19T10:00:00Z' }),
      entry({ prNumber: 9, category: 'fixed', title: 'Older day fix', mergedAt: '2026-06-12T10:00:00Z' }),
      entry({ prNumber: 8, category: 'improved', title: 'Older day tweak', mergedAt: '2026-06-12T09:00:00Z' }),
    ]);
    // Newest date section comes first.
    expect(md.indexOf('## 2026-06-19')).toBeLessThan(md.indexOf('## 2026-06-12'));
    // Category subsections + PR-linked bullet.
    expect(md).toContain('### New\n\n- Newer day feature ([#10](https://github.com/boardsesh/boardsesh/pull/10))');
    // Fixed order: Improved before Fixed within the 2026-06-12 section.
    const day = md.slice(md.indexOf('## 2026-06-12'));
    expect(day.indexOf('### Improved')).toBeLessThan(day.indexOf('### Fixed'));
  });

  it('omits empty category subsections', () => {
    const md = renderChangelogMarkdown([entry({ prNumber: 1, category: 'fixed', title: 'Only a fix' })]);
    expect(md).toContain('### Fixed');
    expect(md).not.toContain('### New');
    expect(md).not.toContain('### Improved');
  });

  it('renders an optional body as an indented continuation line', () => {
    const md = renderChangelogMarkdown([entry({ prNumber: 2, title: 'Has body', body: 'More detail here.' })]);
    expect(md).toContain('- Has body ([#2](https://github.com/boardsesh/boardsesh/pull/2))\n  More detail here.');
  });

  it('is deterministic (same entries → byte-identical output)', () => {
    const entries = [entry({ prNumber: 3 }), entry({ prNumber: 4, category: 'fixed' })];
    expect(renderChangelogMarkdown(entries)).toBe(renderChangelogMarkdown(entries));
  });
});
