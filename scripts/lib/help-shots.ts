import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDevObjectPublisher } from './dev-object-store';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

/**
 * Where the `help` Maestro flow drops its raw PNGs. Raw device captures are ~1 MB
 * each, so they reach a reviewer through the dev bucket, never through Git.
 *
 * Under `app-stores/help/`, NOT `app-stores/` itself. `writeCapturedScreenshots`
 * clears every PNG in its output directory before writing, so while the two flows
 * shared a root a `--flow help` run replaced the committed App Store shard — the
 * one the rolling screenshot baseline and `mobile-store-draft.yml` both read.
 * `outputRootForFlow` in `scripts/mobile-screenshots.ts` is the other half of this.
 */
export const DEFAULT_HELP_SHOT_DIR = resolve(REPO_ROOT, 'app-stores/help/apple/screenshots/en-US/iphone-16-pro-max');

/** Machine-readable link index; regenerated whole on every successful publish. */
export const HELP_SHOT_MANIFEST_PATH = resolve(REPO_ROOT, 'docs/help-screenshots.json');
/** Human-readable twin of the manifest — the table a PR reviewer clicks through. */
export const HELP_SHOT_INDEX_PATH = resolve(REPO_ROOT, 'docs/help-screenshots.md');
/** Where `help:convert-shots` writes the webp assets the help page actually ships. */
export const HELP_WEBP_DIR = resolve(REPO_ROOT, 'packages/web/public/images/help');

/**
 * The capture → shipped-asset mapping, in Maestro capture order. This is the
 * single source of truth for both halves of the pipeline: the numeric prefix
 * keeps the Maestro flow's output ordered on disk, while the web app imports the
 * stable name (`/images/help/discover.webp`) that survives a reordered flow.
 *
 * A capture missing from a run is a hard failure rather than a skipped file:
 * silently shipping eleven of twelve assets is how a help page ends up with a
 * broken image that nobody notices until it is live.
 *
 * The flow shoots FOURTEEN; this map ships twelve. `13-share-beta` and
 * `14-beta-shelf` are captured but not published, because the capture account
 * has no beta video attached, so both screens photograph their empty state. The
 * shots are honest — that really is what the app shows with nothing to list —
 * they just teach nothing. Attach a reel to one of that account's ascents and
 * both rows can come back.
 */
export const HELP_SHOTS = [
  { capture: '01-discover', asset: 'discover' },
  { capture: '02-playlist-detail', asset: 'playlist-detail' },
  { capture: '03-home-live', asset: 'live-sessions' },
  { capture: '04-session-detail', asset: 'session-detail' },
  { capture: '05-holds-filter', asset: 'holds-filter' },
  { capture: '06-zone-filter', asset: 'zone-filter' },
  { capture: '07-setters', asset: 'setters' },
  { capture: '08-logbook', asset: 'logbook' },
  { capture: '09-board-sheet', asset: 'board-sheet' },
  { capture: '10-board-view', asset: 'board-view' },
  { capture: '11-climb-actions', asset: 'climb-actions' },
  { capture: '12-preview', asset: 'preview' },
] as const;

/** Sharp settings are fixed by prior art — see docs/design/marketing-campaign-assets.md. */
export const HELP_WEBP_RESIZE = { height: 1600, withoutEnlargement: true } as const;
export const HELP_WEBP_ENCODE = { quality: 87, effort: 6 } as const;

/**
 * The existing marketing webps land between 43 KB and 95 KB at these settings, so
 * anything past this is worth a second look before it is committed — usually a
 * capture that was taken at the wrong device scale.
 */
export const HELP_WEBP_EXPECTED_MAX_BYTES = 120_000;

interface HelpShotLink {
  url: string;
  sha256: string;
  bytes: number;
}

export interface HelpCapture {
  /** Capture stem, e.g. `01-discover`. */
  capture: string;
  /** Shipped asset stem, e.g. `discover`. */
  asset: string;
  /** Absolute path to the source PNG. */
  filename: string;
}

const PNG_MAGIC = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

/**
 * Accepts only a plain lowercase PNG basename. The stem becomes part of an object
 * key, so restricting it here is what keeps `createDevObjectPublisher` from ever
 * seeing a traversal segment or a space.
 */
export function helpCaptureName(filename: string): string {
  const name = basename(filename);
  const stem = name.endsWith('.png') ? name.slice(0, -4) : '';
  if (!/^[a-z0-9][a-z0-9-]*$/.test(stem)) {
    throw new Error(`Not a publishable help capture name: ${name}`);
  }
  return stem;
}

/** Guards against uploading a truncated or half-written Maestro capture. */
export function assertPngBytes(filename: string, bytes: Buffer): void {
  if (!bytes.subarray(0, 8).equals(PNG_MAGIC)) throw new Error(`Not a PNG help capture: ${filename}`);
}

export function helpShotAsset(capture: string): string | undefined {
  return HELP_SHOTS.find((shot) => shot.capture === capture)?.asset;
}

/**
 * Resolves the full shot set inside `inputDir`, reporting every absent capture
 * at once — a partial run should not make the caller rediscover the gaps one
 * failed conversion at a time.
 */
export function resolveHelpShotSet(inputDir: string): HelpCapture[] {
  const captures = HELP_SHOTS.map((shot) => ({
    capture: shot.capture,
    asset: shot.asset,
    filename: resolve(inputDir, `${shot.capture}.png`),
  }));
  const missing = captures.filter((capture) => !existsSync(capture.filename));
  if (missing.length) {
    throw new Error(
      `Missing ${missing.length} of ${HELP_SHOTS.length} help captures in ${inputDir}:\n` +
        missing.map((capture) => `  - ${capture.capture}.png`).join('\n') +
        '\nRe-run the help Maestro flow; a short set ships a broken help page.',
    );
  }
  return captures;
}

