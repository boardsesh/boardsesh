/// <reference types="node" />

import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { findOffenders, readPngDimensions } from './assert-screenshot-dimensions';
import { DEFAULT_MIN_BYTES } from './assert-screenshot-content';
import {
  CPP_MANIFEST_PATH,
  CPP_TARGETS,
  isCppTarget,
  readCppPage,
  type CppSelection,
  type CppTarget,
} from './lib/screenshot-cpp';
import { canonicalJson } from './lib/screenshot-fixtures';
import { captionLocaleForStore } from './lib/screenshot-presentation';
import { readFixtureSnapshotReference } from './lib/screenshot-fixture-snapshot';
import { loadLiveActivityFixture, validateLiveActivityFixture } from './lib/screenshot-live-activity';

const REPO_ROOT = fileURLToPath(new URL('../', import.meta.url));
const STORE_LOCALES = ['en-US', 'es-ES', 'es-MX', 'fr-FR', 'de-DE'];
const DEVICES = ['iphone-16-pro-max', 'iphone-16-pro', 'ipad-pro-13-inch-m5', 'ipad-pro-11-inch-m5'];
const digest = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');
const object = (candidate: unknown): candidate is Record<string, unknown> =>
  typeof candidate === 'object' && candidate !== null && !Array.isArray(candidate);

export const CPP_SOURCE_MANIFEST = 'app-stores/apple/custom-product-pages.json';
export const CPP_CAPTION_LOCALES = ['en-US', 'es', 'fr', 'de'] as const;
/** Exact Git source bytes, constructed only after the retained producer's contract is verified. */
export interface CppCaptureSourceContext {
  version: 1;
  target: CppTarget;
  sourceSha: string;
  manifest: string;
  captions: Record<string, string>;
}

export function readCppCaptureSource(
  target: CppTarget,
  sourceSha: string,
  source: (path: string) => Buffer,
): CppCaptureSourceContext {
  if (!isCppTarget(target) || !/^[a-f\d]{40}$/.test(sourceSha)) throw new Error('Invalid CPP capture source');
  return {
    version: 1,
    target,
    sourceSha,
    manifest: source(CPP_SOURCE_MANIFEST).toString('utf8'),
    captions: Object.fromEntries(
      CPP_CAPTION_LOCALES.map((locale) => [locale, source(`app-stores/presentation/${locale}.json`).toString('utf8')]),
    ),
  };
}

