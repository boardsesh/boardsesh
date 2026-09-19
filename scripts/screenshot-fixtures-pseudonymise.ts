/// <reference types="node" />

/**
 * Rewrite an already-recorded fixture set so only the recording account and
 * explicitly approved test accounts remain identifiable.
 *
 *   vp run mobile:screenshot-fixtures-pseudonymise
 *   vp run mobile:screenshot-fixtures-pseudonymise -- --dir ./artifacts/screenshot-fixtures-android --check
 *
 * The recorder does this on its own now (`pseudonymiseResponse`, applied before
 * a response is ever written), so this exists for the ONE set recorded before
 * it did: the committed one. It applies the exact same function to every
 * graphql fixture's `response` in place.
 *
 * Nothing else moves. A fixture is keyed by its document and its VARIABLES —
 * never by its response — so rewriting the response cannot change a filename,
 * a hash or a manifest entry, and a replay capture keeps hitting exactly the
 * fixtures it hit before. The manifest is touched only to drop a static avatar
 * entry for an unapproved account, since an avatar URL that is now `null` is
 * an asset the app can no longer request.
 *
 * Idempotent: `pseudonymiseResponse` recognises its own output, so a second run
 * reports 0 and writes nothing. `--check` reports without writing, which is
 * what you want against a downloaded recording artifact before committing it.
 */

import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { MANIFEST_FILENAME, readScreenshotFixtureManifest } from './lib/screenshot-backend';
import {
  DEFAULT_SCREENSHOT_FIXTURES_DIR,
  pseudonymiseResponse,
  sortManifestEntries,
  type GraphqlFixtureFile,
  type ScreenshotFixtureManifest,
} from './lib/screenshot-fixtures';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const LOG = '[screenshot-fixtures-pseudonymise]';

/**
 * The asset prefix an avatar URL used to point at. Every avatar in a
 * pseudonymised set is `null`, so nothing requests these any more and a
 * committed copy is just a stranger's face sitting in git.
 */
const AVATAR_ASSET_PREFIX = '/static/avatars/';

export type PseudonymiseRunResult = {
  /** Fixtures whose bytes changed. */
  rewrittenFixtures: number;
  /** Fixtures read. */
  scannedFixtures: number;
  /** Sum of the distinct people rewritten per fixture — a person in two fixtures counts twice. */
  personRewrites: number;
  /** Individual fields rewritten. */
  fieldRewrites: number;
  /** Static avatar entries dropped from the manifest (and their files deleted). */
  removedStaticAvatars: string[];
};

/**
 * Apply the rewrite to every graphql fixture a manifest names, and drop any
 * static avatar the set still carries.
 *
 * `dryRun` reads and reports without writing.
 */
