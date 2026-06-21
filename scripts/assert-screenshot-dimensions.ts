/// <reference types="node" />

/**
 * Dimension gate for mobile store screenshots before they're uploaded.
 *
 * App Store Connect routes each screenshot to a display slot by exact pixel
 * dimensions, so iOS captures are checked against device-specific allow-lists.
 * Google Play accepts a broader phone screenshot range, so Android captures are
 * checked against Play's generic size/count rules.
 *
 * It reads width/height straight from each PNG's IHDR header (no `sips` /
 * ImageMagick), so it runs identically on Linux CI and macOS.
 *
 * Usage:
 *   vp run check:screenshot-dimensions -- --platform ios
 *   vp run check:screenshot-dimensions -- --platform android
 *
 * The default platform is ios for backwards compatibility with the original
 * App Store-only gate. Exit code 0 means every PNG under
 * app-stores/apple/screenshots/<app-store-locale>/<device>/ or
 * app-stores/google/screenshots/<device>/ matches the selected store rules.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const APPLE_SHOTS_DIR = resolve(ROOT_DIR, 'app-stores', 'apple', 'screenshots');
const GOOGLE_SHOTS_DIR = resolve(ROOT_DIR, 'app-stores', 'google', 'screenshots');
const LOG = '[check:screenshot-dimensions]';

// First 8 bytes of every PNG file.
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export interface Dimensions {
  width: number;
  height: number;
}

export const EXPECTED_APP_STORE_LOCALES = ['en-US', 'es-ES', 'es-MX', 'fr-FR'] as const;

/**
 * Portrait sizes App Store Connect accepts, keyed by the capture device slug
 * (see deviceSlug() in mobile-screenshots.ts). A device folder with no entry
 * here is treated as an offender (fail closed), so a future capture into a new
 * slug can't sneak un-validated sizes past the gate.
 */
export const ACCEPTED_SIZES: Record<string, readonly Dimensions[]> = {
  // 6.9" iPhone slot — the ONLY size we capture. Apple auto-scales it down to every
  // smaller iPhone, so one 6.9" set covers the whole device range and extra sizes add
  // no store/ranking value (see app-store-submission-guide.md). Apple accepts the
  // iPhone 16 Pro Max native 1320x2868 or the prior-gen 1290x2796 here.
  'iphone-16-pro-max': [
    { width: 1320, height: 2868 },
    { width: 1290, height: 2796 },
  ],
};

