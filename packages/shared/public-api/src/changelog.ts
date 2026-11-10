/**
 * The public API changelog: one entry per change to the published contract,
 * newest first. It is the source for `www.boardsesh.com/developers/changelog`
 * (docs/partner-api.md, section 6) and the input to the CI gate that fails a PR
 * changing `generated/openapi.json` without an entry
 * (docs/integration-platform.md, "Versioning").
 *
 * The newest entry names the SHA-256 of the committed document it describes,
 * so a document change without a new entry is caught on every run, and
 * entries already on `main` may never change, so an old entry cannot be
 * re-pointed at the new document instead.
 */
import { z } from 'zod';
import changelogFile from './changelog.json';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;

export const PublicApiChangelogEntrySchema = z.strictObject({
  /** The UTC day the change shipped. */
  date: z.string().regex(ISO_DATE),
  /** SHA-256 (hex) of the committed `generated/openapi.json` once this change is in. */
  documentSha256: z.string().regex(SHA256_HEX),
  /** What changed, for a developer reading the page. */
  changes: z.array(z.string().trim().min(1)).min(1),
});
export type PublicApiChangelogEntry = z.infer<typeof PublicApiChangelogEntrySchema>;

export const PublicApiChangelogSchema = z.strictObject({
  entries: z.array(PublicApiChangelogEntrySchema).min(1),
});

/** The committed changelog, newest entry first. */
export const PUBLIC_API_CHANGELOG: readonly PublicApiChangelogEntry[] =
  PublicApiChangelogSchema.parse(changelogFile).entries;

/**
 * Every rule the gate enforces, as messages; empty means it passes.
 * `baseEntries` is the changelog on the PR's base, when there is one.
 */
export function publicApiChangelogProblems({
  entries,
  documentSha256,
  baseEntries,
}: {
  entries: readonly PublicApiChangelogEntry[];
  documentSha256: string;
  baseEntries?: readonly PublicApiChangelogEntry[];
}): string[] {
  const problems: string[] = [];
  const [newest] = entries;
  if (!newest) return ['The changelog has no entries.'];
  if (newest.documentSha256 !== documentSha256) {
    problems.push(
      `generated/openapi.json changed (sha256 ${documentSha256}) without a changelog entry. Add one at the top of packages/shared/public-api/src/changelog.json with that documentSha256.`,
    );
  }
  // Every entry records a change from the one below it, so neighbours name
  // different documents. A document may come back further down: reverting a
  // change restores an older hash, and that revert stays in the history.
  for (let index = 1; index < entries.length; index += 1) {
    if (entries[index - 1].documentSha256 === entries[index].documentSha256) {
      problems.push(
        `Two neighbouring changelog entries name document ${entries[index].documentSha256}: an entry needs a contract change.`,
      );
    }
  }
  for (let index = 1; index < entries.length; index += 1) {
    if (entries[index - 1].date < entries[index].date) {
      problems.push(
        `Changelog entries must be newest first: ${entries[index - 1].date} is above ${entries[index].date}.`,
      );
    }
  }
  if (baseEntries) {
    const published = entries.slice(entries.length - baseEntries.length);
    const unchanged = entries.length >= baseEntries.length && JSON.stringify(published) === JSON.stringify(baseEntries);
    if (!unchanged) {
      problems.push(
        'Changelog entries already on the base branch were changed or removed. Add new entries at the top; never edit published ones.',
      );
    }
  }
  return problems;
}
