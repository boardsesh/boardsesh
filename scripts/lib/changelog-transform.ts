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

export type NativePlatform = 'ios' | 'android';

/**
 * A native (store) release marker: a commit where a new native fingerprint
 * shipped to the App Store / Play Store. Built from the
 * `fingerprint-<platform>-<hash>` git tags the native build workflows push after a
 * successful store upload. Woven into the changelog timeline so a user can see the
 * boundary between changes they already have over the air and ones that needed a
 * store update.
 */
export type NativeRelease = {
  kind: 'native-release';
  /** ISO 8601 committer date of the shipping commit. */
  date: string;
  /** The shipping commit SHA (markers are deduped by it). */
  sha: string;
  /** Platforms whose native build shipped at this commit (sorted, stable). */
  platforms: NativePlatform[];
  /** Per-platform fingerprint hash (for an optional runtime-aware "you're behind" highlight). */
  fingerprints: { ios?: string; android?: string };
};

/** One `fingerprint-<platform>-<hash>` git tag, resolved to its commit by the I/O shell. */
export type RawFingerprintTag = {
  platform: NativePlatform;
  hash: string;
  sha: string;
  /** ISO 8601 committer date of `sha`. */
  date: string;
};

export type ChangelogData = {
  /** ISO 8601; only moves when `entries` or `nativeReleases` changes (idempotent). */
  generatedAt: string;
  entries: ChangelogEntry[];
  nativeReleases: NativeRelease[];
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
 * Builds native-release markers from the `fingerprint-<platform>-<hash>` tags:
 * groups tags by their shipping commit (so an iOS + Android build on the same push
 * collapse to one marker carrying both platforms), records the per-platform
 * fingerprint, and sorts newest-first by commit date. A second key (sha) keeps the
 * order stable when two commits share a date. First hash wins per platform — a
 * commit resolves to exactly one fingerprint per platform.
 */
export function buildNativeReleases(tags: RawFingerprintTag[]): NativeRelease[] {
  const bySha = new Map<string, NativeRelease>();

  for (const tag of tags) {
    let release = bySha.get(tag.sha);
    if (!release) {
      release = { kind: 'native-release', date: tag.date, sha: tag.sha, platforms: [], fingerprints: {} };
      bySha.set(tag.sha, release);
    }
    if (!release.platforms.includes(tag.platform)) release.platforms.push(tag.platform);
    if (release.fingerprints[tag.platform] === undefined) release.fingerprints[tag.platform] = tag.hash;
  }

  for (const release of bySha.values()) release.platforms.sort();

  return [...bySha.values()].sort((first, second) => {
    if (first.date !== second.date) return first.date < second.date ? 1 : -1;
    return first.sha < second.sha ? 1 : first.sha > second.sha ? -1 : 0;
  });
}

/**
 * Compares two changelog payloads ignoring `generatedAt`, so a re-run that
 * produces the same entries + native releases leaves the committed file (and its
 * timestamp) untouched. Mirrors the churn-free idempotency in
 * fetch-acknowledgements.ts.
 */
export function isContentEqual(first: ChangelogData, second: ChangelogData): boolean {
  return (
    JSON.stringify(first.entries) === JSON.stringify(second.entries) &&
    JSON.stringify(first.nativeReleases ?? []) === JSON.stringify(second.nativeReleases ?? [])
  );
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

// The store(s) a native release shipped to, for the CHANGELOG.md "App update" note.
function storeLabel(platforms: NativePlatform[]): string {
  const ios = platforms.includes('ios');
  const android = platforms.includes('android');
  if (ios && android) return 'the App Store and Play Store';
  if (ios) return 'the App Store';
  return 'the Play Store';
}

/**
 * Renders the changelog as a human-readable, Keep a Changelog-style CHANGELOG.md:
 * `## <YYYY-MM-DD>` sections newest-first. Each day leads with an `### App update`
 * note when a native build shipped that day (from `nativeReleases`), then `### New
 * / Improved / Fixed` subsections of PR-linked bullets. A pure function with no
 * timestamps, so the same inputs always produce a byte-identical file. `entries` is
 * expected newest-first (as `buildEntries` returns).
 */
export function renderChangelogMarkdown(entries: ChangelogEntry[], nativeReleases: NativeRelease[] = []): string {
  if (entries.length === 0 && nativeReleases.length === 0) return CHANGELOG_PREAMBLE;

  // Group entries by UTC date.
  const entriesByDate = new Map<string, ChangelogEntry[]>();
  for (const entry of entries) {
    const date = entry.mergedAt.slice(0, 10); // ISO 8601 → YYYY-MM-DD (UTC)
    const group = entriesByDate.get(date) ?? [];
    group.push(entry);
    entriesByDate.set(date, group);
  }

  // Group native-release markers by the same UTC date key.
  const releasesByDate = new Map<string, NativeRelease[]>();
  for (const release of nativeReleases) {
    const date = release.date.slice(0, 10);
    const group = releasesByDate.get(date) ?? [];
    group.push(release);
    releasesByDate.set(date, group);
  }

  // Newest-first union of every date. ISO YYYY-MM-DD sorts lexicographically.
  const allDates = [...new Set([...entriesByDate.keys(), ...releasesByDate.keys()])].sort((first, second) =>
    first < second ? 1 : first > second ? -1 : 0,
  );

  const sections = allDates.map((date) => {
    const blocks: string[] = [];

    // The "App update" note leads the day so the store-build boundary is obvious.
    const dayReleases = releasesByDate.get(date) ?? [];
    if (dayReleases.length > 0) {
      const platforms = [...new Set(dayReleases.flatMap((release) => release.platforms))].sort();
      blocks.push(`### App update\n\nA new version shipped to ${storeLabel(platforms)}.`);
    }

    const dayEntries = entriesByDate.get(date) ?? [];
    for (const [category, label] of CATEGORY_LABELS) {
      const inCategory = dayEntries.filter((entry) => entry.category === category);
      if (inCategory.length === 0) continue;
      const bullets = inCategory.map((entry) => {
        const line = `- ${entry.title} ([#${entry.prNumber}](${entry.prUrl}))`;
        return entry.body ? `${line}\n  ${entry.body.replace(/\n/g, '\n  ')}` : line;
      });
      blocks.push(`### ${label}\n\n${bullets.join('\n')}`);
    }

    return `## ${date}\n\n${blocks.join('\n\n')}`;
  });

  return `${CHANGELOG_PREAMBLE}\n${sections.join('\n\n')}\n`;
}