/** Read width/height from a PNG buffer's IHDR. Throws on a non-PNG / truncated file. */
export function readPngDimensions(buffer: Buffer): Dimensions {
  // Signature (8) + IHDR length (4) + "IHDR" (4) + width (4) + height (4) = 24.
  if (buffer.length < 24 || !buffer.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new Error('not a PNG (bad signature)');
  }
  // The first chunk must be IHDR; its type tag sits at bytes 12-15.
  if (buffer.toString('ascii', 12, 16) !== 'IHDR') {
    throw new Error('first PNG chunk is not IHDR');
  }
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

export interface PngFile {
  /** Path relative to the screenshots root, for human-readable error output. */
  name: string;
  buffer: Buffer;
}

export interface Offender {
  file: string;
  reason: string;
}

export type ScreenshotTree = Record<string, Record<string, PngFile[]>>;

/** Pure: validate one App Store device folder's PNGs against its accepted-size allow-list. */
export function findOffenders(deviceSlug: string, files: readonly PngFile[]): Offender[] {
  const accepted = ACCEPTED_SIZES[deviceSlug];
  if (!accepted) {
    return files.map((file) => ({
      file: file.name,
      reason: `no accepted-size list for device "${deviceSlug}"`,
    }));
  }

  const offenders: Offender[] = [];
  for (const file of files) {
    let dimensions: Dimensions;
    try {
      dimensions = readPngDimensions(file.buffer);
    } catch (error) {
      offenders.push({ file: file.name, reason: error instanceof Error ? error.message : String(error) });
      continue;
    }
    const matches = accepted.some((size) => size.width === dimensions.width && size.height === dimensions.height);
    if (!matches) {
      const allowed = accepted.map((size) => `${size.width}x${size.height}`).join(' or ');
      offenders.push({
        file: file.name,
        reason: `is ${dimensions.width}x${dimensions.height}, expected ${allowed}`,
      });
    }
  }
  return offenders;
}

/** Pure: validate one Google Play phone screenshot folder. */
export function findGooglePlayOffenders(deviceSlug: string, files: readonly PngFile[]): Offender[] {
  const offenders: Offender[] = [];
  if (files.length < 2) {
    offenders.push({
      file: `${deviceSlug}/`,
      reason: `has ${files.length} screenshot(s), expected at least 2 for a Play phone listing`,
    });
  }
  if (files.length > 8) {
    offenders.push({
      file: `${deviceSlug}/`,
      reason: `has ${files.length} screenshot(s), expected at most 8 for a Play phone listing`,
    });
  }

  for (const file of files) {
    let dimensions: Dimensions;
    try {
      dimensions = readPngDimensions(file.buffer);
    } catch (error) {
      offenders.push({ file: file.name, reason: error instanceof Error ? error.message : String(error) });
      continue;
    }

    const shorterSide = Math.min(dimensions.width, dimensions.height);
    const longerSide = Math.max(dimensions.width, dimensions.height);
    if (shorterSide < 320) {
      offenders.push({
        file: file.name,
        reason: `is ${dimensions.width}x${dimensions.height}, expected both sides to be at least 320px`,
      });
      continue;
    }
    if (longerSide > 3840) {
      offenders.push({
        file: file.name,
        reason: `is ${dimensions.width}x${dimensions.height}, expected both sides to be at most 3840px`,
      });
      continue;
    }
    if (longerSide > shorterSide * 2) {
      offenders.push({
        file: file.name,
        reason: `is ${dimensions.width}x${dimensions.height}, expected the long side to be no more than 2x the short side`,
      });
    }
  }
  return offenders;
}

function sortedKeys(record: Record<string, unknown>): string[] {
  return Object.keys(record).sort();
}

function basenames(files: readonly PngFile[]): string[] {
  // file.name is "<locale>/<device>/<file>.png" (Apple) or "<device>/<file>.png"
  // (Play), so the last path segment is the bare filename used to compare coverage
  // across locales/devices. split() always returns at least one element, so the
  // `?? file.name` fallback only satisfies `.at(-1)`'s `string | undefined` type —
  // it never actually runs.
  return files.map((file) => file.name.split('/').at(-1) ?? file.name).sort();
}

function listsMatch(first: readonly string[], second: readonly string[]): boolean {
  return first.length === second.length && first.every((item, index) => item === second[index]);
}

/** Pure: validate locale/device coverage plus per-device PNG dimensions. */
export function findScreenshotTreeOffenders(tree: ScreenshotTree): Offender[] {
  const offenders: Offender[] = [];
  const localeNames = sortedKeys(tree);

  for (const locale of localeNames) {
    if (!(EXPECTED_APP_STORE_LOCALES as readonly string[]).includes(locale)) {
      offenders.push({ file: locale, reason: 'unknown App Store locale directory' });
    }
  }

  for (const expectedLocale of EXPECTED_APP_STORE_LOCALES) {
    if (!tree[expectedLocale]) {
      offenders.push({ file: expectedLocale, reason: 'missing App Store locale directory' });
    }
  }

  const firstExpectedLocale = EXPECTED_APP_STORE_LOCALES.find((locale) => tree[locale]);
  const referenceDevices = firstExpectedLocale ? sortedKeys(tree[firstExpectedLocale]) : [];
  if (referenceDevices.length === 0 && firstExpectedLocale) {
    offenders.push({ file: firstExpectedLocale, reason: 'contains no device screenshot folders' });
  }

  for (const expectedLocale of EXPECTED_APP_STORE_LOCALES) {
    const devices = tree[expectedLocale];
    if (!devices) continue;
    const deviceNames = sortedKeys(devices);
    if (deviceNames.length === 0) {
      offenders.push({ file: expectedLocale, reason: 'contains no device screenshot folders' });
      continue;
    }
    if (referenceDevices.length > 0 && !listsMatch(deviceNames, referenceDevices)) {
      offenders.push({
        file: expectedLocale,
        reason: `device folders are ${deviceNames.join(', ')}, expected ${referenceDevices.join(', ')}`,
      });
    }

    for (const deviceName of deviceNames) {
      const files = devices[deviceName];
      if (!files || files.length === 0) {
        offenders.push({ file: `${expectedLocale}/${deviceName}`, reason: 'contains no PNG screenshots' });
        continue;
      }
      if (referenceDevices.includes(deviceName) && firstExpectedLocale) {
        const referenceFiles = tree[firstExpectedLocale]?.[deviceName] ?? [];
        const expectedFiles = basenames(referenceFiles);
        const actualFiles = basenames(files);
        if (expectedFiles.length > 0 && !listsMatch(actualFiles, expectedFiles)) {
          offenders.push({
            file: `${expectedLocale}/${deviceName}`,
            reason: `PNG set is ${actualFiles.join(', ')}, expected ${expectedFiles.join(', ')}`,
          });
        }
      }
      offenders.push(...findOffenders(deviceName, files));
    }
  }

  return offenders;
}

type ScreenshotPlatform = 'ios' | 'android' | 'all';

function parsePlatform(argv: readonly string[]): ScreenshotPlatform {
  const args = argv.filter((argument) => argument !== '--');
  let platform: ScreenshotPlatform = 'ios';
  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    const value = args[index + 1];
    if (flag !== '--platform') {
      throw new Error(`Unknown argument: ${flag}`);
    }
    if (value === undefined || value.startsWith('--')) {
      throw new Error('--platform requires a value');
    }
    if (value !== 'ios' && value !== 'android' && value !== 'all') {
      throw new Error(`--platform must be one of: ios, android, all (got "${value}")`);
    }
    platform = value;
    index++;
  }
  return platform;
}

