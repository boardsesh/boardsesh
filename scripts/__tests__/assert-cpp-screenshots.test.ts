import { createHash } from 'node:crypto';
import { cpSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import sharp from 'sharp';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  assertCppScreenshots,
  readCppCaptureSource,
  verifyCppCaptureCompatibility,
  CPP_SOURCE_MANIFEST,
} from '../assert-cpp-screenshots';
import {
  ACCEPTED_SIZES,
  EXPECTED_APP_STORE_DEVICE_SLUGS,
  EXPECTED_APP_STORE_LOCALES,
} from '../assert-screenshot-dimensions';
import { DEFAULT_MIN_BYTES } from '../assert-screenshot-content';
import { CPP_MANIFEST_PATH, CPP_TARGETS, readCppPage, type CppTarget } from '../lib/screenshot-cpp';
import { captionLocaleForStore, sha256ScreenshotSources } from '../lib/screenshot-presentation';
import {
  LIVE_ACTIVITY_FIXTURE_ROOT,
  loadLiveActivityFixture,
  type LiveActivityFixture,
} from '../lib/screenshot-live-activity';

interface SourceMetadata {
  rawBytes: number;
  rawSha256: string;
}
interface TestPresentation {
  version: number;
  locale: string;
  cpp: { target: string; manifestSha256: string; fixtureSha256: string };
  files: Record<
    string,
    SourceMetadata & {
      framedSha256: string;
      sources?: Record<string, SourceMetadata>;
      liveActivity?: {
        fixture: LiveActivityFixture;
        manifestSha256: string;
        outputCanvas: { width: number; height: number };
      };
    }
  >;
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
  const activityRoot = join(root, 'app-stores/apple/live-activity-captures');
  cpSync(LIVE_ACTIVITY_FIXTURE_ROOT, activityRoot, { recursive: true });
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
          if (recipe.liveActivity) {
            const native = loadLiveActivityFixture(
              recipe.liveActivity.boardFamily,
              presentation.locale as LiveActivityFixture['appLocale'],
              activityRoot,
            );
            const { width, height } = ACCEPTED_SIZES[device][0];
            presentation.files[recipe.output] = {
              rawBytes: native.pixels.length,
              rawSha256: native.provenance.sha256,
              framedSha256: seed.hash,
              liveActivity: {
                fixture: native.provenance,
                manifestSha256: native.manifestSha256,
                outputCanvas: { width, height },
              },
            };
            continue;
          }
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

describe('versioned CPP source compatibility', () => {
  const readCurrent = (path: string) => readFileSync(join(process.cwd(), path));
  const source = () => readCppCaptureSource('tension', 'a'.repeat(40), readCurrent);
  const manifest = () =>
    JSON.parse(readCurrent(CPP_SOURCE_MANIFEST).toString()) as Record<string, unknown> & {
      targets: Record<string, { recipes: { phone: Array<Record<string, unknown>> }; [key: string]: unknown }>;
    };

  it('permits another target and unused captions to change, retaining the exact original manifest digest', () => {
    const context = source();
    const prior = manifest();
    prior.targets.kilter.referenceName = 'Prior unrelated target';
    context.manifest = JSON.stringify(prior);
    const captions = JSON.parse(context.captions.fr) as Record<string, unknown>;
    captions.unused = { headline: 'Prior copy', description: 'Unused by Tension' };
    context.captions.fr = JSON.stringify(captions);
    const proof = verifyCppCaptureCompatibility('tension', context);
    expect(proof.sourceManifestSha256).toBe(digest(Buffer.from(context.manifest)));
    expect(proof.sourceManifestSha256).not.toBe(proof.currentManifestSha256);
  });

  it.each([
    'target',
    'promotional text',
    'fixture',
    'order',
    'layout',
    'sources',
    'board labels',
    'globals',
    'caption',
  ])('rejects changed %s without a hash exception', (kind) => {
    const context = source();
    const prior = manifest();
    const page = prior.targets.tension;
    if (kind === 'target') page.referenceName = 'Different page';
    if (kind === 'promotional text') page.localizations = { 'en-US': { promotionalText: 'Different promise' } };
    if (kind === 'fixture') page.fixtureReference = 'other.json';
    if (kind === 'order') page.recipes.phone.reverse();
    if (kind === 'layout') page.recipes.phone[0].layout = 'screen';
    if (kind === 'sources') page.recipes.phone[0].sources = ['other.png'];
    if (kind === 'board labels') page.recipes.phone[0].boardLabels = ['Wrong board'];
    if (kind === 'globals') prior.devices = {};
    if (kind === 'caption') {
      const catalog = JSON.parse(context.captions.es) as Record<string, { headline: string }>;
      catalog.cppTensionLayouts.headline = 'Unsupported promise';
      context.captions.es = JSON.stringify(catalog);
    }
    context.manifest = JSON.stringify(prior);
    expect(() => verifyCppCaptureCompatibility('tension', context)).toThrow();
  });

  it.each(['version', 'extra', 'target', 'sha', 'missing catalog', 'malformed manifest'])(
    'rejects malformed source context: %s',
    (kind) => {
      const context = source();
      if (kind === 'version') Object.assign(context, { version: 2 });
      if (kind === 'extra') Object.assign(context, { manifestSha256: 'b'.repeat(64) });
      if (kind === 'target') context.target = 'kilter';
      if (kind === 'sha') context.sourceSha = 'main';
      if (kind === 'missing catalog') delete context.captions.de;
      if (kind === 'malformed manifest') context.manifest = '{}';
      expect(() => verifyCppCaptureCompatibility('tension', context)).toThrow();
    },
  );

  it('validates all 180 original-source images with current guards and rejects altered native bytes', () => {
    const root = createTree(['tension']);
    const context = source();
    const prior = manifest();
    prior.targets.kilter.referenceName = 'Prior unrelated target';
    context.manifest = JSON.stringify(prior);
    for (const locale of EXPECTED_APP_STORE_LOCALES)
      for (const device of EXPECTED_APP_STORE_DEVICE_SLUGS) {
        const path = join(root, 'app-stores/apple/cpp/tension/screenshots', locale, device, 'presentation.json');
        const presentation = JSON.parse(readFileSync(path, 'utf8')) as TestPresentation;
        presentation.cpp.manifestSha256 = digest(Buffer.from(context.manifest));
        writeFileSync(path, JSON.stringify(presentation));
      }
    expect(() => assertCppScreenshots('tension', root)).toThrow('provenance');
    expect(assertCppScreenshots('tension', root, { captureSource: context })).toBe(180);
    const raw = readCppPage('tension').recipes.phone[0].sources[0];
    replaceHardlink(
      join(root, 'app-stores/apple/cpp/tension/raw-screenshots/en-US/iphone-16-pro-max', raw),
      Buffer.from('changed'),
    );
    expect(() => assertCppScreenshots('tension', root, { captureSource: context })).toThrow('native pixels');
  });

  it('retains the current required Live Activity identity guard with an explicit source', () => {
    const root = createTree();
    const context = readCppCaptureSource('kilter', 'a'.repeat(40), readCurrent);
    expect(assertCppScreenshots('kilter', root, { captureSource: context })).toBe(180);
    mutatePresentation(root, (presentation) => {
      const recipe = readCppPage('kilter').recipes.phone.find((recipe) => recipe.liveActivity)!;
      delete presentation.files[recipe.output].liveActivity;
    });
    expect(() => assertCppScreenshots('kilter', root, { captureSource: context })).toThrow('Live Activity provenance');
  });
});

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

