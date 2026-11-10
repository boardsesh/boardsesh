/// <reference types="node" />
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vite-plus/test';
import { PUBLIC_API_CHANGELOG, publicApiChangelogProblems, type PublicApiChangelogEntry } from '../changelog';
import { renderPublicApiDocument } from '../document';

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

const entry = (date: string, document: string, change = 'Something changed.'): PublicApiChangelogEntry => ({
  date,
  documentSha256: sha256(document),
  changes: [change],
});

describe('the committed changelog', () => {
  it('has an entry for the document the schemas generate today', () => {
    expect(
      publicApiChangelogProblems({ entries: PUBLIC_API_CHANGELOG, documentSha256: sha256(renderPublicApiDocument()) }),
    ).toEqual([]);
  });
});

describe('the changelog gate', () => {
  const first = entry('2026-11-10', 'document one');
  const second = entry('2026-11-12', 'document two', 'Added a field.');

  it('passes a new document with a new entry on top of the published ones', () => {
    expect(
      publicApiChangelogProblems({
        entries: [second, first],
        documentSha256: second.documentSha256,
        baseEntries: [first],
      }),
    ).toEqual([]);
  });

  it('fails a document change with no entry', () => {
    const problems = publicApiChangelogProblems({
      entries: [first],
      documentSha256: sha256('document two'),
      baseEntries: [first],
    });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('without a changelog entry');
  });

  it('fails re-pointing a published entry at the new document instead of adding one', () => {
    const repointed = { ...first, documentSha256: second.documentSha256 };
    expect(
      publicApiChangelogProblems({ entries: [repointed], documentSha256: second.documentSha256, baseEntries: [first] }),
    ).toEqual([expect.stringContaining('never edit published ones')]);
  });

  it('fails removing a published entry, entries out of date order and two entries for one document', () => {
    expect(
      publicApiChangelogProblems({
        entries: [second],
        documentSha256: second.documentSha256,
        baseEntries: [second, first],
      }),
    ).toEqual([expect.stringContaining('never edit published ones')]);
    expect(publicApiChangelogProblems({ entries: [first, second], documentSha256: first.documentSha256 })).toEqual([
      expect.stringContaining('newest first'),
    ]);
    expect(
      publicApiChangelogProblems({
        entries: [first, { ...first, date: '2026-11-01' }],
        documentSha256: first.documentSha256,
      }),
    ).toEqual([expect.stringContaining('Two neighbouring changelog entries')]);
  });

  it('passes a revert that brings back an older document, and the next change after it', () => {
    const revert = entry('2026-11-14', 'document one', 'Reverted the added field.');
    expect(
      publicApiChangelogProblems({
        entries: [revert, second, first],
        documentSha256: first.documentSha256,
        baseEntries: [second, first],
      }),
    ).toEqual([]);
    const next = entry('2026-11-15', 'document three', 'Added another field.');
    expect(
      publicApiChangelogProblems({
        entries: [next, revert, second, first],
        documentSha256: next.documentSha256,
        baseEntries: [revert, second, first],
      }),
    ).toEqual([]);
  });

  it('fails an entry that changes no contract: the same document as the entry below it', () => {
    const noChange = entry('2026-11-14', 'document two', 'Nothing changed.');
    expect(
      publicApiChangelogProblems({
        entries: [noChange, second, first],
        documentSha256: second.documentSha256,
        baseEntries: [second, first],
      }),
    ).toEqual([expect.stringContaining('needs a contract change')]);
  });
});
