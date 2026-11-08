// The guard that keeps Android sheets off the phone wallpaper's colours.
//
// `useIosSheetBackgroundStyle()` returns `undefined` off iOS. Handed straight
// to a sheet's `backgroundStyle`, @expo/ui's Android BottomSheet gets no
// container colour and Compose paints the sheet from the wallpaper (Material
// You) or stock M3 purple. `useSheetBackgroundStyle()` adds the opaque
// `sheetSurface` off iOS; this source scan fails when a file passes the
// iOS-only value to `backgroundStyle` directly, which is how four raw sheets
// carried the bug.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const MOBILE_DIR = fileURLToPath(new URL('../../..', import.meta.url));
const SCANNED_DIRS = ['src', 'app'].map((dir) => join(MOBILE_DIR, dir));

const IOS_ONLY_BACKGROUND = /backgroundStyle=\{\s*iosBackgroundStyle\s*\}/;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === '__tests__' ? [] : sourceFiles(path);
    if (!entry.name.endsWith('.tsx') || entry.name.endsWith('.ios.tsx')) return [];
    return [path];
  });
}

describe('sheet background discipline', () => {
  it('never hands the iOS-only background straight to a sheet', () => {
    const offenders = SCANNED_DIRS.flatMap(sourceFiles)
      .filter((path) => IOS_ONLY_BACKGROUND.test(readFileSync(path, 'utf8')))
      .map((path) => path.slice(MOBILE_DIR.length));
    expect(offenders).toEqual([]);
  });

  it('matches the pattern it guards against', () => {
    expect(IOS_ONLY_BACKGROUND.test('<BottomSheetModal backgroundStyle={iosBackgroundStyle}>')).toBe(true);
    expect(IOS_ONLY_BACKGROUND.test('<BottomSheetModal backgroundStyle={backgroundStyle}>')).toBe(false);
  });
});
