/// <reference types="node" />

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import sharp from 'sharp';
import { brandColorsDark, materialSurfaces } from '../packages/shared/velvet-tokens/src/index';
import { findGooglePlayOffenders, findOffenders, readPngDimensions } from './assert-screenshot-dimensions';
import {
  PRESENTATION_MANIFEST,
  PRESENTATION_ROOT,
  PRESENTATION_VERSION,
  STORE_CAPTION_LOCALES,
  readCaptionCatalog,
  screenshotCaptions,
  sha256Screenshot,
  type CaptionLocale,
  type PresentationManifest,
  type ScreenshotCaption,
} from './lib/screenshot-presentation';

const LOG = '[screenshot:frame]';
const COLORS = materialSurfaces.dark;
const MIN_RAW_BYTES = 61_440;

function escapeMarkup(text: string): string {
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
}

async function renderText(text: string, size: number, width: number, color: string, bold = false) {
  return sharp({
    text: {
      text: `<span foreground="${color}">${escapeMarkup(text)}</span>`,
      font: `Roboto ${bold ? 'Bold ' : ''}${size}`,
      fontfile: join(PRESENTATION_ROOT, 'fonts', `Roboto-${bold ? 'Bold' : 'Regular'}.ttf`),
      width,
      dpi: 72,
      rgba: true,
      wrap: 'word',
      spacing: Math.round(size * 0.15),
    },
  })
    .png()
    .toBuffer({ resolveWithObject: true });
}

/** Fit the whole native screen; all explanatory copy stays outside its pixels. */
export async function frameScreenshot(raw: Buffer, caption: ScreenshotCaption): Promise<Buffer> {
  const { width, height } = readPngDimensions(raw);
  const unit = Math.min(width, height * 0.8);
  const margin = Math.round(width * 0.065);
  const textWidth = width - margin * 2;
  const top = Math.round(height * 0.035);
  const wordmark = await renderText('Boardsesh', Math.round(unit * 0.026), textWidth, brandColorsDark.tint, true);
  const headline = await renderText(
    caption.headline,
    Math.round(unit * (width > height ? 0.067 : 0.083)),
    textWidth,
    COLORS.label,
    true,
  );
  const description = await renderText(
    caption.description,
    Math.round(unit * (width > height ? 0.031 : 0.036)),
    textWidth,
    COLORS.secondaryLabel,
  );
  const headlineTop = top + wordmark.info.height + Math.round(height * 0.025);
  const descriptionTop = headlineTop + headline.info.height + Math.round(height * 0.012);
  const screenshotTop = Math.round(height * 0.275);
  if (
    headline.info.width > textWidth ||
    description.info.width > textWidth ||
    descriptionTop + description.info.height > screenshotTop - height * 0.022
  ) {
    throw new Error(`Caption overflows ${width}×${height}: ${caption.headline}`);
  }

  const scale = Math.min((width - margin * 2) / width, (height * 0.96 - screenshotTop) / height);
  const screenWidth = Math.floor(width * scale);
  const screenHeight = Math.floor(height * scale);
  const screenLeft = Math.floor((width - screenWidth) / 2);
  const radius = Math.round(unit * 0.025);
  const border = Math.max(2, Math.round(unit * 0.002));
  const background = Buffer.from(`<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
    <defs><linearGradient id="background" x2="0" y2="1"><stop stop-color="${COLORS.secondaryBackground}"/><stop offset="1" stop-color="${COLORS.background}"/></linearGradient></defs>
    <rect width="100%" height="100%" fill="url(#background)"/>
    <rect x="${screenLeft - border}" y="${screenshotTop - border}" width="${screenWidth + border * 2}" height="${screenHeight + border * 2}" rx="${radius + border}" fill="${brandColorsDark.tint}" fill-opacity="0.32"/>
  </svg>`);
  const mask = Buffer.from(
    `<svg width="${screenWidth}" height="${screenHeight}" xmlns="http://www.w3.org/2000/svg"><rect width="100%" height="100%" rx="${radius}" fill="white"/></svg>`,
  );
  const screenshot = await sharp(raw)
    .resize(screenWidth, screenHeight, { fit: 'fill', kernel: 'lanczos3' })
    .composite([{ input: mask, blend: 'dest-in' }])
    .png()
    .toBuffer();
  const shadow = await sharp({
    create: { width: screenWidth + 60, height: screenHeight + 60, channels: 4, background: '#00000000' },
  })
    .composite([
      {
        input: Buffer.from(
          `<svg width="${screenWidth}" height="${screenHeight}" xmlns="http://www.w3.org/2000/svg"><rect width="100%" height="100%" rx="${radius}" fill="black" fill-opacity="0.35"/></svg>`,
        ),
        left: 30,
        top: 30,
      },
    ])
    .blur(12)
    .png()
    .toBuffer();
  return sharp(background)
    .composite([
      { input: wordmark.data, left: margin, top },
      { input: headline.data, left: margin, top: headlineTop },
      { input: description.data, left: margin, top: descriptionTop },
      { input: shadow, left: screenLeft - 30, top: screenshotTop - 20 },
      { input: screenshot, left: screenLeft, top: screenshotTop },
    ])
    .flatten({ background: COLORS.background })
    .removeAlpha()
    .png({ compressionLevel: 9 })
    .toBuffer();
}

