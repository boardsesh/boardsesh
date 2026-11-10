import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CHANGELOG_FILE, OPENAPI_DOCUMENT_FILE, checkPublicApiChangelog } from './check-public-api-changelog';

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

function changelog(...entries: Array<{ date: string; document: string; change?: string }>): string {
  return `${JSON.stringify(
    {
      entries: entries.map(({ date, document, change = 'Something changed.' }) => ({
        date,
        documentSha256: sha256(document),
        changes: [change],
      })),
    },
    null,
    2,
  )}\n`;
}

const directories: string[] = [];

/** A repository whose base commit has document one and its entry. */
function fixture() {
  const cwd = mkdtempSync(join(tmpdir(), 'public-api-changelog-'));
  directories.push(cwd);
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const write = (path: string, contents: string) => {
    mkdirSync(dirname(join(cwd, path)), { recursive: true });
    writeFileSync(join(cwd, path), contents);
  };
  const commit = () => {
    git('add', '.');
    git('commit', '-m', 'fixture');
    return git('rev-parse', 'HEAD');
  };
  git('init', '--initial-branch=main');
  git('config', 'user.name', 'Changelog test');
  git('config', 'user.email', 'changelog@example.com');
  write(OPENAPI_DOCUMENT_FILE, 'document one');
  write(CHANGELOG_FILE, changelog({ date: '2026-11-10', document: 'document one' }));
  const baseSha = commit();
  return { cwd, write, commit, baseSha };
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('the public API changelog gate', () => {
  it('passes a PR that leaves the contract alone', () => {
    const { cwd, write, commit, baseSha } = fixture();
    write('feature.txt', 'unrelated');
    commit();
    expect(checkPublicApiChangelog({ cwd, baseSha })).toEqual([]);
  });

  it('fails a PR that changes the document without an entry', () => {
    const { cwd, write, commit, baseSha } = fixture();
    write(OPENAPI_DOCUMENT_FILE, 'document two');
    commit();
    expect(checkPublicApiChangelog({ cwd, baseSha })).toEqual([expect.stringContaining('without a changelog entry')]);
    // On a push, with no base to compare, the hash alone still catches it.
    expect(checkPublicApiChangelog({ cwd })).toEqual([expect.stringContaining('without a changelog entry')]);
  });

  it('passes a PR that changes the document and adds an entry on top', () => {
    const { cwd, write, commit, baseSha } = fixture();
    write(OPENAPI_DOCUMENT_FILE, 'document two');
    write(
      CHANGELOG_FILE,
      changelog({ date: '2026-11-12', document: 'document two' }, { date: '2026-11-10', document: 'document one' }),
    );
    commit();
    expect(checkPublicApiChangelog({ cwd, baseSha })).toEqual([]);
  });

  it('fails a PR that re-points the published entry at the new document', () => {
    const { cwd, write, commit, baseSha } = fixture();
    write(OPENAPI_DOCUMENT_FILE, 'document two');
    write(CHANGELOG_FILE, changelog({ date: '2026-11-10', document: 'document two' }));
    commit();
    expect(checkPublicApiChangelog({ cwd, baseSha })).toEqual([expect.stringContaining('never edit published ones')]);
  });

  it('passes a PR that reverts the document to an older version with a new entry', () => {
    const { cwd, write, commit } = fixture();
    write(OPENAPI_DOCUMENT_FILE, 'document two');
    write(
      CHANGELOG_FILE,
      changelog({ date: '2026-11-12', document: 'document two' }, { date: '2026-11-10', document: 'document one' }),
    );
    const changedSha = commit();
    write(OPENAPI_DOCUMENT_FILE, 'document one');
    write(
      CHANGELOG_FILE,
      changelog(
        { date: '2026-11-13', document: 'document one', change: 'Reverted.' },
        { date: '2026-11-12', document: 'document two' },
        { date: '2026-11-10', document: 'document one' },
      ),
    );
    commit();
    expect(checkPublicApiChangelog({ cwd, baseSha: changedSha })).toEqual([]);
  });

  it('accepts the first changelog, when the base has none', () => {
    const { cwd, write, commit } = fixture();
    const baseWithout = execFileSync(
      'git',
      ['commit-tree', '-m', 'empty', '4b825dc642cb6eb9a060e54bf8d69288fbee4904'],
      {
        cwd,
        encoding: 'utf8',
      },
    ).trim();
    write('feature.txt', 'unrelated');
    commit();
    expect(checkPublicApiChangelog({ cwd, baseSha: baseWithout })).toEqual([]);
  });

  it('refuses a base commit that is not in the checkout', () => {
    const { cwd } = fixture();
    expect(() => checkPublicApiChangelog({ cwd, baseSha: 'f'.repeat(40) })).toThrow(/not in this checkout/);
  });
});
