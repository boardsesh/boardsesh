/// <reference types="node" />

import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { findOffenders } from './assert-screenshot-dimensions';
import { DEFAULT_MIN_BYTES } from './assert-screenshot-content';
import { CPP_MANIFEST_PATH, CPP_TARGETS, isCppTarget, readCppPage, type CppSelection } from './lib/screenshot-cpp';
import { captionLocaleForStore } from './lib/screenshot-presentation';
import { readFixtureSnapshotReference } from './lib/screenshot-fixture-snapshot';

const REPO_ROOT = fileURLToPath(new URL('../', import.meta.url));
const STORE_LOCALES = ['en-US', 'es-ES', 'es-MX', 'fr-FR', 'de-DE'];
const DEVICES = ['iphone-16-pro-max', 'iphone-16-pro', 'ipad-pro-13-inch-m5', 'ipad-pro-11-inch-m5'];
const digest = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');
const object = (candidate: unknown): candidate is Record<string, unknown> =>
  typeof candidate === 'object' && candidate !== null && !Array.isArray(candidate);

/** Verify the actual native sources as well as every framed image before exposing store credentials. */
export function assertCppScreenshots(selection: CppSelection, repoRoot = REPO_ROOT): number {
  const manifestHash = digest(readFileSync(CPP_MANIFEST_PATH));
  const targets = selection === 'all' ? CPP_TARGETS : [selection];
  let screenshots = 0;
  for (const target of targets) {
    const page = readCppPage(target);
    if (!page.fixtureReference) throw new Error(`CPP ${target} has no verified fixture reference`);
    const fixture = readFixtureSnapshotReference(resolve(repoRoot, page.fixtureReference));
    for (const storeLocale of STORE_LOCALES) {
      for (const device of DEVICES) {
        const base = join(repoRoot, 'app-stores/apple/cpp', target);
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
