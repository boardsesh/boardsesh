import type { BoardName } from '@boardsesh/shared-schema';
import { getBoardRenderData } from './board-details';
import { resolveBoardBackgroundAsset } from './board-background-asset-resolver';
import { BOARD_BACKGROUND_ASSETS } from './board-backgrounds-manifest';

export type BackgroundVariant = 'full' | 'thumb';
export type BackgroundColorScheme = 'light' | 'dark';

const DARK_VARIANT_SUFFIX = '.dark.webp';

function manifestKeyForVariant(backgroundImageKey: string, variant: BackgroundVariant = 'full'): string {
  if (variant === 'full') return backgroundImageKey;
  const lastSlash = backgroundImageKey.lastIndexOf('/');
  if (lastSlash < 0) return `thumbs/${backgroundImageKey}`;
  return `${backgroundImageKey.slice(0, lastSlash)}/thumbs/${backgroundImageKey.slice(lastSlash + 1)}`;
}

function resolveManifestKey(
  backgroundImageKey: string,
  variant: BackgroundVariant,
  colorScheme: BackgroundColorScheme,
): string {
  let manifestKey = backgroundImageKey;
  if (variant === 'thumb') {
    const thumbKey = manifestKeyForVariant(backgroundImageKey, 'thumb');
    if (BOARD_BACKGROUND_ASSETS[thumbKey] !== undefined) manifestKey = thumbKey;
  }
  if (colorScheme === 'dark') {
    const darkKey = `${manifestKey.replace(/\.webp$/, '')}${DARK_VARIANT_SUFFIX}`;
    if (BOARD_BACKGROUND_ASSETS[darkKey] !== undefined) return darkKey;
  }
  return manifestKey;
}

const warnedMissingKeys = new Set<string>();

function warnMissing(manifestKey: string, reason: string): void {
  if (warnedMissingKeys.has(manifestKey)) return;
  warnedMissingKeys.add(manifestKey);
  // eslint-disable-next-line no-console
  console.warn(`[background-image-cache] No packaged asset for "${manifestKey}" (${reason}).`);
}

function resolveBackgroundPath(manifestKey: string): string | null {
  const asset = BOARD_BACKGROUND_ASSETS[manifestKey];
  if (!asset) return null;
  return resolveBoardBackgroundAsset(asset, manifestKey);
}

type BackgroundParams = {
  boardName: BoardName;
  layoutId: number;
  sizeId: number;
  setIds: number[];
  variant?: BackgroundVariant;
  colorScheme?: BackgroundColorScheme;
};

export type BackgroundLookupResult = {
  paths: string[];
  missingCount: number;
};

/**
 * Resolve every layer synchronously. Native paths always refer to resources in
 * the installed IPA/APK. Browser paths use the configured production CDN or
 * same-origin `/images/` in local/PR builds. There is no native downloader or
 * network fallback.
 */
export function tryGetBackgroundPathsSync(params: BackgroundParams): BackgroundLookupResult | null {
  const renderData = getBoardRenderData(params);
  if (!renderData) return null;

  const variant = params.variant ?? 'full';
  const colorScheme = params.colorScheme ?? 'light';
  const paths: string[] = [];
  let missingCount = 0;

  for (const backgroundImageKey of renderData.backgroundImageKeys) {
    const manifestKey = resolveManifestKey(backgroundImageKey, variant, colorScheme);
    const path = resolveBackgroundPath(manifestKey);
    if (path) {
      paths.push(path);
    } else {
      missingCount++;
      warnMissing(
        manifestKey,
        BOARD_BACKGROUND_ASSETS[manifestKey] ? 'native wrapper has no resource' : 'no catalog entry',
      );
    }
  }

  return { paths, missingCount };
}

/**
 * Compatibility wrapper for existing async call sites. Native resources need
 * no warming or materialization, so this resolves the synchronous result.
 */
export async function ensureBackgroundsCached(params: BackgroundParams): Promise<BackgroundLookupResult | null> {
  return tryGetBackgroundPathsSync(params);
}