/** Compatibility is scoped to one complete target; unrelated targets cannot authorize changed slots or copy. */
export function verifyCppCaptureCompatibility(
  target: CppTarget,
  context: CppCaptureSourceContext,
  currentSource: (path: string) => Buffer = (path) => readFileSync(join(REPO_ROOT, path)),
) {
  const reject = (): never => {
    throw new Error('CPP capture source is incompatible with current publication inputs');
  };
  if (
    !object(context) ||
    Object.keys(context).sort().join() !== ['version', 'target', 'sourceSha', 'manifest', 'captions'].sort().join() ||
    context.version !== 1 ||
    context.target !== target ||
    !/^[a-f\d]{40}$/.test(context.sourceSha) ||
    typeof context.manifest !== 'string' ||
    !object(context.captions) ||
    Object.keys(context.captions).sort().join() !== [...CPP_CAPTION_LOCALES].sort().join()
  )
    return reject();
  const original: unknown = JSON.parse(context.manifest);
  const currentBytes = currentSource(CPP_SOURCE_MANIFEST);
  const current: unknown = JSON.parse(currentBytes.toString('utf8'));
  if (
    !object(original) ||
    !object(current) ||
    original.version !== 1 ||
    current.version !== 1 ||
    !object(original.targets) ||
    !object(current.targets) ||
    !object(original.targets[target]) ||
    !object(current.targets[target])
  )
    return reject();
  const globals = (manifest: Record<string, unknown>) =>
    Object.fromEntries(Object.entries(manifest).filter(([key]) => key !== 'targets'));
  const currentGlobals = globals(current);
  const page = current.targets[target];
  if (
    canonicalJson(globals(original)) !== canonicalJson(currentGlobals) ||
    canonicalJson(original.targets[target]) !== canonicalJson(page) ||
    !object(page.recipes)
  )
    return reject();
  const captions = new Set<string>();
  for (const device of ['phone', 'ipad']) {
    const recipes = page.recipes[device];
    if (!Array.isArray(recipes) || recipes.length !== 9) return reject();
    for (const recipe of recipes) {
      if (!object(recipe) || typeof recipe.caption !== 'string') return reject();
      captions.add(recipe.caption);
    }
  }
  const usedCaptions: Record<string, unknown> = {};
  for (const locale of CPP_CAPTION_LOCALES) {
    if (typeof context.captions[locale] !== 'string') return reject();
    const prior: unknown = JSON.parse(context.captions[locale]);
    const catalog: unknown = JSON.parse(currentSource(`app-stores/presentation/${locale}.json`).toString('utf8'));
    if (!object(prior) || !object(catalog)) return reject();
    usedCaptions[locale] = Object.fromEntries(
      [...captions].sort().map((caption) => {
        const copy = catalog[caption];
        if (
          !object(copy) ||
          typeof copy.headline !== 'string' ||
          !copy.headline.trim() ||
          typeof copy.description !== 'string' ||
          !copy.description.trim() ||
          canonicalJson(prior[caption]) !== canonicalJson(copy)
        )
          return reject();
        return [caption, copy];
      }),
    );
  }
  return {
    version: 1,
    target,
    sourceSha: context.sourceSha,
    sourceManifestSha256: digest(Buffer.from(context.manifest)),
    currentManifestSha256: digest(currentBytes),
    targetSha256: digest(Buffer.from(canonicalJson(page))),
    globalsSha256: digest(Buffer.from(canonicalJson(currentGlobals))),
    captionsSha256: digest(Buffer.from(canonicalJson(usedCaptions))),
  };
}

