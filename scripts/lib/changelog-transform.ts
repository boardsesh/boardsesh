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
    if (!insideFence && ANY_HEADING.test(line)) break;
    sectionLines.push(line);
  }

  // Drop blank lines, bullet markers, and any standalone `none` (so `- none` or
  // a mix of real notes and `none` placeholders never ship a junk "none" entry).
  const cleaned = sectionLines
    .map((line) => line.replace(LIST_MARKER, '').trim())
    .filter((line) => line.length > 0 && !NONE_MARKER.test(line));

  if (cleaned.length === 0) return null;

  const [title, ...rest] = cleaned;
  const body = rest.join('\n').trim();
  return body ? { title, body } : { title };
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
