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
import { brandColors, brandColorsDark, materialSurfaces } from '../packages/shared/velvet-tokens/src/index';
import { findGooglePlayOffenders, findOffenders, readPngDimensions } from './assert-screenshot-dimensions';
import {
  CAPTION_LOCALES,
  PRESENTATION_MANIFEST,
  PRESENTATION_ROOT,
  PRESENTATION_VERSION,
  STORE_CAPTION_LOCALES,
  readCaptionCatalog,
  resolveScreenshotRecipes,
  sha256Screenshot,
  sha256ScreenshotSources,
  type CaptionLocale,
  type PresentationManifest,
  type ScreenshotCaption,
  type ScreenshotLayout,
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
      spacing: bold ? -Math.round(size * 0.12) : 0,
    },
  })
    .png()
    .toBuffer({ resolveWithObject: true });
}

/** Keep native pixels intact; explanatory copy always sits outside the captures. */
export async function frameScreenshot(raw: Buffer, caption: ScreenshotCaption): Promise<Buffer> {
  return frameComposition([raw], caption, 'screen');
}

interface NativePanel {
  raw: Buffer;
  left: number;
  top: number;
  width: number;
  /** A full-width detail from the real capture, kept as a separate panel. */
  crop?: { top: number; height: number };
}

async function renderNativePanel(panel: NativePanel, unit: number): Promise<Buffer> {
  const dimensions = readPngDimensions(panel.raw);
  const sourceTop = panel.crop ? Math.round(dimensions.height * panel.crop.top) : 0;
  const sourceHeight = panel.crop ? Math.round(dimensions.height * panel.crop.height) : dimensions.height;
  const width = Math.round(panel.width);
  const height = Math.round((width * sourceHeight) / dimensions.width);
  const radius = Math.round(unit * 0.025);
  const border = Math.max(2, Math.round(unit * 0.002));
  const mask = Buffer.from(
    `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg"><rect width="100%" height="100%" rx="${radius}" fill="white"/></svg>`,
  );
  const capture = await sharp(panel.raw)
    .extract({ left: 0, top: sourceTop, width: dimensions.width, height: sourceHeight })
    .resize(width, height, { kernel: 'lanczos3' })
    .composite([{ input: mask, blend: 'dest-in' }])
    .png()
    .toBuffer();
  const surface =
    Buffer.from(`<svg width="${width + border * 2}" height="${height + border * 2 + 8}" xmlns="http://www.w3.org/2000/svg">
    <rect y="8" width="100%" height="${height + border * 2}" rx="${radius + border}" fill="#000000" fill-opacity="0.3"/>
    <rect width="100%" height="${height + border * 2}" rx="${radius + border}" fill="${brandColorsDark.tint}" fill-opacity="0.55"/>
  </svg>`);
  return sharp(surface)
    .composite([{ input: capture, left: border, top: border }])
    .png()
    .toBuffer();
}

