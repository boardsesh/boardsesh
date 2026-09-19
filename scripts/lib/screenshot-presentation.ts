import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PRESENTATION_VERSION = 1;
export const PRESENTATION_MANIFEST = 'presentation.json';
export const PRESENTATION_ROOT = fileURLToPath(new URL('../../app-stores/presentation/', import.meta.url));

export const CAPTION_IDS = [
  'board',
  'boards',
  'home',
  'climbs',
  'session',
  'workout',
  'discover',
  'playlist',
  'logbook',
  'profile',
  'wall',
  'boardFamily',
  'liveQueue',
  'liveClimb',
] as const;
export type CaptionId = (typeof CAPTION_IDS)[number];
export const CAPTION_LOCALES = ['en-US', 'es', 'fr', 'de'] as const;
export type CaptionLocale = (typeof CAPTION_LOCALES)[number];
export interface ScreenshotCaption {
  headline: string;
  description: string;
}
export type CaptionCatalog = Record<CaptionId, ScreenshotCaption>;

export const STORE_CAPTION_LOCALES: Readonly<Record<string, CaptionLocale>> = {
  'en-US': 'en-US',
  'es-ES': 'es',
  'es-MX': 'es',
  'fr-FR': 'fr',
  'de-DE': 'de',
};

export function captionLocaleForStore(platform: 'ios' | 'android', storeLocale: string): CaptionLocale {
  if (platform === 'android') return 'en-US';
  const locale = STORE_CAPTION_LOCALES[storeLocale];
  if (!locale) throw new Error(`No screenshot captions for Apple store locale ${storeLocale}`);
  return locale;
}

const PHONE_CAPTIONS: Readonly<Record<string, CaptionId>> = {
  '00-board-view.png': 'board',
  '01-board-view-2.png': 'boards',
  '02-home.png': 'home',
  '03-climbs.png': 'climbs',
  '04-session-detail.png': 'session',
  '05-workout-generator.png': 'workout',
  '06-discover.png': 'discover',
  '07-playlist-detail.png': 'playlist',
  '08-logbook.png': 'logbook',
  '09-profile.png': 'profile',
};
const IPAD_CAPTIONS: Readonly<Record<string, CaptionId>> = {
  '00-wall.png': 'wall',
  '01-home.png': 'home',
  '02-climbs.png': 'climbs',
  '03-workout-generator.png': 'workout',
  '04-discover.png': 'discover',
  '05-profile.png': 'profile',
};
const ANDROID_CAPTIONS: Readonly<Record<string, CaptionId>> = {
  '00-tension-board-view.png': 'board',
  '01-kilter-board-view.png': 'boards',
  '02-home.png': 'home',
  '03-climbs.png': 'climbs',
  '04-discover.png': 'discover',
  '05-workout-generator.png': 'workout',
  '06-profile.png': 'profile',
  '07-board-sheet.png': 'wall',
};

export function screenshotCaptions(platform: 'ios' | 'android', device: string): Readonly<Record<string, CaptionId>> {
  if (platform === 'android') return ANDROID_CAPTIONS;
  if (device.startsWith('ipad-')) return IPAD_CAPTIONS;
  if (device.startsWith('iphone-')) return PHONE_CAPTIONS;
  throw new Error(`No screenshot presentation for device ${device}`);
}

export type ScreenshotLayout = 'screen' | 'board-family' | 'live-climb';
export interface ScreenshotRecipe {
  output: string;
  caption: CaptionId;
  layout: ScreenshotLayout;
  /** Actual native captures, in their compositing order. */
  sources: readonly string[];
}

const ANDROID_LIVE_CAPTURES = ['09-live-queue.png', '10-live-climb.png', '11-live-climb-peer.png'] as const;
const MOONBOARD_CAPTURE = '08-moonboard-board-view.png';

/** Keep old capture flows usable; the new opening requires the complete live capture set. */
export function resolveScreenshotRecipes(
  platform: 'ios' | 'android',
  device: string,
  captureNames: readonly string[],
): readonly ScreenshotRecipe[] {
  const mapping = screenshotCaptions(platform, device);
  const legacyNames = Object.keys(mapping).sort();
  const actualNames = [...captureNames].sort();
  const matches = (expected: readonly string[]) => [...expected].sort().join('\n') === actualNames.join('\n');
  if (matches(legacyNames)) {
    return legacyNames.map((name) => ({ output: name, caption: mapping[name], layout: 'screen', sources: [name] }));
  }
  const liveNames = [...legacyNames, ...ANDROID_LIVE_CAPTURES];
  if (platform === 'android' && (matches(liveNames) || matches([...liveNames, MOONBOARD_CAPTURE]))) {
    const boardSources = ['00-tension-board-view.png', '01-kilter-board-view.png'];
    if (captureNames.includes(MOONBOARD_CAPTURE)) boardSources.push(MOONBOARD_CAPTURE);
    return [
      { output: '00-board-family.png', caption: 'boardFamily', layout: 'board-family', sources: boardSources },
      { output: '01-live-queue.png', caption: 'liveQueue', layout: 'screen', sources: ['09-live-queue.png'] },
      {
        output: '02-live-climb.png',
        caption: 'liveClimb',
        layout: 'live-climb',
        sources: ['10-live-climb.png', '11-live-climb-peer.png'],
      },
      ...['03-climbs.png', '04-discover.png', '05-workout-generator.png', '06-profile.png', '07-board-sheet.png'].map(
        (name): ScreenshotRecipe => ({ output: name, caption: mapping[name], layout: 'screen', sources: [name] }),
      ),
    ];
  }
  throw new Error(
    `Incomplete or unknown screenshot set. Expected ${legacyNames.join(', ')}${platform === 'android' ? `; the live set also requires ${ANDROID_LIVE_CAPTURES.join(', ')} (optionally ${MOONBOARD_CAPTURE})` : ''}; found ${actualNames.join(', ')}.`,
  );
}

