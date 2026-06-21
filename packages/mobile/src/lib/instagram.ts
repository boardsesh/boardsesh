import { Linking } from 'react-native';

const INSTAGRAM_APP_URL = 'instagram://camera';
const INSTAGRAM_WEB_URL = 'https://www.instagram.com';

export type OpenInstagramResult = {
  /** Whether anything opened at all (app or website). */
  opened: boolean;
  /** True when the native app wasn't available and we opened the website instead. */
  usedFallback: boolean;
};

/**
 * Open Instagram so the climber can post their reel. Instagram has no public
 * compose API, so we can't pre-fill the video or caption — the caller copies the
 * caption to the clipboard first and this just drops the user into Instagram's
 * camera. Tries the native app (`instagram://camera`); if that's rejected (app
 * not installed) it falls back to the website so the caller can tell the user
 * what happened instead of silently landing them on instagram.com.
 *
 * Uses `openURL` + catch rather than `canOpenURL` on purpose: `canOpenURL` would
 * require declaring `instagram` in `LSApplicationQueriesSchemes`, which needs a
 * native rebuild. `openURL` works without it and degrades gracefully.
 */
export async function openInstagram(): Promise<OpenInstagramResult> {
  try {
    await Linking.openURL(INSTAGRAM_APP_URL);
    return { opened: true, usedFallback: false };
  } catch {
    try {
      await Linking.openURL(INSTAGRAM_WEB_URL);
      return { opened: true, usedFallback: true };
    } catch {
      return { opened: false, usedFallback: false };
    }
  }
}
