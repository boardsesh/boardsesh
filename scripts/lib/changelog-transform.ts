/// <reference types="node" />

/**
 * Pure transforms for the mobile "What's New" changelog. Each entry is one merged
 * PR that carries a non-empty `## Release Notes` section in its description; the
 * category is derived from the PR title's Conventional-Commit type.
 *
 * Kept free of I/O so it's unit-testable without hitting GitHub (see
 * scripts/__tests__/changelog-transform.test.ts). The I/O shell that paginates
 * `gh api graphql` and writes the JSON lives in scripts/generate-changelog.ts.
 */

import { parseConventional } from './commit-message-transform';

export type ChangelogCategory = 'new' | 'improved' | 'fixed';

export type ChangelogEntry = {
  prNumber: number;
  category: ChangelogCategory;
  title: string;
  /** Optional supporting copy; omitted when the Release Notes is a single line. */
  body?: string;
  /** PR merge time, ISO 8601. */
  mergedAt: string;
  prUrl: string;
};

export type ChangelogData = {
  /** ISO 8601; only moves when `entries` changes (idempotent). */
  generatedAt: string;
  entries: ChangelogEntry[];
};

/** A merged pull request as selected from the GitHub GraphQL API. */
export type RawPullRequest = {
  number: number;
  title: string;
  body: string | null;
  mergedAt: string | null;
  url: string;
  labels: string[];
};

// The label that opts a PR out of the changelog entirely (internal-only work).
export const SKIP_LABEL = 'skip-changelog';

// The heading that marks the user-facing copy in a PR body. Case-insensitive,
// `##` or `###`, optional trailing whitespace.
const RELEASE_NOTES_HEADING = /^#{2,3}\s+release notes\s*$/i;
// Any markdown ATX heading — bounds the Release Notes section.
const ANY_HEADING = /^#{1,6}\s+/;
// HTML comments (the authoring guide in the PR template) — stripped before parse.
const HTML_COMMENT = /<!--[\s\S]*?-->/g;
// Leading list markers (`- `, `* `, `+ `, `1. `) so a bulleted note reads cleanly.
const LIST_MARKER = /^(?:[-*+]|\d+\.)\s+/;
// A fenced-code-block delimiter. Tracked so a `#` line *inside* a fence doesn't
// get mistaken for the section's end heading.
const CODE_FENCE = /^\s*```/;
// A "none" marker — the convention for "no user-facing change" — optionally with
// a parenthetical/punctuated explanation (e.g. `none (CI only)`, `none — chore`).
// Dropped so it never becomes a changelog entry. A real sentence like
// "none of the old buttons…" doesn't match (a letter follows `none`), so it's kept.
const NONE_MARKER = /^none\s*(?:[([{:.\-–—].*)?$/i;
// The PR-template "No release note needed" checkbox (a flag for internal/technical
// changes). Matched on the raw line (before list-marker stripping). The first form
// matches it checked OR unchecked — those lines are never changelog content. The
// second matches only the CHECKED box — an explicit "skip, on purpose" the gate
// honors (vs an empty section, which is a forgotten note and still fails).
const NO_RELEASE_NOTE_BOX = /^\s*[-*]\s*\[[ xX]\]\s*no release note/i;
const NO_RELEASE_NOTE_BOX_CHECKED = /^[ \t]*[-*][ \t]*\[[xX]\][ \t]*no release note/im;
// Also ends the section (besides the next heading): a markdown horizontal rule, or
// the auto-generated PR footer (the "🤖 Generated with…" line). Stops a footer that
// sits right after the notes — with no heading to bound it — from leaking in.
const SECTION_BREAK = /^\s*(?:(?:-{3,}|\*{3,}|_{3,})\s*$|🤖)/;

export type ReleaseNotes = { title: string; body?: string };

/**
 * Extracts the `## Release Notes` section from a PR body: everything between that
 * heading and the next markdown heading (or EOF), ignoring headings inside fenced
 * code blocks. HTML comments and bullet markers are stripped, and standalone
 * `none` lines (case-insensitive) are dropped. Returns null when nothing is left —
 * those PRs (absent / empty / `none`) produce no changelog entry.
 */
export function extractReleaseNotes(prBody: string | null | undefined): ReleaseNotes | null {
  if (!prBody) return null;

  // Strip HTML comments first so a commented-out heading inside the guide can't
  // be mistaken for the section boundary, and the guide text never leaks in.
  const withoutComments = prBody.replace(HTML_COMMENT, '');
  const lines = withoutComments.split(/\r?\n/);

  const headingIndex = lines.findIndex((line) => RELEASE_NOTES_HEADING.test(line));
  if (headingIndex === -1) return null;

  const sectionLines: string[] = [];
  let insideFence = false;
  for (let index = headingIndex + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (CODE_FENCE.test(line)) {
      insideFence = !insideFence;
      sectionLines.push(line);
      continue;
    }
    if (!insideFence && (ANY_HEADING.test(line) || SECTION_BREAK.test(line))) break;
    sectionLines.push(line);
  }

  // Drop the "No release note needed" checkbox line (checked or not — it's a flag,
  // never content), then blank lines, bullet markers, and any standalone `none`, so
  // none of them ship as a junk entry.
  const cleaned = sectionLines
    .filter((line) => !NO_RELEASE_NOTE_BOX.test(line))
    .map((line) => line.replace(LIST_MARKER, '').trim())
    .filter((line) => line.length > 0 && !NONE_MARKER.test(line));

  if (cleaned.length === 0) return null;

  const [title, ...rest] = cleaned;
  const body = rest.join('\n').trim();
  return body ? { title, body } : { title };
}