function isRecord(candidate: unknown): candidate is Record<string, unknown> {
  return typeof candidate === 'object' && candidate !== null && !Array.isArray(candidate);
}

export function readCaptionCatalog(locale: CaptionLocale, root = PRESENTATION_ROOT): CaptionCatalog {
  const parsed: unknown = JSON.parse(readFileSync(join(root, `${locale}.json`), 'utf8'));
  if (!isRecord(parsed)) throw new Error(`Invalid screenshot captions for ${locale}`);
  const catalog = {} as CaptionCatalog;
  for (const captionId of CAPTION_IDS) {
    const caption = parsed[captionId];
    if (
      !isRecord(caption) ||
      typeof caption.headline !== 'string' ||
      !caption.headline.trim() ||
      typeof caption.description !== 'string' ||
      !caption.description.trim()
    ) {
      throw new Error(`Missing screenshot caption ${locale}.${captionId}`);
    }
    catalog[captionId] = { headline: caption.headline, description: caption.description };
  }
  return catalog;
}

export interface PresentedScreenshot {
  rawBytes: number;
  rawSha256: string;
  framedSha256: string;
  /** Composite provenance. rawBytes is the smallest source, so a blank peer cannot hide behind a detailed image. */
  sources?: Record<string, { rawBytes: number; rawSha256: string }>;
}
export interface PresentationManifest {
  version: typeof PRESENTATION_VERSION;
  locale: CaptionLocale;
  files: Record<string, PresentedScreenshot>;
}

export function sha256Screenshot(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** A sidecar belongs to exactly these PNG bytes; stale metadata must never weaken the content gate. */
export function readPresentationManifest(directory: string): PresentationManifest {
  const filename = join(directory, PRESENTATION_MANIFEST);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(filename, 'utf8'));
  } catch (error) {
    throw new Error(`Cannot read screenshot presentation manifest: ${filename}`, { cause: error });
  }
  if (
    !isRecord(parsed) ||
    parsed.version !== PRESENTATION_VERSION ||
    !isRecord(parsed.files) ||
    !CAPTION_LOCALES.some((locale) => locale === parsed.locale)
  ) {
    throw new Error(`Invalid screenshot presentation manifest: ${filename}`);
  }
  const files: Record<string, PresentedScreenshot> = {};
  for (const [name, entry] of Object.entries(parsed.files)) {
    if (
      !/^[\w-]+\.png$/.test(name) ||
      !isRecord(entry) ||
      !Number.isSafeInteger(entry.rawBytes) ||
      Number(entry.rawBytes) <= 0 ||
      typeof entry.rawSha256 !== 'string' ||
      !/^[a-f0-9]{64}$/.test(entry.rawSha256) ||
      typeof entry.framedSha256 !== 'string' ||
      !/^[a-f0-9]{64}$/.test(entry.framedSha256)
    ) {
      throw new Error(`Invalid screenshot presentation entry: ${filename}: ${name}`);
    }
    const presented: PresentedScreenshot = {
      rawBytes: Number(entry.rawBytes),
      rawSha256: entry.rawSha256,
      framedSha256: entry.framedSha256,
    };
    if (entry.sources !== undefined) {
      if (!isRecord(entry.sources) || Object.keys(entry.sources).length < 2) {
        throw new Error(`Invalid screenshot sources: ${filename}: ${name}`);
      }
      presented.sources = {};
      for (const [sourceName, source] of Object.entries(entry.sources)) {
        if (
          !/^[\w-]+\.png$/.test(sourceName) ||
          !isRecord(source) ||
          !Number.isSafeInteger(source.rawBytes) ||
          Number(source.rawBytes) <= 0 ||
          typeof source.rawSha256 !== 'string' ||
          !/^[a-f0-9]{64}$/.test(source.rawSha256)
        ) {
          throw new Error(`Invalid screenshot source: ${filename}: ${sourceName}`);
        }
        presented.sources[sourceName] = { rawBytes: Number(source.rawBytes), rawSha256: source.rawSha256 };
      }
      if (
        presented.rawBytes !== Math.min(...Object.values(presented.sources).map((source) => source.rawBytes)) ||
        presented.rawSha256 !== sha256Screenshot(Buffer.from(JSON.stringify(presented.sources)))
      ) {
        throw new Error(`Composite source metadata does not match: ${filename}: ${name}`);
      }
    }
    files[name] = presented;
  }
  return { version: PRESENTATION_VERSION, locale: parsed.locale as CaptionLocale, files };
}

export function rawSizeForPresentedScreenshot(
  path: string,
  manifest: PresentationManifest = readPresentationManifest(dirname(path)),
): number {
  // Each command verifies each PNG once. A parsed sidecar alone cannot prove
  // the image still matches it; do not cache this check across file changes.
  const name = basename(path);
  const entry = manifest.files[name];
  if (!entry || sha256Screenshot(readFileSync(path)) !== entry.framedSha256) {
    throw new Error(`Screenshot does not match its presentation metadata: ${path}`);
  }
  return entry.rawBytes;
}