/** Verify the actual native sources as well as every framed image before exposing store credentials. */
export function assertCppScreenshots(
  selection: CppSelection,
  repoRoot = REPO_ROOT,
  options: { captureSource?: CppCaptureSourceContext; inputRoot?: string } = {},
): number {
  if (options.captureSource && selection === 'all') throw new Error('Retained CPP source must select one target');
  const manifestHash = options.captureSource
    ? verifyCppCaptureCompatibility(options.captureSource.target, options.captureSource).sourceManifestSha256
    : digest(readFileSync(CPP_MANIFEST_PATH));
  if (options.captureSource && options.captureSource.target !== selection)
    throw new Error('Retained CPP source target mismatch');
  const inputRoot = options.inputRoot ?? repoRoot;
  const targets = selection === 'all' ? CPP_TARGETS : [selection];
  let screenshots = 0;
  for (const target of targets) {
    const page = readCppPage(target);
    if (!page.fixtureReference) throw new Error(`CPP ${target} has no verified fixture reference`);
    const fixture = readFixtureSnapshotReference(resolve(inputRoot, page.fixtureReference));
    for (const storeLocale of STORE_LOCALES) {
      for (const device of DEVICES) {
        const base = join(inputRoot, 'app-stores/apple/cpp', target);
        const folder = join(base, 'screenshots', storeLocale, device);
        const rawFolder = join(base, 'raw-screenshots', storeLocale, device);
        const recipes = page.recipes[device.startsWith('ipad-') ? 'ipad' : 'phone'];
        const actual = readdirSync(folder)
          .filter((filename) => filename.endsWith('.png'))
          .sort();
        const expected = recipes.map(({ output }) => output).sort();
        if (actual.join('\n') !== expected.join('\n'))
          throw new Error(`CPP ${target}/${storeLocale}/${device} is incomplete`);
        const presentation: unknown = JSON.parse(readFileSync(join(folder, 'presentation.json'), 'utf8'));
        if (
          !object(presentation) ||
          presentation.version !== 1 ||
          presentation.locale !== captionLocaleForStore('ios', storeLocale) ||
          !object(presentation.cpp) ||
          presentation.cpp.target !== target ||
          presentation.cpp.manifestSha256 !== manifestHash ||
          presentation.cpp.fixtureSha256 !== fixture.sha256 ||
          !object(presentation.files)
        )
          throw new Error(`CPP ${target}/${storeLocale}/${device} has stale or unverified provenance`);
        const pngs = recipes.map((recipe) => {
          const buffer = readFileSync(join(folder, recipe.output));
          const metadata = (presentation.files as Record<string, unknown>)[recipe.output];
          if (!object(metadata) || metadata.framedSha256 !== digest(buffer))
            throw new Error(`CPP ${target}/${storeLocale}/${device}/${recipe.output} differs from its manifest`);
          if (recipe.liveActivity) {
            const locale = captionLocaleForStore('ios', storeLocale);
            const native = loadLiveActivityFixture(
              recipe.liveActivity.boardFamily,
              locale,
              join(repoRoot, 'app-stores/apple/live-activity-captures'),
            );
            const activity = metadata.liveActivity;
            const canvas = readPngDimensions(buffer);
            if (
              !object(activity) ||
              activity.manifestSha256 !== native.manifestSha256 ||
              !object(activity.outputCanvas) ||
              activity.outputCanvas.width !== canvas.width ||
              activity.outputCanvas.height !== canvas.height ||
              metadata.rawSha256 !== native.provenance.sha256 ||
              metadata.rawBytes !== native.pixels.length ||
              metadata.sources !== undefined
            )
              throw new Error(`CPP ${target}/${recipe.output} has altered or missing native Live Activity provenance`);
            const presentedFixture = validateLiveActivityFixture(
              activity.fixture,
              recipe.liveActivity.boardFamily,
              locale,
            );
            if (JSON.stringify(presentedFixture) !== JSON.stringify(native.provenance))
              throw new Error(`CPP ${target}/${recipe.output} has altered native Live Activity identity`);
            return { name: recipe.output, buffer };
          }
          const sources = recipe.sources.length > 1 ? metadata.sources : { [recipe.sources[0]]: metadata };
          if (!object(sources) || Object.keys(sources).sort().join('\n') !== [...recipe.sources].sort().join('\n'))
            throw new Error(`CPP ${target}/${recipe.output} is missing composite source provenance`);
          for (const filename of recipe.sources) {
            const raw = readFileSync(join(rawFolder, filename));
            const source = sources[filename];
            if (
              !object(source) ||
              source.rawSha256 !== digest(raw) ||
              source.rawBytes !== raw.length ||
              raw.length < DEFAULT_MIN_BYTES
            )
              throw new Error(
                `CPP ${target}/${storeLocale}/${device}/${filename} has missing, altered, or blank native pixels`,
              );
            const rawOffenders = findOffenders(device, [{ name: filename, buffer: raw }]);
            if (rawOffenders.length)
              throw new Error(rawOffenders.map(({ file, reason }) => `${file}: ${reason}`).join('\n'));
          }
          return { name: recipe.output, buffer };
        });
        const offenders = findOffenders(device, pngs);
        if (offenders.length) throw new Error(offenders.map(({ file, reason }) => `${file}: ${reason}`).join('\n'));
        screenshots += pngs.length;
      }
    }
  }
  return screenshots;
}

export function main(argv = process.argv.slice(2)): number {
  try {
    const args = argv.filter((argument) => argument !== '--');
    const target = args[1];
    if (args.length !== 2 || args[0] !== '--target' || (target !== 'all' && !isCppTarget(target)))
      throw new Error(
        'Usage: vp exec tsx scripts/assert-cpp-screenshots.ts --target kilter|tension|moonboard|spray|all',
      );
    console.log(`Verified ${assertCppScreenshots(target)} CPP screenshots and their native sources`);
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = main();