/**
 * True when the PR ticks the template's "No release note needed" checkbox — an
 * explicit, on-purpose skip (internal/technical change). The release-notes gate
 * honors it as a pass; it never produces a changelog entry (the box line is
 * stripped in `extractReleaseNotes`). Distinct from an empty/missing section,
 * which is a forgotten note and still fails the gate.
 */
export function isNoReleaseNoteBoxChecked(prBody: string | null | undefined): boolean {
  if (!prBody) return false;
  return NO_RELEASE_NOTE_BOX_CHECKED.test(prBody);
}

/**
 * Maps a PR title's Conventional-Commit type to a changelog category:
 * feat→new, fix→fixed, perf/refactor→improved. Anything else (including a
 * non-conventional title) defaults to `improved`.
 */
export function categorize(prTitle: string): ChangelogCategory {
  const parsed = parseConventional(prTitle);
  switch (parsed?.type) {
    case 'feat':
      return 'new';
    case 'fix':
      return 'fixed';
    case 'perf':
    case 'refactor':
      return 'improved';
    default:
      return 'improved';
  }
}

/**
 * Builds the changelog entries from merged PRs: keeps PRs that have a non-empty
 * Release Notes section and don't carry the skip label, maps them to entries,
 * dedupes by PR number (first occurrence wins), and sorts newest-first by
 * mergedAt.
 */
export function buildEntries(pullRequests: RawPullRequest[]): ChangelogEntry[] {
  const byNumber = new Map<number, ChangelogEntry>();

  for (const pullRequest of pullRequests) {
    if (byNumber.has(pullRequest.number)) continue;
    if (pullRequest.labels.includes(SKIP_LABEL)) continue;
    if (!pullRequest.mergedAt) continue;

    const notes = extractReleaseNotes(pullRequest.body);
    if (!notes) continue;

    const entry: ChangelogEntry = {
      prNumber: pullRequest.number,
      category: categorize(pullRequest.title),
      title: notes.title,
      mergedAt: pullRequest.mergedAt,
      prUrl: pullRequest.url,
    };
    if (notes.body) entry.body = notes.body;
    byNumber.set(pullRequest.number, entry);
  }

  return [...byNumber.values()].sort(
    (first, second) => new Date(second.mergedAt).getTime() - new Date(first.mergedAt).getTime(),
  );
}

/**
 * Compares two changelog payloads ignoring `generatedAt`, so a re-run that
 * produces the same entries leaves the committed file (and its timestamp)
 * untouched. Mirrors the churn-free idempotency in fetch-acknowledgements.ts.
 */
export function isContentEqual(first: ChangelogData, second: ChangelogData): boolean {
  return JSON.stringify(first.entries) === JSON.stringify(second.entries);
}

// Human-readable labels + fixed render order for the markdown category
// subsections. Empty groups are skipped.
const CATEGORY_LABELS: ReadonlyArray<readonly [ChangelogCategory, string]> = [
  ['new', 'New'],
  ['improved', 'Improved'],
  ['fixed', 'Fixed'],
];

const CHANGELOG_PREAMBLE = `# Changelog

User-facing changes to Boardsesh, newest first. Auto-generated from the "Release
Notes" section of merged pull requests — do not edit by hand (a CI check rejects
manual changes). See docs/mobile-ota-updates.md.
`;

/**
 * Renders the changelog entries as a human-readable, Keep a Changelog-style
 * CHANGELOG.md: `## <YYYY-MM-DD>` sections newest-first, each with `### New /
 * Improved / Fixed` subsections of PR-linked bullets. A pure function of the
 * entries with no timestamps, so the same entries always produce a byte-identical
 * file. `entries` is expected newest-first (as `buildEntries` returns).
 */
export function renderChangelogMarkdown(entries: ChangelogEntry[]): string {
  if (entries.length === 0) return CHANGELOG_PREAMBLE;

  // Group by UTC date, keeping the newest-first order in which each date first
  // appears (entries are already sorted newest-first by mergedAt).
  const dateOrder: string[] = [];
  const byDate = new Map<string, ChangelogEntry[]>();
  for (const entry of entries) {
    const date = entry.mergedAt.slice(0, 10); // ISO 8601 → YYYY-MM-DD (UTC)
    let group = byDate.get(date);
    if (!group) {
      group = [];
      byDate.set(date, group);
      dateOrder.push(date);
    }
    group.push(entry);
  }

  const sections = dateOrder.map((date) => {
    const dayEntries = byDate.get(date) ?? [];
    const blocks = CATEGORY_LABELS.flatMap(([category, label]) => {
      const inCategory = dayEntries.filter((entry) => entry.category === category);
      if (inCategory.length === 0) return [];
      const bullets = inCategory.map((entry) => {
        const line = `- ${entry.title} ([#${entry.prNumber}](${entry.prUrl}))`;
        return entry.body ? `${line}\n  ${entry.body.replace(/\n/g, '\n  ')}` : line;
      });
      return [`### ${label}\n\n${bullets.join('\n')}`];
    });
    return `## ${date}\n\n${blocks.join('\n\n')}`;
  });

  return `${CHANGELOG_PREAMBLE}\n${sections.join('\n\n')}\n`;
}
