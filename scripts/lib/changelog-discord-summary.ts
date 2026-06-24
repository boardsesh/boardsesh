/**
 * Pure transform for the OTA deploy Discord message. Given the changelog entries
 * that were committed BEFORE this OTA run and the ones committed AFTER it, it
 * computes the entries that are newly added (by PR number) and renders them as a
 * compact, category-grouped "What's new" block for the deploy webhook.
 *
 * This replaces the old behaviour where the Discord message echoed the latest
 * commit subject — which, by the time the notify step runs, is always the
 * workflow's own `chore(changelog): refresh from merged PRs` commit, never the
 * actual changes the OTA shipped.
 *
 * Kept I/O-free so it's unit-testable without GitHub or git (see
 * scripts/__tests__/changelog-discord-summary.test.ts). The shell that reads the
 * two JSON files lives in scripts/changelog-discord-summary.ts.
 */

import type { ChangelogCategory, ChangelogEntry } from './changelog-transform';

// Emoji + label + fixed render order for each category, matching the mobile
// "What's New" screen's grouping. Empty groups are skipped.
const CATEGORY_DISPLAY: ReadonlyArray<readonly [ChangelogCategory, string]> = [
  ['new', '✨ New'],
  ['improved', '🔧 Improved'],
  ['fixed', '🐛 Fixed'],
];

// Discord caps a message at 2000 characters; the header/footer the workflow adds
// take a slice of that, so bound the list well under the limit and summarise the
// overflow rather than risk a truncated (or rejected) post.
const MAX_BULLETS = 15;

type MinimalEntry = Pick<ChangelogEntry, 'prNumber' | 'category' | 'title'>;

/**
 * Returns the entries present in `nextEntries` whose PR number is not in
 * `prevEntries` — i.e. the changelog items this OTA newly adds. Order follows
 * `nextEntries` (the generator emits newest-first).
 */
export function newlyAddedEntries<Entry extends Pick<ChangelogEntry, 'prNumber'>>(
  prevEntries: Entry[],
  nextEntries: Entry[],
): Entry[] {
  const seen = new Set(prevEntries.map((entry) => entry.prNumber));
  return nextEntries.filter((entry) => !seen.has(entry.prNumber));
}

/**
 * Renders the newly-added entries as a category-grouped "What's new" block for the
 * Discord deploy message. Returns an empty string when there's nothing new (the
 * caller then falls back to the triggering commit subject), so the workflow can
 * test it with a simple `[ -s file ]`.
 */
export function renderDiscordSummary(entries: MinimalEntry[]): string {
  if (entries.length === 0) return '';

  // Drop any entry whose category isn't rendered before capping, so `overflow`
  // counts only entries that would have appeared. The union is exhaustive today,
  // but this keeps the "…and N more" count honest if a category is ever added
  // without a matching CATEGORY_DISPLAY row.
  const knownCategories = new Set(CATEGORY_DISPLAY.map(([category]) => category));
  const renderable = entries.filter((entry) => knownCategories.has(entry.category));
  const shown = renderable.slice(0, MAX_BULLETS);
  const overflow = renderable.length - shown.length;

  const blocks: string[] = [];
  for (const [category, label] of CATEGORY_DISPLAY) {
    const inCategory = shown.filter((entry) => entry.category === category);
    if (inCategory.length === 0) continue;
    const bullets = inCategory.map((entry) => `• ${entry.title}`).join('\n');
    blocks.push(`${label}\n${bullets}`);
  }

  let summary = blocks.join('\n');
  if (overflow > 0) summary += `\n…and ${overflow} more`;
  return summary;
}

/**
 * Convenience composition used by the I/O shell: diff prev→next, then render.
 */
export function buildDiscordSummary(prevEntries: MinimalEntry[], nextEntries: MinimalEntry[]): string {
  return renderDiscordSummary(newlyAddedEntries(prevEntries, nextEntries));
}
