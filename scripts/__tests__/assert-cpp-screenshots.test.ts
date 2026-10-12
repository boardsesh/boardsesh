import { createHash } from 'node:crypto';
import { linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import sharp from 'sharp';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { assertCppScreenshots } from '../assert-cpp-screenshots';
import {
  ACCEPTED_SIZES,
  EXPECTED_APP_STORE_DEVICE_SLUGS,
  EXPECTED_APP_STORE_LOCALES,
} from '../assert-screenshot-dimensions';
import { DEFAULT_MIN_BYTES } from '../assert-screenshot-content';
import { CPP_MANIFEST_PATH, CPP_TARGETS, readCppPage, type CppTarget } from '../lib/screenshot-cpp';
import { captionLocaleForStore, sha256ScreenshotSources } from '../lib/screenshot-presentation';

interface SourceMetadata {
  rawBytes: number;
  rawSha256: string;
}
interface TestPresentation {
  version: number;
  locale: string;
  cpp: { target: string; manifestSha256: string; fixtureSha256: string };
  files: Record<string, SourceMetadata & { framedSha256: string; sources?: Record<string, SourceMetadata> }>;
}
interface DeviceFixture {
  path: string;
  bytes: number;
  hash: string;
}

const digest = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');
const ownedDirectories: string[] = [];
const deviceFixtures = new Map<string, DeviceFixture>();
let seedDirectory: string;

beforeAll(async () => {
  seedDirectory = mkdtempSync(join(tmpdir(), 'cpp-validator-pixels-'));
  for (const device of EXPECTED_APP_STORE_DEVICE_SLUGS) {
    const { width, height } = ACCEPTED_SIZES[device][0];
    const pixels = Buffer.alloc(width * height * 3, 20);
    // A narrow deterministic noise stripe keeps these genuine PNGs above the
    // blank-image floor without storing hundreds of full noisy screenshots.
    let randomState = 123456789;
    for (let offset = 0; offset < width * 64 * 3; offset++) {
      randomState ^= randomState << 13;
      randomState ^= randomState >>> 17;
      randomState ^= randomState << 5;
      pixels[offset] = randomState & 255;
    }
    const png = await sharp(pixels, { raw: { width, height, channels: 3 } })
      .png()
      .toBuffer();
    expect(png.length).toBeGreaterThan(DEFAULT_MIN_BYTES);
    const filename = join(seedDirectory, `${device}.png`);
    writeFileSync(filename, png);
    deviceFixtures.set(device, { path: filename, bytes: png.length, hash: digest(png) });
  }
});
afterEach(() => {
  for (const directory of ownedDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});
afterAll(() => {
  if (seedDirectory) rmSync(seedDirectory, { recursive: true, force: true });
});

function createTree(targets: readonly CppTarget[] = ['kilter']): string {
  const root = mkdtempSync(join(tmpdir(), 'cpp-validator-tree-'));
  ownedDirectories.push(root);
  const manifestHash = digest(readFileSync(CPP_MANIFEST_PATH));
  for (const target of targets) {
    const page = readCppPage(target);
    if (!page.fixtureReference) throw new Error(`Test target ${target} needs a fixture reference path`);
    // Unit-test pins are isolated under this temporary root, never published or
    // substituted for the repository's unrecorded CPP snapshots.
    const fixtureHash = digest(Buffer.from(`unit-test-snapshot-${target}`));
    const reference = join(root, page.fixtureReference);
    mkdirSync(dirname(reference), { recursive: true });
    writeFileSync(
      reference,
      JSON.stringify({
        version: 1,
        url: `https://fixtures.example.com/${target}.json.gz`,
        sha256: fixtureHash,
        bytes: 100,
        files: 1,
      }),
    );
    for (const locale of EXPECTED_APP_STORE_LOCALES) {
      for (const device of EXPECTED_APP_STORE_DEVICE_SLUGS) {
        const seed = deviceFixtures.get(device)!;
        const base = join(root, 'app-stores/apple/cpp', target);
        const output = join(base, 'screenshots', locale, device);
        const raw = join(base, 'raw-screenshots', locale, device);
        mkdirSync(output, { recursive: true });
        mkdirSync(raw, { recursive: true });
        const recipes = page.recipes[device.startsWith('ipad-') ? 'ipad' : 'phone'];
        for (const filename of new Set(recipes.flatMap((recipe) => recipe.sources))) {
          linkSync(seed.path, join(raw, filename));
        }
        const presentation: TestPresentation = {
          version: 1,
          locale: captionLocaleForStore('ios', locale),
          cpp: { target, manifestSha256: manifestHash, fixtureSha256: fixtureHash },
          files: {},
        };
        for (const recipe of recipes) {
          linkSync(seed.path, join(output, recipe.output));
          const sourceMetadata = Object.fromEntries(
            recipe.sources.map((filename) => [filename, { rawBytes: seed.bytes, rawSha256: seed.hash }]),
          );
          presentation.files[recipe.output] = {
            rawBytes: seed.bytes,
            rawSha256: recipe.sources.length > 1 ? sha256ScreenshotSources(sourceMetadata) : seed.hash,
            framedSha256: seed.hash,
            ...(recipe.sources.length > 1 ? { sources: sourceMetadata } : {}),
          };
        }
        writeFileSync(join(output, 'presentation.json'), JSON.stringify(presentation));
      }
    }
  }
  return root;
}

function firstFolder(root: string, kind = 'screenshots'): string {
  return join(root, 'app-stores/apple/cpp/kilter', kind, 'en-US', 'iphone-16-pro-max');
}
function mutatePresentation(root: string, mutate: (presentation: TestPresentation) => void): void {
  const filename = join(firstFolder(root), 'presentation.json');
  const presentation = JSON.parse(readFileSync(filename, 'utf8')) as TestPresentation;
  mutate(presentation);
  writeFileSync(filename, JSON.stringify(presentation));
}
function replaceHardlink(filename: string, bytes: Buffer): void {
  // Unlink before tampering so the shared PNG seed and other tests stay intact.
  unlinkSync(filename);
  writeFileSync(filename, bytes);
}

describe('CPP screenshot upload integrity', () => {
  it('accepts all four complete targets across every locale and device', () => {
    const root = createTree(CPP_TARGETS);
    expect(assertCppScreenshots('all', root)).toBe(4 * 5 * 4 * 9);
  });

  it('rejects a missing image in the last locale/device set', () => {
    const root = createTree();
    const page = readCppPage('kilter');
    unlinkSync(
      join(root, 'app-stores/apple/cpp/kilter/screenshots/de-DE/ipad-pro-11-inch-m5', page.recipes.ipad[8].output),
    );
    expect(() => assertCppScreenshots('kilter', root)).toThrow('kilter/de-DE/ipad-pro-11-inch-m5 is incomplete');
  });

  it('rejects framed pixels changed after the presentation was generated', async () => {
    const root = createTree();
    const filename = join(firstFolder(root), readCppPage('kilter').recipes.phone[0].output);
    replaceHardlink(filename, await sharp(readFileSync(filename)).negate().png().toBuffer());
    expect(() => assertCppScreenshots('kilter', root)).toThrow('differs from its manifest');
  });

  it('rejects a changed native source even when the framed image is intact', async () => {
    const root = createTree();
    const filename = join(firstFolder(root, 'raw-screenshots'), 'hero-1.png');
    replaceHardlink(filename, await sharp(readFileSync(filename)).negate().png().toBuffer());
    expect(() => assertCppScreenshots('kilter', root)).toThrow('altered, or blank native pixels');
  });

  it.each(['manifestSha256', 'fixtureSha256'] as const)('rejects a stale %s signature', (signature) => {
    const root = createTree();
    mutatePresentation(root, (presentation) => {
      presentation.cpp[signature] = '0'.repeat(64);
    });
    expect(() => assertCppScreenshots('kilter', root)).toThrow('stale or unverified provenance');
  });

  it('rejects a composite without every original source hash', () => {
    const root = createTree();
    mutatePresentation(root, (presentation) => {
      const hero =
        presentation.files[readCppPage('kilter').recipes.phone.find((recipe) => recipe.sources.length > 1)!.output];
      delete hero.sources?.['hero-3.png'];
    });
    expect(() => assertCppScreenshots('kilter', root)).toThrow('missing composite source provenance');
  });

  it('rejects the wrong locale or target identity in otherwise complete exports', () => {
    const root = createTree();
    mutatePresentation(root, (presentation) => {
      presentation.cpp.target = 'moonboard';
    });
    expect(() => assertCppScreenshots('kilter', root)).toThrow('stale or unverified provenance');
    mutatePresentation(root, (presentation) => {
      presentation.cpp.target = 'kilter';
      presentation.locale = 'fr';
    });
    expect(() => assertCppScreenshots('kilter', root)).toThrow('stale or unverified provenance');
  });
});