  it.each(['hash', 'bytes', 'manifest', 'canvas', 'identity', 'missing'] as const)(
    'rejects altered Live Activity %s provenance before upload',
    (field) => {
      const root = createTree();
      mutatePresentation(root, (presentation) => {
        const output = readCppPage('kilter').recipes.phone.find((recipe) => recipe.liveActivity)!.output;
        const entry = presentation.files[output];
        if (field === 'hash') entry.rawSha256 = '0'.repeat(64);
        if (field === 'bytes') entry.rawBytes++;
        if (field === 'manifest') entry.liveActivity!.manifestSha256 = '0'.repeat(64);
        if (field === 'canvas') entry.liveActivity!.outputCanvas.width++;
        if (field === 'identity') entry.liveActivity!.fixture.content.climbName = 'Different climb';
        if (field === 'missing') delete entry.liveActivity;
      });
      expect(() => assertCppScreenshots('kilter', root)).toThrow(/native Live Activity/);
    },
  );

  it('rejects changed fixture pixels even when the framed card remains intact', () => {
    const root = createTree();
    const native = loadLiveActivityFixture('kilter', 'en-US', join(root, 'app-stores/apple/live-activity-captures'));
    writeFileSync(native.maskPath, Buffer.from('altered native fixture'));
    expect(() => assertCppScreenshots('kilter', root)).toThrow('Native Live Activity fixture hash mismatch');
  });
});
