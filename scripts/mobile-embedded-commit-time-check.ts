/// <reference types="node" />

/**
 * Postcondition for a native build: the bundle it just embedded must be stamped
 * with HEAD's committer date, not with the moment it happened to bundle.
 *
 * `expo-updates` launches whichever update has the newest `commitTime`, and
 * upstream's `createManifestForBuildAsync` uses `new Date().getTime()`. A
 * ~50-minute build started from commit A therefore finishes NEWER than an OTA
 * published mid-build from a later commit B under the same fingerprint, and the
 * binary keeps launching its own bundle forever (2.4.0 build 10 vs #4992,
 * 2026-09-01). `patches/expo-updates@57.0.19.patch` fixes that at the source —
 * but its resolver falls back to build time whenever git is unreadable, which is
 * exactly the bug returning under a warning nobody reads.
 *
 * So assert it on the artifact. `app.manifest` is generated on the build machine,
 * inside the Xcode script phase / the Gradle task, from a git checkout no unit
 * test can stand in for; this is the only place the real value can be seen.
 *
 * Finding NO manifest is a failure, not a pass. "Nothing to check" is how a guard
 * like this goes vacuous when a build layout moves.
 *
 * Usage: vp run check:mobile-embedded-commit-time -- --search-root <dir> [--search-root <dir>]
 *
 * The caller names the directory it just built, rather than this script guessing
 * a per-platform default that could quietly drift onto an empty tree and then
 * "pass".
 */

import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '../..');

/** One `app.manifest` found in a build output. */
export interface EmbeddedManifest {
  /** Absolute path, printed in failures so a human can open the file. */
  path: string;
  /** `commitTime` as read, before any validation. `null` when unreadable. */
  commitTime: number | null;
}

export interface CommitTimeVerdict {
  ok: boolean;
  message: string;
}

/** HEAD's committer date in epoch milliseconds — what the patched resolver embeds. */
export function resolveExpectedCommitTime(repoRoot: string = REPO_ROOT): number {
  const committerDate = execFileSync('git', ['log', '-1', '--format=%ct', 'HEAD'], {
    cwd: repoRoot,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
  const committerTime = Number(committerDate) * 1000;
  if (!Number.isInteger(committerTime) || committerTime <= 0) {
    throw new Error(
      `[mobile-embedded-commit-time] HEAD has no usable committer date (got ${JSON.stringify(committerDate)}).`,
    );
  }
  return committerTime;
}

/** Every `app.manifest` under `searchRoot`, with its parsed `commitTime`. */
export function findEmbeddedManifests(searchRoot: string): EmbeddedManifest[] {
  const found: EmbeddedManifest[] = [];
  let entries;
  try {
    entries = readdirSync(searchRoot, { withFileTypes: true });
  } catch {
    // A root that does not exist contributes nothing; the caller fails on the
    // empty total rather than here, so a per-platform layout change reads as
    // "no manifest found" instead of a stack trace.
    return found;
  }
  for (const entry of entries) {
    const entryPath = join(searchRoot, entry.name);
    if (entry.isDirectory()) {
      found.push(...findEmbeddedManifests(entryPath));
      continue;
    }
    if (entry.name !== 'app.manifest') continue;
    found.push({ path: entryPath, commitTime: readCommitTime(entryPath) });
  }
  return found;
}

function readCommitTime(manifestPath: string): number | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(manifestPath, 'utf-8'));
    if (typeof parsed !== 'object' || parsed === null) return null;
    const commitTime = (parsed as { commitTime?: unknown }).commitTime;
    return typeof commitTime === 'number' ? commitTime : null;
  } catch {
    return null;
  }
}

/**
 * Every manifest must carry exactly `expectedCommitTime`.
 *
 * Exact, not "close enough": the patched resolver clamps to `Date.now()`, so any
 * value other than the committer date means it took the fallback — the very case
 * this guard exists to catch — and a tolerance window would hide it whenever the
 * build was fast.
 */
export function verifyEmbeddedCommitTime(
  manifests: readonly EmbeddedManifest[],
  expectedCommitTime: number,
): CommitTimeVerdict {
  if (manifests.length === 0) {
    return {
      ok: false,
      message:
        'No app.manifest found in the build output. Either nothing was bundled, or the output layout moved — ' +
        'either way this check proved nothing, so it fails rather than passing vacuously.',
    };
  }
  const wrong = manifests.filter((manifest) => manifest.commitTime !== expectedCommitTime);
  if (wrong.length === 0) {
    return {
      ok: true,
      message: `${manifests.length} embedded manifest(s) stamped with HEAD's committer date (${new Date(expectedCommitTime).toISOString()}).`,
    };
  }
  const detail = wrong
    .map((manifest) => {
      const seen = manifest.commitTime === null ? 'unreadable' : new Date(manifest.commitTime).toISOString();
      return `  ${manifest.path}\n    embedded ${seen}, expected ${new Date(expectedCommitTime).toISOString()}`;
    })
    .join('\n');
  return {
    ok: false,
    message:
      `${wrong.length} embedded manifest(s) are not stamped with HEAD's committer date:\n${detail}\n` +
      'This binary can outrank an OTA published from a LATER commit under the same fingerprint, which strands ' +
      'that JS forever (boardsesh/boardsesh#5021). The patched expo-updates resolver falls back to build time ' +
      'when git is unreadable — check the bundling step for its warning, and that patches/expo-updates@*.patch applied.',
  };
}

/** Every value given for a repeatable flag, in order. */
function readFlags(argv: string[], flag: string): string[] {
  const values: string[] = [];
  for (const [index, argument] of argv.entries()) {
    if (argument !== flag) continue;
    const value = argv[index + 1];
    if (value !== undefined) values.push(value);
  }
  return values;
}

export function main(argv: string[] = process.argv.slice(2)): number {
  const searchRoots = readFlags(
    argv.filter((arg) => arg !== '--'),
    '--search-root',
  );
  if (searchRoots.length === 0) {
    console.error('[mobile-embedded-commit-time] Usage: --search-root <dir> [--search-root <dir>]');
    return 1;
  }

  const expectedCommitTime = resolveExpectedCommitTime();
  const manifests = searchRoots.flatMap((root) => findEmbeddedManifests(resolve(REPO_ROOT, root)));
  const verdict = verifyEmbeddedCommitTime(manifests, expectedCommitTime);

  console[verdict.ok ? 'log' : 'error'](`[mobile-embedded-commit-time] ${verdict.message}`);
  return verdict.ok ? 0 : 1;
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  process.exit(main());
}