/** Compose only actual captures. Overlap/canvas crops never replace or invent app content. */
export async function frameComposition(
  sources: readonly Buffer[],
  caption: ScreenshotCaption,
  layout: ScreenshotLayout,
): Promise<Buffer> {
  if (
    ((layout === 'screen' || layout === 'wall-status') && sources.length !== 1) ||
    (layout === 'board-family' && sources.length !== 2 && sources.length !== 3) ||
    (layout === 'more-boards' && sources.length !== 3) ||
    (layout === 'live-climb' && sources.length !== 2)
  ) {
    throw new Error(`Invalid native source count for ${layout}: ${sources.length}`);
  }
  const { width, height } = readPngDimensions(sources[0]);
  const light = layout === 'live-climb' || layout === 'wall-status';
  const colors = light ? materialSurfaces.light : COLORS;
  const tint = light ? brandColors.tint : brandColorsDark.tint;
  const unit = Math.min(width, height * 0.8);
  const margin = Math.round(width * 0.065);
  const textWidth = width - margin * 2;
  const top = Math.round(height * 0.035);
  const wordmark = await renderText('Boardsesh', Math.round(unit * 0.026), textWidth, tint, true);
  const headline = await renderText(
    caption.headline,
    Math.round(unit * (width > height ? 0.067 : 0.078)),
    textWidth,
    colors.label,
    true,
  );
  const description = await renderText(
    caption.description,
    Math.round(unit * (width > height ? 0.031 : 0.036)),
    textWidth,
    colors.secondaryLabel,
  );
  const headlineTop = top + wordmark.info.height + Math.round(height * 0.018);
  const descriptionTop = headlineTop + headline.info.height + Math.round(height * 0.013);
  const descriptionBottom = descriptionTop + description.info.height;
  // Brand product names stay untranslated. Only name hardware represented by a real source capture.
  const boardNames =
    layout === 'board-family'
      ? await renderText(
          sources.length === 3 ? 'Tension · Kilter · MoonBoard 2016' : 'Tension · Kilter',
          Math.round(unit * 0.029),
          textWidth,
          tint,
          true,
        )
      : undefined;
  const boardNamesTop = descriptionBottom + Math.round(height * 0.018);
  const copyBottom = boardNames ? boardNamesTop + boardNames.info.height : descriptionBottom;
  if (headline.info.width > textWidth || description.info.width > textWidth || copyBottom > height * 0.3) {
    throw new Error(`Caption overflows ${width}×${height}: ${caption.headline}`);
  }
  const screenshotTop = Math.round(Math.max(height * 0.215, copyBottom + height * 0.038));
  const panels: NativePanel[] = [];
  if (layout === 'screen') {
    const scale = Math.min((width - margin * 2) / width, (height * 0.96 - screenshotTop) / height);
    const panelWidth = Math.floor(width * scale);
    panels.push({ raw: sources[0], left: Math.floor((width - panelWidth) / 2), top: screenshotTop, width: panelWidth });
  } else if (layout === 'wall-status') {
    // The actual Android rail occupies y270–418 in the 1080×1920 capture.
    // Enlarge those pixels separately; retain the complete native screen below
    // so the different locally selected climb remains visible in its context.
    const crop = { top: 270 / 1920, height: 148 / 1920 };
    const railHeight = Math.round((textWidth * height * crop.height) / width);
    const screenTop = screenshotTop + railHeight + Math.round(height * 0.028);
    const scale = Math.min(textWidth / width, (height * 0.96 - screenTop) / height);
    const panelWidth = Math.floor(width * scale);
    panels.push(
      { raw: sources[0], left: margin, top: screenshotTop, width: textWidth, crop },
      { raw: sources[0], left: Math.floor((width - panelWidth) / 2), top: screenTop, width: panelWidth },
    );
  } else if (layout === 'live-climb') {
    // These two separate detail cards come from the captured Android session UI:
    // its header/participants and its persistent current-climb bar. Keep their
    // native pixels together inside each card; never reconstruct app controls.
    panels.push(
      { raw: sources[1], left: margin, top: screenshotTop, width: textWidth, crop: { top: 0.065, height: 0.14 } },
      { raw: sources[0], left: width * 0.14, top: screenshotTop + height * 0.11, width: width * 0.72 },
      { raw: sources[1], left: margin, top: height * 0.89, width: textWidth, crop: { top: 0.793, height: 0.067 } },
    );
  } else if ((layout === 'board-family' || layout === 'more-boards') && sources.length === 3) {
    // Leave the upper holds of both rear boards visible, including their lit holds.
    // Every phone fits horizontally; the foreground board remains complete.
    panels.push(
      { raw: sources[0], left: width * 0.015, top: screenshotTop, width: width * 0.48 },
      { raw: sources[2], left: width * 0.505, top: screenshotTop, width: width * 0.48 },
      { raw: sources[1], left: width * 0.23, top: screenshotTop + height * 0.215, width: width * 0.54 },
    );
  } else {
    // Two real screens, staggered enough to keep both climb titles visible.
    panels.push(
      { raw: sources[0], left: width * 0.025, top: screenshotTop, width: width * 0.56 },
      { raw: sources[1], left: width * 0.405, top: screenshotTop + height * 0.13, width: width * 0.565 },
    );
  }
  const background = Buffer.from(`<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
    <defs><linearGradient id="background" x2="0" y2="1"><stop stop-color="${colors.secondaryBackground}"/><stop offset="1" stop-color="${colors.background}"/></linearGradient></defs>
    <rect width="100%" height="100%" fill="url(#background)"/>
  </svg>`);
  const layers: sharp.OverlayOptions[] = [
    { input: wordmark.data, left: margin, top },
    { input: headline.data, left: margin, top: headlineTop },
    { input: description.data, left: margin, top: descriptionTop },
  ];
  if (boardNames) layers.push({ input: boardNames.data, left: margin, top: boardNamesTop });
  for (const panel of panels) {
    const rendered = await renderNativePanel(panel, unit);
    const metadata = await sharp(rendered).metadata();
    const left = Math.round(panel.left);
    const panelTop = Math.round(panel.top);
    const cropLeft = Math.max(0, -left);
    const cropTop = Math.max(0, -panelTop);
    const cropWidth = Math.min(metadata.width! - cropLeft, width - Math.max(0, left));
    const cropHeight = Math.min(metadata.height! - cropTop, height - Math.max(0, panelTop));
    const clipped = await sharp(rendered)
      .extract({ left: cropLeft, top: cropTop, width: cropWidth, height: cropHeight })
      .png()
      .toBuffer();
    layers.push({ input: clipped, left: Math.max(0, left), top: Math.max(0, panelTop) });
  }
  return sharp(background)
    .composite(layers)
    .flatten({ background: colors.background })
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
  const names = readdirSync(input)
    .filter((name) => name.toLowerCase().endsWith('.png'))
    .sort();
  const recipes = resolveScreenshotRecipes(options.platform, options.device, names);
  const outputNames = recipes.map((recipe) => recipe.output);
  const captures = names.map((name) => ({ name, buffer: readFileSync(join(input, name)) }));
  const offenders =
    options.platform === 'ios'
      ? findOffenders(options.device, captures)
      : // A recipe has eight final images but can need up to 14 native captures.
        // Each source still passes the same dimension gate, in batches within Play's count limit.
        [captures.slice(0, 6), captures.slice(6)].flatMap((batch) => findGooglePlayOffenders(options.device, batch));
  for (const capture of captures) {
    if (capture.buffer.length < MIN_RAW_BYTES) {
      offenders.push({ file: capture.name, reason: `raw capture is under ${MIN_RAW_BYTES} bytes; likely blank` });
    }
  }
  if (offenders.length) throw new Error(offenders.map(({ file, reason }) => `${file}: ${reason}`).join('\n'));
  const catalog = readCaptionCatalog(options.locale);
  const capturesByName = new Map(captures.map((capture) => [capture.name, capture.buffer]));
  mkdirSync(dirname(output), { recursive: true });
  const staging = mkdtempSync(join(dirname(output), '.framing-'));
  const manifest: PresentationManifest = { version: PRESENTATION_VERSION, locale: options.locale, files: {} };
  try {
    const thumbnails: Array<{ data: Buffer; info: sharp.OutputInfo }> = [];
    for (const recipe of recipes) {
      const name = recipe.output;
      const buffers = recipe.sources.map((source) => capturesByName.get(source)!);
      const framed = await frameComposition(buffers, catalog[recipe.caption], recipe.layout);
      writeFileSync(join(staging, name), framed);
      thumbnails.push(await sharp(framed).resize({ width: 270 }).toBuffer({ resolveWithObject: true }));
      const sourceMetadata = Object.fromEntries(
        recipe.sources.map((source, index) => [
          source,
          {
            rawBytes: buffers[index].length,
            rawSha256: sha256Screenshot(buffers[index]),
          },
        ]),
      );
      manifest.files[name] = {
        rawBytes: Math.min(...buffers.map((buffer) => buffer.length)),
        rawSha256: buffers.length === 1 ? sha256Screenshot(buffers[0]) : sha256ScreenshotSources(sourceMetadata),
        framedSha256: sha256Screenshot(framed),
        ...(buffers.length > 1 ? { sources: sourceMetadata } : {}),
      };
    }
    writeFileSync(join(staging, PRESENTATION_MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`);
    // Build a review artifact outside the PNG upload set.
    const columns = Math.min(4, thumbnails.length);
    const cellWidth = 290;
    const cellHeight = Math.max(...thumbnails.map((thumbnail) => thumbnail.info.height)) + 20;
    await sharp({
      create: {
        width: cellWidth * columns,
        height: cellHeight * Math.ceil(outputNames.length / columns),
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
      if (name.toLowerCase().endsWith('.png') && !outputNames.includes(name)) rmSync(join(output, name));
    }
    for (const name of [...outputNames, PRESENTATION_MANIFEST, 'contact-sheet.jpg'])
      renameSync(join(staging, name), join(output, name));
    return outputNames.map((name) => join(output, name));
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
  if (locale && !CAPTION_LOCALES.some((supportedLocale) => supportedLocale === locale))
    throw new Error(`Unsupported caption locale: ${locale}`);
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
