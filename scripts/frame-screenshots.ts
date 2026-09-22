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
import {
  findGooglePlayImageOffenders,
  findGooglePlayOffenders,
  findOffenders,
  readPngDimensions,
} from './assert-screenshot-dimensions';
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

type MaterialSurface = (typeof materialSurfaces)[keyof typeof materialSurfaces];

/**
 * The iPad shell's trailing "Now on the wall" column is 300 points wide
 * (`WALL_COLUMN_WIDTH`, packages/mobile/src/theme/size-class.ts) and every iPad
 * capture is @2x, so its share of a capture is 600px / capture width: 21.8% on
 * the 13" slot, 24.8% on the 11". One expression covers both devices — unlike
 * the Android rail crop, which is pinned to a single resolution.
 */
const IPAD_WALL_COLUMN_PIXELS = 300 * 2;

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
  /**
   * A detail from the real capture, kept as a separate panel. Fractions of the
   * source, so one recipe serves every capture size. `top`/`height` alone take a
   * full-width band (the Android wall rail); adding `left`/`width` takes a
   * vertical slice instead (the iPad wall column on the trailing edge).
   */
  crop?: { top: number; height: number; left?: number; width?: number };
}

async function renderNativePanel(panel: NativePanel, unit: number): Promise<Buffer> {
  const dimensions = readPngDimensions(panel.raw);
  const sourceTop = panel.crop ? Math.round(dimensions.height * panel.crop.top) : 0;
  const sourceHeight = panel.crop ? Math.round(dimensions.height * panel.crop.height) : dimensions.height;
  const sourceLeft = panel.crop?.left ? Math.round(dimensions.width * panel.crop.left) : 0;
  const sourceWidth = panel.crop?.width
    ? Math.min(Math.round(dimensions.width * panel.crop.width), dimensions.width - sourceLeft)
    : dimensions.width;
  const width = Math.round(panel.width);
  const height = Math.round((width * sourceHeight) / sourceWidth);
  const radius = Math.round(unit * 0.025);
  const border = Math.max(2, Math.round(unit * 0.002));
  const mask = Buffer.from(
    `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg"><rect width="100%" height="100%" rx="${radius}" fill="white"/></svg>`,
  );
  const capture = await sharp(panel.raw)
    .extract({ left: sourceLeft, top: sourceTop, width: sourceWidth, height: sourceHeight })
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
    ((layout === 'screen' || layout === 'wall-status' || layout === 'wall-column') && sources.length !== 1) ||
    (layout === 'board-family' && sources.length !== 2 && sources.length !== 3) ||
    ((layout === 'more-boards' || layout === 'cross-board-logbook') && sources.length !== 3) ||
    (layout === 'live-climb' && sources.length !== 2)
  ) {
    throw new Error(`Invalid native source count for ${layout}: ${sources.length}`);
  }
  const { width, height } = readPngDimensions(sources[0]);
  // iPad ships landscape. A 4:3 canvas has no room for a copy band above a 4:3
  // capture, so the copy moves into a left column beside it.
  if (width > height) return frameLandscape(sources, caption, layout, width, height);
  const light = layout === 'live-climb' || layout === 'wall-status' || layout === 'wall-column';
  const colors = light ? materialSurfaces.light : COLORS;
  const tint = light ? brandColors.tint : brandColorsDark.tint;
  const unit = Math.min(width, height * 0.8);
  const margin = Math.round(width * 0.065);
  const textWidth = width - margin * 2;
  const top = Math.round(height * 0.035);
  const wordmark = await renderText('Boardsesh', Math.round(unit * 0.026), textWidth, tint, true);
  const headline = await renderText(caption.headline, Math.round(unit * 0.078), textWidth, colors.label, true);
  const description = await renderText(caption.description, Math.round(unit * 0.036), textWidth, colors.secondaryLabel);
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
      // The peer capture's session header and participant avatars.
      { raw: sources[1], left: margin, top: screenshotTop, width: textWidth, crop: { top: 0.065, height: 0.14 } },
      { raw: sources[0], left: width * 0.14, top: screenshotTop + height * 0.11, width: width * 0.72 },
      // The same peer capture's persistent current-climb bar above its bottom tabs.
      { raw: sources[1], left: margin, top: height * 0.89, width: textWidth, crop: { top: 0.793, height: 0.067 } },
    );
  } else if (
    (layout === 'board-family' || layout === 'more-boards' || layout === 'cross-board-logbook') &&
    sources.length === 3
  ) {
    // Keep both rear screens' upper content visible above the foreground phone.
    // This exposes board holds or profile/session totals for each composition.
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
  const layers: sharp.OverlayOptions[] = [
    { input: wordmark.data, left: margin, top },
    { input: headline.data, left: margin, top: headlineTop },
    { input: description.data, left: margin, top: descriptionTop },
  ];
  if (boardNames) layers.push({ input: boardNames.data, left: margin, top: boardNamesTop });
  return paintFrame({ width, height, colors, layers, panels, unit });
}