export function pseudonymiseFixtureSet(
  fixturesDir: string,
  manifest: ScreenshotFixtureManifest,
  options: { dryRun: boolean },
): PseudonymiseRunResult {
  const ownUserId = manifest.accountUserId.length > 0 ? manifest.accountUserId : null;
  const result: PseudonymiseRunResult = {
    rewrittenFixtures: 0,
    scannedFixtures: 0,
    personRewrites: 0,
    fieldRewrites: 0,
    removedStaticAvatars: [],
  };

  for (const entry of manifest.graphql) {
    const fixturePath = join(fixturesDir, entry.file);
    const fixture = JSON.parse(readFileSync(fixturePath, 'utf8')) as GraphqlFixtureFile;
    result.scannedFixtures += 1;
    const pseudonymised = pseudonymiseResponse(fixture.response, {
      ownUserId,
      approvedTestUserIds: manifest.approvedTestUserIds,
    });
    if (pseudonymised.fields === 0) continue;
    result.rewrittenFixtures += 1;
    result.personRewrites += pseudonymised.persons;
    result.fieldRewrites += pseudonymised.fields;
    console.log(`${LOG} ${entry.file}: ${pseudonymised.persons} person(s), ${pseudonymised.fields} field(s)`);
    if (options.dryRun) continue;
    // Written exactly the way the recorder writes one — two-space indent plus a
    // trailing newline — so a later re-record produces no spurious diff.
    writeFileSync(fixturePath, `${JSON.stringify({ ...fixture, response: pseudonymised.response }, null, 2)}\n`);
  }

  const survivingStatic = manifest.static.filter((entry) => {
    if (!entry.path.startsWith(AVATAR_ASSET_PREFIX)) return true;
    // Retain the exact native avatar paths for the recording account and the
    // explicitly approved test accounts; unrelated avatars remain removable.
    const approvedIds = [ownUserId, ...(manifest.approvedTestUserIds ?? [])];
    if (approvedIds.some((userId) => userId && entry.path === `${AVATAR_ASSET_PREFIX}${userId}.jpg`)) return true;
    result.removedStaticAvatars.push(entry.file);
    return false;
  });
  if (result.removedStaticAvatars.length > 0 && !options.dryRun) {
    for (const file of result.removedStaticAvatars) rmSync(join(fixturesDir, file), { force: true });
    const rewritten = sortManifestEntries({ ...manifest, static: survivingStatic });
    writeFileSync(join(fixturesDir, MANIFEST_FILENAME), `${JSON.stringify(rewritten, null, 2)}\n`);
  }

  return result;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const USAGE = [
  'Usage: tsx scripts/screenshot-fixtures-pseudonymise.ts [--dir <dir>] [--check]',
  '',
  `  --dir <dir>  the recorded fixture set to rewrite (default ${DEFAULT_SCREENSHOT_FIXTURES_DIR})`,
  '  --check      report what would change and write nothing',
].join('\n');

export type PseudonymiseCliOptions = { fixturesDir: string; dryRun: boolean };

export function parsePseudonymiseArguments(argv: readonly string[]): PseudonymiseCliOptions {
  const args = argv.filter((argument) => argument !== '--');
  let fixturesDir: string | null = null;
  let dryRun = false;

  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (flag === '--dir') {
      const requested = args[index + 1];
      if (requested === undefined || requested.startsWith('--')) throw new Error(`--dir needs a value\n\n${USAGE}`);
      fixturesDir = requested;
      index += 1;
      continue;
    }
    if (flag === '--check') {
      dryRun = true;
      continue;
    }
    if (flag === '--help' || flag === '-h') throw new Error(USAGE);
    throw new Error(`unknown argument ${flag}\n\n${USAGE}`);
  }

  const requestedDir = fixturesDir ?? DEFAULT_SCREENSHOT_FIXTURES_DIR;
  return {
    fixturesDir: isAbsolute(requestedDir) ? requestedDir : resolve(REPO_ROOT, requestedDir),
    dryRun,
  };
}

function main(): void {
  let options: PseudonymiseCliOptions;
  try {
    options = parsePseudonymiseArguments(process.argv.slice(2));
  } catch (parseError) {
    console.error(`${LOG} ${parseError instanceof Error ? parseError.message : String(parseError)}`);
    process.exit(1);
  }

  if (!existsSync(join(options.fixturesDir, MANIFEST_FILENAME))) {
    console.error(`${LOG} no recorded fixture set under ${options.fixturesDir}`);
    process.exit(1);
  }
  const manifest = readScreenshotFixtureManifest(options.fixturesDir);
  if (!manifest) {
    console.error(`${LOG} no recorded fixture set under ${options.fixturesDir}`);
    process.exit(1);
  }

  const result = pseudonymiseFixtureSet(options.fixturesDir, manifest, { dryRun: options.dryRun });
  const verb = options.dryRun ? 'would rewrite' : 'rewrote';
  console.log(
    `${LOG} ${verb} ${result.rewrittenFixtures}/${result.scannedFixtures} fixture(s): ` +
      `${result.personRewrites} person rewrite(s), ${result.fieldRewrites} field(s), ` +
      `${result.removedStaticAvatars.length} static avatar(s) dropped.`,
  );
  if (result.rewrittenFixtures === 0) console.log(`${LOG} nothing to do — the set is already pseudonymised.`);
}

// Guarded so importing this module from Vitest reaches the exported functions
// without running the rewrite, the same way screenshot-backend.ts is guarded.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
