import type { BoardName } from '@boardsesh/shared-schema';
import { DEFAULT_LOCALE, SUPPORTED_LOCALES } from './config';
import { detectLocale } from './detect-locale';

export const APP_GUIDE_LOCALES = [DEFAULT_LOCALE] as const;
export const APP_GUIDE_HUB_PATH = '/apps';
export const APP_GUIDE_COMPARISON_PATH = '/compare/spray-wall-apps';

// The Aurora boards (Tension, Decoy, Touchstone, Grasshopper, So iLL) run builds of
// one app, so they share /apps/aurora and link to their own section of it.
const BOARD_APP_GUIDE_PATHS = {
  kilter: '/apps/kilter',
  tension: '/apps/aurora#tension',
  moonboard: '/apps/moonboard',
  decoy: '/apps/aurora#decoy',
  touchstone: '/apps/aurora#touchstone',
  grasshopper: '/apps/aurora#grasshopper',
  soill: '/apps/aurora#so-ill',
  woods: '/apps/woods',
  spray: APP_GUIDE_COMPARISON_PATH,
} as const satisfies Record<BoardName, string>;

export function getBoardAppGuidePath(boardName: BoardName) {
  return BOARD_APP_GUIDE_PATHS[boardName];
}

export function isAppGuidePath(pathname: string): boolean {
  return (
    pathname === APP_GUIDE_HUB_PATH ||
    pathname.startsWith(`${APP_GUIDE_HUB_PATH}/`) ||
    pathname === APP_GUIDE_COMPARISON_PATH ||
    pathname === `${APP_GUIDE_COMPARISON_PATH}/`
  );
}

export function getPublishedLocales(pathname: string) {
  return isAppGuidePath(detectLocale(pathname).strippedPath) ? APP_GUIDE_LOCALES : SUPPORTED_LOCALES;
}

/** Reload only when the root document language must change, preserving ordinary SPA attribution. */
export function needsAppGuideDocumentNavigation(
  sourcePath: string,
  destinationPath: string,
  documentLocale: string,
  destinationLocale: string,
  savedLocale: string | undefined,
): boolean {
  const sourceIsGuide = isAppGuidePath(detectLocale(sourcePath).strippedPath);
  const destinationIsGuide = isAppGuidePath(detectLocale(destinationPath).strippedPath);
  if (sourceIsGuide === destinationIsGuide) return false;
  if (destinationIsGuide) return documentLocale !== DEFAULT_LOCALE;
  return destinationLocale !== DEFAULT_LOCALE || (!!savedLocale && savedLocale !== DEFAULT_LOCALE);
}