/**
 * The landscape (iPad) arrangement: copy in a left column, capture(s) filling the
 * right. Portrait keeps its own geometry in `frameComposition` — the two must not
 * be merged, because every phone frame in the published baseline depends on the
 * portrait arithmetic staying exactly as it is.
 */
async function frameLandscape(
  sources: readonly Buffer[],
  caption: ScreenshotCaption,
  layout: ScreenshotLayout,
  width: number,
  height: number,
): Promise<Buffer> {
  const colors: MaterialSurface = COLORS;
  const tint = brandColorsDark.tint;
  const unit = Math.min(width, height * 0.8);
  const margin = Math.round(width * 0.045);
  const columnWidth = Math.round(width * 0.34);
  const textWidth = columnWidth - margin;
  const gutter = Math.round(width * 0.015);
  const captureLeft = columnWidth + gutter;
  const captureRight = width - margin;
  const regionWidth = captureRight - captureLeft;
  const regionTop = Math.round(height * 0.08);
  // `renderNativePanel` draws a border on every side and offsets a shadow 8px
  // down, so a panel occupies more than its capture. Fit to that, not to the raw
  // aspect, or the clip in `paintFrame` eats the shadow at the stage bottom.
  const panelBleed = Math.max(2, Math.round(unit * 0.002)) * 2 + 8;
  const regionHeight = height - regionTop * 2 - panelBleed;

  const wordmark = await renderText('Boardsesh', Math.round(unit * 0.022), textWidth, tint, true);
  const headline = await renderText(caption.headline, Math.round(unit * 0.058), textWidth, colors.label, true);
  const description = await renderText(caption.description, Math.round(unit * 0.028), textWidth, colors.secondaryLabel);
  // Brand product names stay untranslated. Only name hardware represented by a real source capture.
  const boardNames =
    layout === 'board-family'
      ? await renderText(
          sources.length === 3 ? 'Kilter · Tension · MoonBoard 2016' : 'Kilter · Tension',
          Math.round(unit * 0.024),
          textWidth,
          tint,
          true,
        )
      : undefined;

  const headlineGap = Math.round(height * 0.024);
  const descriptionGap = Math.round(height * 0.018);
  const boardNamesGap = Math.round(height * 0.024);
  const copyHeight =
    wordmark.info.height +
    headlineGap +
    headline.info.height +
    descriptionGap +
    description.info.height +
    (boardNames ? boardNamesGap + boardNames.info.height : 0);
  if (
    headline.info.width > textWidth ||
    description.info.width > textWidth ||
    (boardNames && boardNames.info.width > textWidth) ||
    copyHeight > height * 0.86
  ) {
    throw new Error(`Caption overflows the ${width}x${height} copy column: ${caption.headline}`);
  }
  // Centre the column against the capture beside it rather than hanging it off the top.
  const copyTop = Math.round((height - copyHeight) / 2);
  const headlineTop = copyTop + wordmark.info.height + headlineGap;
  const descriptionTop = headlineTop + headline.info.height + descriptionGap;
  const layers: sharp.OverlayOptions[] = [
    { input: wordmark.data, left: margin, top: copyTop },
    { input: headline.data, left: margin, top: headlineTop },
    { input: description.data, left: margin, top: descriptionTop },
  ];
  if (boardNames) {
    layers.push({
      input: boardNames.data,
      left: margin,
      top: descriptionTop + description.info.height + boardNamesGap,
    });
  }

  const panels: NativePanel[] = [];
  if (layout === 'wall-column') {
    // The trailing wall column, enlarged beside the very screen it came from —
    // the iPad-only surface that shows what is lit while you browse your next one.
    // Only its top runs: the "on the wall" header and the first climbs, which is
    // what the caption is about. Taking the full-height column instead would
    // tower over the screen rather than read as a detail of it.
    const columnFraction = IPAD_WALL_COLUMN_PIXELS / width;
    const columnCrop = 0.62;
    // The strip overhangs the screen's trailing edge, so the screen keeps most of
    // the region and the pair still reads as one object: the shell, with its wall
    // column lifted out of it. The overlap stops short of the column's leading
    // edge, so the column stays visible in context underneath.
    const screenWidth = Math.floor(Math.min(regionWidth * 0.8, (regionHeight * width) / height));
    const screenHeight = (screenWidth * height) / width;
    const stripHeight = Math.round(screenHeight * 1.18);
    const stripWidth = Math.round((stripHeight * IPAD_WALL_COLUMN_PIXELS) / (height * columnCrop));
    panels.push(
      { raw: sources[0], left: captureLeft, top: Math.round((height - screenHeight) / 2), width: screenWidth },
      {
        raw: sources[0],
        left: captureRight - stripWidth,
        top: Math.round((height - stripHeight) / 2),
        width: stripWidth,
        crop: { top: 0, height: columnCrop, left: 1 - columnFraction, width: columnFraction },
      },
    );
  } else if (layout === 'board-family') {
    // A cascade down and to the right: every screen keeps its top-left corner
    // visible, which on a board view is the climb name and grade.
    const panelWidth = Math.round(regionWidth * 0.72);
    const panelHeight = (panelWidth * height) / width;
    const steps = sources.length === 3 ? [0, 0.14, 0.28] : [0, 0.28];
    const drops = sources.length === 3 ? [0, 0.19, 0.38] : [0, 0.38];
    // Centre the whole cascade, not its first panel, or the deck hangs high and
    // leaves all the slack under the front screen.
    const cascadeHeight = regionHeight * drops[drops.length - 1] + panelHeight;
    const cascadeTop = Math.round((height - cascadeHeight) / 2);
    sources.forEach((raw, index) => {
      panels.push({
        raw,
        left: captureLeft + regionWidth * steps[index],
        top: cascadeTop + regionHeight * drops[index],
        width: panelWidth,
      });
    });
  } else if (layout === 'screen') {
    const panelWidth = Math.floor(Math.min(regionWidth, (regionHeight * width) / height));
    panels.push({
      raw: sources[0],
      left: captureLeft + (regionWidth - panelWidth) / 2,
      top: Math.round((height - (panelWidth * height) / width) / 2),
      width: panelWidth,
    });
  } else {
    throw new Error(`No landscape arrangement for ${layout}; it is a portrait-only composition.`);
  }
  return paintFrame({ width, height, colors, layers, panels, unit });
}

interface FramePaint {
  width: number;
  height: number;
  colors: MaterialSurface;
  /** Copy layers, already positioned. Panels are composited over them in order. */
  layers: sharp.OverlayOptions[];
  panels: readonly NativePanel[];
  unit: number;
}

/** The gradient ground plus every native panel, clipped to the canvas. */
async function paintFrame({ width, height, colors, layers, panels, unit }: FramePaint): Promise<Buffer> {
  const background = Buffer.from(`<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
    <defs><linearGradient id="background" x2="0" y2="1"><stop stop-color="${colors.secondaryBackground}"/><stop offset="1" stop-color="${colors.background}"/></linearGradient></defs>
    <rect width="100%" height="100%" fill="url(#background)"/>
  </svg>`);
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
    options.platform === 'ios' ? findOffenders(options.device, captures) : findGooglePlayImageOffenders(captures);
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
    if (options.platform === 'android') {
      const listingOffenders = findGooglePlayOffenders(
        options.device,
        outputNames.map((name) => ({ name, buffer: readFileSync(join(staging, name)) })),
      );
      if (listingOffenders.length) {
        throw new Error(listingOffenders.map(({ file, reason }) => `${file}: ${reason}`).join('\n'));
      }
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
