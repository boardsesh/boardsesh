/// <reference types="node" />

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { frameShowcaseComposition, frameStoreHeader, STORE_CREATIVE_PLACEMENTS } from './frame-screenshots';
import { findOffenders } from './assert-screenshot-dimensions';
import { CPP_MANIFEST_PATH, CPP_TARGETS, isCppTarget, readCppPage, type CppTarget } from './lib/screenshot-cpp';
import {
  CAPTION_LOCALES,
  readCaptionCatalog,
  sha256Screenshot,
  type CaptionLocale,
} from './lib/screenshot-presentation';

const OPENING_SOURCES = ['00-board-view.png', '14-spray-board-view.png', '10-moonboard-board-view.png'] as const;
export const STORE_CREATIVE_VARIANTS = ['default', ...CPP_TARGETS] as const;
export type StoreCreativeVariant = 'default' | CppTarget;

export interface StoreCreativeOptions {
  input: string;
  output: string;
  device: 'iphone-16-pro' | 'iphone-16-pro-max';
  locale: CaptionLocale;
  variant?: StoreCreativeVariant;
}

/** Separate from screenshot uploads: these files belong to Asset Library placements. */
export async function renderStoreCreatives(options: StoreCreativeOptions): Promise<string[]> {
  const input = resolve(options.input);
  const variant = options.variant ?? 'default';
  const outputRoot = resolve(options.output);
  const output = join(outputRoot, variant, options.locale);
  const screenshotRoots = [
    'app-stores/apple/screenshots',
    ...CPP_TARGETS.map((target) => `app-stores/apple/cpp/${target}/screenshots`),
  ];
  if (input === outputRoot || outputRoot.startsWith(`${input}${sep}`) || input.startsWith(`${outputRoot}${sep}`))
    throw new Error('Raw captures and creative assets need separate, non-nested directories');
  if (screenshotRoots.some((root) => outputRoot === resolve(root) || outputRoot.startsWith(`${resolve(root)}${sep}`)))
    throw new Error('Header and Search Results assets must not enter the screenshot upload tree');
  const page = variant === 'default' ? undefined : readCppPage(variant);
  const opening = page?.recipes.phone.find(
    (recipe) => recipe.layout === 'store-boards' && recipe.sources.every((name) => /^hero-[1-3]\.png$/.test(name)),
  );
  if (page && (!opening || opening.sources.length !== 3))
    throw new Error('CPP needs its own three-board opening recipe');
  const sourceNames = opening?.sources ?? OPENING_SOURCES;
  const captures = sourceNames.map((name) => ({ name, buffer: readFileSync(join(input, name)) }));
  const photoPath = variant === 'spray' ? page?.primaryBoard.photo : undefined;
  if (variant === 'spray' && photoPath !== 'app-stores/apple/cpp-source-photos/lizfinal.JPG')
    throw new Error('Spray Header requires the permitted original lizfinal.JPG');
  const sprayPhoto = photoPath ? readFileSync(resolve(photoPath)) : undefined;
  const offenders = findOffenders(options.device, captures);
  for (const capture of captures) {
    if (capture.buffer.length < 61_440) offenders.push({ file: capture.name, reason: 'Raw capture is likely blank' });
  }
  if (offenders.length) throw new Error(offenders.map(({ file, reason }) => `${file}: ${reason}`).join('\n'));
  const catalog = readCaptionCatalog(options.locale);
  const caption = opening ? catalog[opening.caption] : catalog.storeBoards;
  // The native Liz Wall overlaps its permitted photograph in the foreground.
  const headerCaptures =
    variant === 'spray'
      ? [captures[1].buffer, captures[0].buffer, captures[2].buffer]
      : captures.map(({ buffer }) => buffer);
  const assets = [];
  for (const placement of ['header', 'search-results'] as const) {
    const buffer =
      placement === 'header'
        ? await frameStoreHeader(headerCaptures, { sprayPhoto })
        : await frameShowcaseComposition(
            captures.map(({ buffer }) => buffer),
            caption,
            'store-boards',
            { placement },
          );
    assets.push({ placement, buffer, file: `${placement}.png`, ...STORE_CREATIVE_PLACEMENTS[placement] });
  }
  // Complete both renders before publishing either, so a bad localized caption leaves old exports intact.
  mkdirSync(output, { recursive: true });
  for (const asset of assets) writeFileSync(join(output, asset.file), asset.buffer);
  writeFileSync(
    join(output, 'creative-assets.json'),
    `${JSON.stringify(
      {
        version: 2,
        variant,
        locale: options.locale,
        captureDevice: options.device,
        cppManifestSha256: page ? sha256Screenshot(readFileSync(CPP_MANIFEST_PATH)) : undefined,
        header: {
          textless: true,
          sourceOrder: variant === 'spray' ? [captures[1].name, captures[0].name, captures[2].name] : sourceNames,
          hero: { width: 640, centerX: 1920, top: 40 },
          sides: { width: 560, centersX: [1320, 2520], top: 100 },
          background: '#110A20',
          glow: '#7C3AED',
          cropSafeX: [1097, 2743],
          assumedOverlayY: [
            [0, 250],
            [1150, 1646],
          ],
          needsAppStoreConnectPreview: true,
        },
        photo: sprayPhoto
          ? {
              file: photoPath,
              sha256: sha256Screenshot(sprayPhoto),
              bytes: sprayPhoto.length,
              dimOpacity: 0.3,
              consent: 'User supplied for this campaign; retain the original consent record with reviewed exports.',
            }
          : undefined,
        sources: Object.fromEntries(
          captures.map(({ name, buffer }) => [name, { sha256: sha256Screenshot(buffer), bytes: buffer.length }]),
        ),
        assets: assets.map(({ placement, file, width, height, buffer }) => ({
          placement,
          file,
          width,
          height,
          sha256: sha256Screenshot(buffer),
          opaque: true,
        })),
      },
      null,
      2,
    )}\n`,
  );
  return assets.map(({ file }) => join(output, file));
}

export function parseCreativeArguments(argv: readonly string[]): StoreCreativeOptions {
  const args = argv.filter((argument) => argument !== '--');
  const flags = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const argument = args[index + 1];
    if (
      !['--input', '--output', '--device', '--locale', '--variant'].includes(flag) ||
      !argument ||
      argument.startsWith('--') ||
      flags.has(flag)
    )
      throw new Error(`Invalid creative asset argument: ${flag}`);
    flags.set(flag, argument);
  }
  const input = flags.get('--input');
  const output = flags.get('--output');
  const device = flags.get('--device');
  const locale = flags.get('--locale');
  const variant = flags.get('--variant') ?? 'default';
  if (
    !input ||
    !output ||
    (device !== 'iphone-16-pro' && device !== 'iphone-16-pro-max') ||
    !CAPTION_LOCALES.some((supported) => supported === locale) ||
    (variant !== 'default' && !isCppTarget(variant))
  )
    throw new Error(
      'Usage: store:creatives --input <native captures> --output <creative root> --device iphone-16-pro|iphone-16-pro-max --locale en-US|es|fr|de [--variant default|kilter|tension|moonboard|spray]',
    );
  return { input, output, device, locale: locale as CaptionLocale, variant: variant as StoreCreativeVariant };
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  try {
    const files = await renderStoreCreatives(parseCreativeArguments(argv));
    for (const filename of files) console.log(`[store:creatives] ${filename}`);
    return 0;
  } catch (error) {
    console.error(`[store:creatives] ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  void main().then((status) => {
    process.exitCode = status;
  });
