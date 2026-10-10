/// <reference types="node" />

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { frameShowcaseComposition, STORE_CREATIVE_PLACEMENTS } from './frame-screenshots';
import { findOffenders } from './assert-screenshot-dimensions';
import {
  CAPTION_LOCALES,
  readCaptionCatalog,
  sha256Screenshot,
  type CaptionLocale,
} from './lib/screenshot-presentation';

const OPENING_SOURCES = ['00-board-view.png', '14-spray-board-view.png', '10-moonboard-board-view.png'] as const;

export interface StoreCreativeOptions {
  input: string;
  output: string;
  device: 'iphone-16-pro' | 'iphone-16-pro-max';
  locale: CaptionLocale;
}

/** Separate from screenshot uploads: these files belong to Asset Library placements. */
export async function renderStoreCreatives(options: StoreCreativeOptions): Promise<string[]> {
  const input = resolve(options.input);
  const output = resolve(options.output);
  const screenshots = resolve('app-stores/apple/screenshots');
  if (input === output || output.startsWith(`${input}${sep}`) || input.startsWith(`${output}${sep}`))
    throw new Error('Raw captures and creative assets need separate, non-nested directories');
  if (output === screenshots || output.startsWith(`${screenshots}${sep}`))
    throw new Error('Header and Search Results assets must not enter the screenshot upload tree');
  const captures = OPENING_SOURCES.map((name) => ({ name, buffer: readFileSync(join(input, name)) }));
  const offenders = findOffenders(options.device, captures);
  for (const capture of captures) {
    if (capture.buffer.length < 61_440) offenders.push({ file: capture.name, reason: 'Raw capture is likely blank' });
  }
  if (offenders.length) throw new Error(offenders.map(({ file, reason }) => `${file}: ${reason}`).join('\n'));
  const catalog = readCaptionCatalog(options.locale);
  const caption = catalog.storeBoards;
  const assets = [];
  for (const placement of ['header', 'search-results'] as const) {
    const buffer = await frameShowcaseComposition(
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
        version: 1,
        locale: options.locale,
        captureDevice: options.device,
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
      !['--input', '--output', '--device', '--locale'].includes(flag) ||
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
  if (
    !input ||
    !output ||
    (device !== 'iphone-16-pro' && device !== 'iphone-16-pro-max') ||
    !CAPTION_LOCALES.some((supported) => supported === locale)
  )
    throw new Error(
      'Usage: store:creatives --input <native captures> --output <creative directory> --device iphone-16-pro|iphone-16-pro-max --locale en-US|es|fr|de',
    );
  return { input, output, device, locale: locale as CaptionLocale };
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