function readAppleScreenshotTree(): { tree: ScreenshotTree; pngCount: number } | null {
  let localeDirs: string[];
  try {
    localeDirs = readdirSync(APPLE_SHOTS_DIR, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    console.error(`${LOG} FAILED: ${APPLE_SHOTS_DIR} not found - run \`vp run mobile:screenshots\` first.`);
    return null;
  }

  const tree: ScreenshotTree = {};
  let pngCount = 0;
  for (const locale of localeDirs) {
    const localeDir = join(APPLE_SHOTS_DIR, locale);
    tree[locale] = {};
    const nestedDeviceDirs = readdirSync(localeDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
    for (const slug of nestedDeviceDirs) {
      const dir = join(localeDir, slug);
      const pngNames = readdirSync(dir).filter((name) => name.toLowerCase().endsWith('.png'));
      const files: PngFile[] = pngNames.map((name) => ({
        name: `${locale}/${slug}/${name}`,
        buffer: readFileSync(join(dir, name)),
      }));
      pngCount += files.length;
      tree[locale][slug] = files;
    }
  }

  return { tree, pngCount };
}

function validateAppleScreenshots(): number {
  const screenshotTree = readAppleScreenshotTree();
  if (!screenshotTree) return 1;

  if (screenshotTree.pngCount === 0) {
    console.error(`${LOG} FAILED: no screenshots found under ${APPLE_SHOTS_DIR}.`);
    return 1;
  }
  const offenders = findScreenshotTreeOffenders(screenshotTree.tree);
  if (offenders.length > 0) {
    console.error(`${LOG} FAILED: ${offenders.length} App Store screenshot issue(s):`);
    for (const offender of offenders) {
      console.error(`  - ${offender.file}: ${offender.reason}`);
    }
    return 1;
  }

  console.log(`${LOG} OK: ${screenshotTree.pngCount} App Store screenshot(s) match accepted dimensions.`);
  return 0;
}

function validateGooglePlayScreenshots(): number {
  let deviceDirs: string[];
  try {
    deviceDirs = readdirSync(GOOGLE_SHOTS_DIR, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    console.error(
      `${LOG} FAILED: ${GOOGLE_SHOTS_DIR} not found - run \`vp run mobile:screenshots -- --platform android\` first.`,
    );
    return 1;
  }

  const offenders: Offender[] = [];
  let pngCount = 0;
  for (const slug of deviceDirs) {
    const dir = join(GOOGLE_SHOTS_DIR, slug);
    const pngNames = readdirSync(dir).filter((name) => name.toLowerCase().endsWith('.png'));
    const files: PngFile[] = pngNames.map((name) => ({
      name: `${slug}/${name}`,
      buffer: readFileSync(join(dir, name)),
    }));
    pngCount += files.length;
    offenders.push(...findGooglePlayOffenders(slug, files));
  }

  if (pngCount === 0) {
    console.error(`${LOG} FAILED: no screenshots found under ${GOOGLE_SHOTS_DIR}.`);
    return 1;
  }
  if (offenders.length > 0) {
    console.error(`${LOG} FAILED: ${offenders.length} Google Play screenshot issue(s):`);
    for (const offender of offenders) {
      console.error(`  - ${offender.file}: ${offender.reason}`);
    }
    return 1;
  }

  console.log(`${LOG} OK: ${pngCount} Google Play screenshot(s) match accepted dimensions.`);
  return 0;
}

function main(argv: readonly string[] = process.argv.slice(2)): number {
  let platform: ScreenshotPlatform;
  try {
    platform = parsePlatform(argv);
  } catch (error) {
    console.error(`${LOG} ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }

  const platforms: Array<'ios' | 'android'> = platform === 'all' ? ['ios', 'android'] : [platform];
  for (const selectedPlatform of platforms) {
    const status = selectedPlatform === 'ios' ? validateAppleScreenshots() : validateGooglePlayScreenshots();
    if (status !== 0) return status;
  }
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main(process.argv.slice(2)));
}
