/// <reference types="node" />
import { appendFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isSupportedLocale } from '../packages/shared/i18n/src/config';
import { EXPECTED_APP_STORE_DEVICE_SLUGS, findOffenders } from './assert-screenshot-dimensions';
import {
  DEFAULT_MIN_BYTES,
  DEFAULT_MIN_RATIO,
  findContentOffenders,
  readBaselineSizeMap,
  readPngSizesRecursively,
} from './assert-screenshot-content';
import { resolveAppStoreLocaleTargets } from './mobile-screenshots';
import {
  IOS_CAMPAIGN_CAPTURE_NAMES,
  PRESENTATION_MANIFEST,
  readPresentationManifest,
  resolveScreenshotRecipes,
  screenshotCaptions,
} from './lib/screenshot-presentation';

/** Validate the entire selected campaign before copying any uploadable files. */
export function prepareSelectedIosScreenshots(options: {
  appLocales: readonly string[];
  source: string;
  output: string;
  baseline?: string;
}): { locales: string[]; path: string; screenshots: number } {
  const appLocales = [...new Set(options.appLocales)];
  if (!appLocales.length || !appLocales.every(isSupportedLocale))
    throw new Error('Selected screenshot upload requires supported app languages.');
  const source = resolve(options.source);
  const output = resolve(options.output);
  if (existsSync(output) || output.startsWith(`${source}/`) || source.startsWith(`${output}/`))
    throw new Error('Selected screenshot upload needs a new, separate output directory.');
  const targets = resolveAppStoreLocaleTargets(appLocales);
  const locales = targets.flatMap((target) => target.appStoreLocales);
  const baselineSizes = readBaselineSizeMap(options.baseline ?? null);
  let screenshots = 0;
  for (const { appLocale, appStoreLocales } of targets) {
    for (const storeLocale of appStoreLocales) {
      const localeRoot = join(source, storeLocale);
      if (!existsSync(localeRoot)) throw new Error(`Missing selected locale: ${storeLocale}`);
      const devices = readdirSync(localeRoot, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort();
      if (devices.join() !== [...EXPECTED_APP_STORE_DEVICE_SLUGS].sort().join())
        throw new Error(`${storeLocale} must contain every expected App Store device, with no extra device folders.`);
      for (const device of devices) {
        const directory = join(localeRoot, device);
        const names = readdirSync(directory)
          .filter((name) => name.toLowerCase().endsWith('.png'))
          .sort();
        const captures =
          device.startsWith('iphone-') && device !== 'iphone-duo'
            ? IOS_CAMPAIGN_CAPTURE_NAMES
            : Object.keys(screenshotCaptions('ios', device));
        const recipes = resolveScreenshotRecipes('ios', device, captures, appLocale);
        const expected = recipes.map((recipe) => recipe.output).sort();
        if (names.join() !== expected.join())
          throw new Error(`Incomplete selected screenshot set: ${storeLocale}/${device}`);
        const presentation = readPresentationManifest(directory);
        if (presentation.locale !== appLocale || Object.keys(presentation.files).sort().join() !== expected.join())
          throw new Error(`Selected screenshot presentation does not match ${appLocale}: ${storeLocale}/${device}`);
        for (const recipe of recipes) {
          const entry = presentation.files[recipe.output];
          const expectedSources = recipe.sources.length > 1 ? [...recipe.sources].sort() : [];
          if (
            Object.keys(entry.sources ?? {})
              .sort()
              .join() !== expectedSources.join()
          )
            throw new Error(
              `Selected screenshot sources do not match the recipe: ${storeLocale}/${device}/${recipe.output}`,
            );
          if (
            recipe.liveActivity
              ? !entry.liveActivity || entry.liveActivity.fixture.boardFamily !== recipe.liveActivity.boardFamily
              : entry.liveActivity !== undefined
          )
            throw new Error(
              `Selected screenshot Live Activity provenance does not match the recipe: ${storeLocale}/${device}/${recipe.output}`,
            );
        }
        const dimensions = findOffenders(
          device,
          names.map((name) => ({
            name: `${storeLocale}/${device}/${name}`,
            buffer: readFileSync(join(directory, name)),
          })),
        );
        if (dimensions.length)
          throw new Error(dimensions.map((offender) => `${offender.file}: ${offender.reason}`).join('\n'));
        // The existing content reader validates framed hashes and checks the
        // native source size, so decorative framing cannot hide a blank capture.
        const candidates = readPngSizesRecursively(directory).map((candidate) => ({
          ...candidate,
          relativePath: `${storeLocale}/${device}/${candidate.relativePath}`,
        }));
        const content = findContentOffenders(candidates, baselineSizes, {
          minBytes: DEFAULT_MIN_BYTES,
          minRatio: DEFAULT_MIN_RATIO,
        });
        if (content.length)
          throw new Error(content.map((offender) => `${offender.file}: ${offender.reason}`).join('\n'));
        screenshots += names.length;
      }
    }
  }
  mkdirSync(output, { recursive: true });
  for (const locale of locales) {
    // Copy only the validated images and manifests. Other localizations, raw
    // captures and contact sheets never enter the isolated upload root.
    for (const device of EXPECTED_APP_STORE_DEVICE_SLUGS) {
      const directory = join(source, locale, device);
      const destination = join(output, locale, device);
      mkdirSync(destination, { recursive: true });
      for (const name of [...Object.keys(readPresentationManifest(directory).files), PRESENTATION_MANIFEST])
        cpSync(join(directory, name), join(destination, name));
    }
  }
  return { locales, path: output, screenshots };
}

export function main(argv: readonly string[] = process.argv.slice(2)): number {
  try {
    const flags = new Map<string, string>();
    for (let index = 0; index < argv.length; index += 2) {
      const flag = argv[index];
      const argument = argv[index + 1];
      if (!['--app-locales', '--source', '--output', '--baseline'].includes(flag) || !argument)
        throw new Error(`Invalid selected screenshot argument: ${flag}`);
      flags.set(flag, argument);
    }
    const appLocales: unknown = JSON.parse(flags.get('--app-locales') ?? 'null');
    if (!Array.isArray(appLocales) || !appLocales.every((locale): locale is string => typeof locale === 'string'))
      throw new Error('--app-locales requires a JSON list of app languages.');
    const source = flags.get('--source');
    const output = flags.get('--output');
    if (!source || !output) throw new Error('--source and --output are required.');
    const prepared = prepareSelectedIosScreenshots({ appLocales, source, output, baseline: flags.get('--baseline') });
    if (process.env.GITHUB_ENV)
      appendFileSync(
        process.env.GITHUB_ENV,
        `ASC_SCREENSHOT_LOCALES=${prepared.locales.join(',')}\nASC_SCREENSHOT_PATH=${prepared.path}\n`,
      );
    console.log(`Validated ${prepared.screenshots} screenshots for ${prepared.locales.join(', ')} in ${prepared.path}`);
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = main();
