/// <reference types="node" />

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * NextAuth is being retired (epic #6975, BA-10 #6984). Until it is gone, no new
 * file may reference it. `next-auth-import-ratchet.allowlist.txt` lists every
 * tracked file that does today; the list may only shrink.
 */
const repoRoot = resolve(import.meta.dirname, '../..');
const ALLOWLIST_PATH = 'scripts/__tests__/next-auth-import-ratchet.allowlist.txt';
const SELF_PATHS = new Set([ALLOWLIST_PATH, 'scripts/__tests__/next-auth-import-ratchet.test.ts']);

const SOURCE_FILE = /\.(?:[cm]?[jt]sx?)$/;
const SKIPPED_PATH = /(?:^|\/)(?:node_modules|dist|build|\.next|\.expo|generated|__generated__)\//;
const SCANNED_ROOTS = [
  'packages/web/',
  'packages/backend/',
  'packages/shared/',
  'packages/db/',
  'packages/mobile/',
  'scripts/',
];

/** `next-auth`, `next-auth/*`, `@next-auth/*`, `@auth/*` (covers `@auth/drizzle-adapter`), as a quoted module specifier. */
const MODULE_SPECIFIER = /['"`](?:next-auth(?:\/[^'"`\s]*)?|@next-auth\/[^'"`\s]+|@auth\/[^'"`\s]+)['"`]/;
const DEPENDENCY_NAME = /^(?:next-auth|@next-auth\/.+|@auth\/.+)$/;
const DEPENDENCY_FIELDS = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'];

function trackedFiles(): string[] {
  return execFileSync('git', ['ls-files', '-z'], { cwd: repoRoot, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
    .split('\0')
    .filter(Boolean);
}

function referencesNextAuth(path: string): boolean {
  let text: string;
  try {
    text = readFileSync(resolve(repoRoot, path), 'utf8');
  } catch {
    return false;
  }
  if (path.endsWith('package.json')) {
    const manifest = JSON.parse(text) as Record<string, unknown>;
    return DEPENDENCY_FIELDS.some((field) => {
      const block = manifest[field];
      return (
        typeof block === 'object' && block !== null && Object.keys(block).some((name) => DEPENDENCY_NAME.test(name))
      );
    });
  }
  return MODULE_SPECIFIER.test(text);
}

function candidateFiles(): string[] {
  return trackedFiles().filter((path) => {
    if (SELF_PATHS.has(path) || SKIPPED_PATH.test(path)) return false;
    const inScope = path === 'package.json' || SCANNED_ROOTS.some((root) => path.startsWith(root));
    if (!inScope) return false;
    return path.endsWith('package.json') || SOURCE_FILE.test(path);
  });
}

function readAllowlist(): string[] {
  return readFileSync(resolve(repoRoot, ALLOWLIST_PATH), 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'));
}

describe('NextAuth import ratchet (BA-10 #6984)', () => {
  const allowlist = readAllowlist();
  const allowed = new Set(allowlist);
  const referencing = candidateFiles().filter(referencesNextAuth);
  const referencingSet = new Set(referencing);

  it('keeps the allowlist sorted and free of duplicates', () => {
    expect(allowlist).toEqual([...new Set(allowlist)].sort());
  });

  it('adds no new file that references next-auth, @next-auth/* or @auth/*', () => {
    const added = referencing.filter((path) => !allowed.has(path));
    expect(
      added,
      [
        'NEW NextAuth reference. NextAuth is being retired (#6984); do not import next-auth, @next-auth/* or @auth/*, or depend on them in a package.json.',
        'Use the Better Auth / first-party session path instead. Offending files:',
        ...added.map((path) => `  ${path}`),
      ].join('\n'),
    ).toEqual([]);
  });

  it('lists no file that has stopped referencing next-auth', () => {
    const stale = allowlist.filter((path) => !referencingSet.has(path));
    expect(
      stale,
      [
        'STALE ALLOWLIST ENTRIES. These files no longer reference NextAuth (or no longer exist).',
        `Remove these paths from ${ALLOWLIST_PATH}:`,
        ...stale.map((path) => `  ${path}`),
      ].join('\n'),
    ).toEqual([]);
  });

  it('reports progress', () => {
    const manifests = referencing.filter((path) => path.endsWith('package.json')).length;
    console.info(
      `${referencing.length - manifests} files still import next-auth (plus ${manifests} package.json dependencies)`,
    );
  });
});
