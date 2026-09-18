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
  if (device === 'iphone-16-pro-max') return PHONE_CAPTIONS;
  throw new Error(`No screenshot presentation for device ${device}`);
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
  const parsed: unknown = JSON.parse(readFileSync(filename, 'utf8'));
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
    files[name] = { rawBytes: Number(entry.rawBytes), rawSha256: entry.rawSha256, framedSha256: entry.framedSha256 };
  }
  return { version: PRESENTATION_VERSION, locale: parsed.locale as CaptionLocale, files };
}

export function rawSizeForPresentedScreenshot(
  path: string,
  manifest: PresentationManifest = readPresentationManifest(dirname(path)),
): number {
  const name = basename(path);
  const entry = manifest.files[name];
  if (!entry || sha256Screenshot(readFileSync(path)) !== entry.framedSha256) {
    throw new Error(`Screenshot does not match its presentation metadata: ${path}`);
  }
  return entry.rawBytes;
}
