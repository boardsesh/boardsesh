import { Linking } from 'react-native';

/**
 * Open an external URL, returning whether it actually opened.
 *
 * Skips `Linking.canOpenURL` on purpose: on Android 11+ package-visibility rules
 * make it return `false` for https/app URLs unless the matching intent is
 * declared in `<queries>` in the manifest — even though `openURL` itself
 * succeeds (firing an intent needs no visibility declaration; only querying
 * does). Gating on `canOpenURL` is what broke opening beta videos on Android.
 *
 * Instead we validate the URL up front via `isValid` (so we never hand an
 * arbitrary scheme to `openURL`) and let `openURL`'s own rejection signal a
 * genuine failure. Mirrors `src/lib/instagram.ts`.
 */
export async function openValidatedUrl(url: string, isValid: (url: string) => boolean): Promise<boolean> {
  if (!isValid(url)) return false;
  try {
    await Linking.openURL(url);
    return true;
  } catch {
    return false;
  }
}