export interface HelpShotArgs {
  inputDir: string;
  dryRun: boolean;
  help: boolean;
}

/**
 * Shared argument shape for both halves of the pipeline. Lives here rather than in
 * either script so `help:publish-shots` and `help:convert-shots` can never drift
 * into disagreeing about which directory "the captures" means.
 */
export function parseHelpShotArgs(argv: readonly string[]): HelpShotArgs {
  let inputDir = DEFAULT_HELP_SHOT_DIR;
  let dryRun = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    // `vp run <task> -- --flag` forwards the separator itself; drop it.
    if (argument === '--') continue;
    if (argument === '--help' || argument === '-h') return { inputDir, dryRun, help: true };
    if (argument === '--dry-run') dryRun = true;
    else if (argument === '--input') {
      const value = argv[index + 1];
      if (!value || value.startsWith('-')) throw new Error('--input needs a directory');
      inputDir = resolve(value);
      index += 1;
    } else if (argument.startsWith('-')) throw new Error(`Unknown option: ${argument}`);
    // A bare positional is the capture directory, so the common override stays
    // `vp run help:convert-shots -- some/dir` with no flag to remember.
    else inputDir = resolve(argument);
  }
  return { inputDir, dryRun, help: false };
}

function readLinks(): Record<string, HelpShotLink> {
  if (!existsSync(HELP_SHOT_MANIFEST_PATH)) return {};
  const parsed: unknown = JSON.parse(readFileSync(HELP_SHOT_MANIFEST_PATH, 'utf8'));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Invalid help screenshot manifest');
  }
  const links: Record<string, HelpShotLink> = {};
  for (const [capture, entry] of Object.entries(parsed)) {
    if (
      !entry ||
      typeof entry !== 'object' ||
      !('url' in entry) ||
      typeof entry.url !== 'string' ||
      !('sha256' in entry) ||
      typeof entry.sha256 !== 'string' ||
      !('bytes' in entry) ||
      typeof entry.bytes !== 'number'
    ) {
      throw new Error(`Invalid help screenshot entry: ${capture}`);
    }
    links[capture] = { url: entry.url, sha256: entry.sha256, bytes: entry.bytes };
  }
  return links;
}

function renderIndex(links: Record<string, HelpShotLink>): string {
  const rows = Object.entries(links).map(([capture, link]) => {
    const asset = helpShotAsset(capture);
    const ships = asset ? `\`${asset}.webp\`` : '—';
    return `| \`${capture}.png\` | ${ships} | ${(link.bytes / 1024).toFixed(0)} KB | [Open shot](${link.url}) |`;
  });
  return [
    '# Help page screenshots',
    '',
    'Generated by `vp run help:publish-shots`. The raw PNGs live in the public `dev`',
    'object-storage bucket and are ignored by Git; only this index and the shipped',
    'webp assets are committed.',
    '',
    '`vp run help:publish-shots` uploads every PNG in the capture directory, verifies',
    'each public download checksum, and rewrites `help-screenshots.json` and this file.',
    'The index is written once, after every upload succeeds, so a failed run leaves the',
    'previous links intact. A run prunes entries whose source PNG is gone; stored',
    'objects are retained, and content-hashed keys keep shared links stable.',
    '',
    '`vp run help:convert-shots` turns the same directory into',
    '`packages/web/public/images/help/<name>.webp`. It requires the complete set and',
    'names every absent capture rather than shipping a short one.',
    '',
    'Add the variables from `.env.dev-artifacts.example` to the repository root’s',
    'ignored `.env.local`, then fill in the dev bucket credentials. These commands use',
    'only `DEV_*` storage variables, never production media credentials.',
    '',
    '| Capture | Ships as | Size | Shot |',
    '| --- | --- | ---: | --- |',
    ...rows,
    '',
  ].join('\n');
}

/** Dev-only credentials: never fall back to production media storage. */
export function createHelpShotPublisher(): {
  publish: (filename: string) => Promise<string>;
  finish: (completeSet?: readonly string[]) => void;
} {
  const publish = createDevObjectPublisher();
  const links = readLinks();

  const publishShot = async (filename: string): Promise<string> => {
    const capture = helpCaptureName(filename);
    const bytes = readFileSync(filename);
    assertPngBytes(filename, bytes);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    // Content-hashed so a re-capture of the same screen publishes a new URL while
    // links already pasted into a review keep resolving to the bytes they showed.
    const url = await publish(`help-shots/${capture}/${sha256}.png`, bytes, 'image/png');

    links[capture] = { url, sha256, bytes: bytes.length };
    return url;
  };

  // Commit links only after the caller successfully publishes the whole batch.
  // A full capture supplies its exact output set; a subset retains other links.
  const finish = (completeSet?: readonly string[]): void => {
    const keep = completeSet ? new Set(completeSet.map(helpCaptureName)) : null;
    const sorted = Object.fromEntries(
      Object.entries(links)
        .filter(([capture]) => !keep || keep.has(capture))
        .sort(([left], [right]) => left.localeCompare(right)),
    );
    writeFileSync(HELP_SHOT_MANIFEST_PATH, `${JSON.stringify(sorted, null, 2)}\n`);
    writeFileSync(HELP_SHOT_INDEX_PATH, renderIndex(sorted));
  };
  return { publish: publishShot, finish };
}