export interface FrameDirectoryOptions {
  platform: 'ios' | 'android';
  device: string;
  locale: CaptionLocale;
  input: string;
  output: string;
}

export async function frameDirectory(options: FrameDirectoryOptions): Promise<string[]> {
  const input = resolve(options.input);
  const output = resolve(options.output);
  if (input === output || output.startsWith(`${input}${sep}`) || input.startsWith(`${output}${sep}`)) {
    throw new Error('Raw and framed screenshot directories must be separate, non-nested directories.');
  }
  if (existsSync(join(input, PRESENTATION_MANIFEST))) throw new Error(`Input is already framed: ${input}`);
  const mapping = screenshotCaptions(options.platform, options.device);
  const names = readdirSync(input)
    .filter((name) => name.toLowerCase().endsWith('.png'))
    .sort();
  const expected = Object.keys(mapping).sort();
  if (names.join('\n') !== expected.join('\n')) {
    throw new Error(
      `Incomplete or unknown screenshot set in ${input}. Expected ${expected.join(', ')}; found ${names.join(', ')}.`,
    );
  }
  const captures = names.map((name) => ({ name, buffer: readFileSync(join(input, name)) }));
  const offenders =
    options.platform === 'ios'
      ? findOffenders(options.device, captures)
      : findGooglePlayOffenders(options.device, captures);
  for (const capture of captures) {
    if (capture.buffer.length < MIN_RAW_BYTES) {
      offenders.push({ file: capture.name, reason: `raw capture is under ${MIN_RAW_BYTES} bytes; likely blank` });
    }
  }
  if (offenders.length) throw new Error(offenders.map(({ file, reason }) => `${file}: ${reason}`).join('\n'));
  const catalog = readCaptionCatalog(options.locale);
  mkdirSync(dirname(output), { recursive: true });
  const staging = mkdtempSync(join(dirname(output), '.framing-'));
  const manifest: PresentationManifest = { version: PRESENTATION_VERSION, locale: options.locale, files: {} };
  try {
    for (const { name, buffer } of captures) {
      const framed = await frameScreenshot(buffer, catalog[mapping[name]]);
      writeFileSync(join(staging, name), framed);
      manifest.files[name] = {
        rawBytes: buffer.length,
        rawSha256: sha256Screenshot(buffer),
        framedSha256: sha256Screenshot(framed),
      };
    }
    writeFileSync(join(staging, PRESENTATION_MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`);
    // Build a review artifact outside the PNG upload set.
    const thumbnails = await Promise.all(
      names.map((name) => sharp(join(staging, name)).resize({ width: 270 }).toBuffer({ resolveWithObject: true })),
    );
    const columns = Math.min(4, thumbnails.length);
    const cellWidth = 290;
    const cellHeight = Math.max(...thumbnails.map((thumbnail) => thumbnail.info.height)) + 20;
    await sharp({
      create: {
        width: cellWidth * columns,
        height: cellHeight * Math.ceil(names.length / columns),
        channels: 3,
        background: COLORS.background,
      },
    })
      .composite(
        thumbnails.map((thumbnail, index) => ({
          input: thumbnail.data,
          left: (index % columns) * cellWidth + 10,
          top: Math.floor(index / columns) * cellHeight + 10,
        })),
      )
      .jpeg({ quality: 90 })
      .toFile(join(staging, 'contact-sheet.jpg'));
    mkdirSync(output, { recursive: true });
    // Validate everything before replacing any previously generated store image.
    for (const name of readdirSync(output)) {
      if (name.toLowerCase().endsWith('.png') && !names.includes(name)) rmSync(join(output, name));
    }
    for (const name of [...names, PRESENTATION_MANIFEST, 'contact-sheet.jpg'])
      renameSync(join(staging, name), join(output, name));
    return names.map((name) => join(output, name));
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

export function parseFrameArguments(argv: readonly string[]): {
  platform: 'ios' | 'android';
  input: string;
  output: string;
  device?: string;
  locale?: CaptionLocale;
} {
  const args = argv.filter((argument) => argument !== '--');
  const flags = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const argument = args[index + 1];
    if (
      !['--platform', '--input', '--output', '--device', '--locale'].includes(flag) ||
      !argument ||
      argument.startsWith('--') ||
      flags.has(flag)
    ) {
      throw new Error(`Invalid screenshot framing argument: ${flag}`);
    }
    flags.set(flag, argument);
  }
  const platform = flags.get('--platform');
  const input = flags.get('--input');
  const output = flags.get('--output');
  if ((platform !== 'ios' && platform !== 'android') || !input || !output) {
    throw new Error(
      'Usage: screenshot:frame --platform ios|android --input <raw tree> --output <store tree> [--device <slug> --locale en-US|es|fr|de]',
    );
  }
  const locale = flags.get('--locale');
  if (locale && !['en-US', 'es', 'fr', 'de'].includes(locale)) throw new Error(`Unsupported caption locale: ${locale}`);
  if (flags.has('--device') && platform === 'ios' && !locale)
    throw new Error('--locale is required for a single iOS device directory');
  return {
    platform,
    input: resolve(input),
    output: resolve(output),
    device: flags.get('--device'),
    locale: locale as CaptionLocale | undefined,
  };
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  try {
    const options = parseFrameArguments(argv);
    const groups: FrameDirectoryOptions[] = [];
    if (options.device) groups.push({ ...options, device: options.device, locale: options.locale ?? 'en-US' });
    else {
      const discover = (directory: string): void => {
        const entries = readdirSync(directory, { withFileTypes: true });
        if (entries.some((entry) => entry.isFile() && entry.name.endsWith('.png'))) {
          const parts = relative(options.input, directory).split(sep);
          const locale = options.platform === 'android' ? 'en-US' : STORE_CAPTION_LOCALES[parts[0]];
          if (!locale || parts.length !== (options.platform === 'ios' ? 2 : 1))
            throw new Error(`Unrecognized raw screenshot directory: ${directory}`);
          groups.push({
            platform: options.platform,
            device: basename(directory),
            locale,
            input: directory,
            output: join(options.output, ...parts),
          });
        }
        for (const entry of entries) if (entry.isDirectory()) discover(join(directory, entry.name));
      };
      discover(options.input);
    }
    if (!groups.length) throw new Error(`No screenshots in ${options.input}`);
    for (const group of groups) {
      const saved = await frameDirectory(group);
      console.log(
        `${LOG} ${group.locale}/${group.device}: ${saved.length} framed screenshots; ${join(group.output, 'contact-sheet.jpg')}`,
      );
    }
    return 0;
  } catch (error) {
    console.error(`${LOG} ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main().then((status) => {
    process.exitCode = status;
  });
}
