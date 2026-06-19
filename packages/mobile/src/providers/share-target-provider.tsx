import { useCallback, useEffect, useRef, type ReactNode } from 'react';
import { useRouter, useSegments } from 'expo-router';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { reportHandledError } from '../lib/error-reporting';
import { useShareIntent, type ShareIntent } from 'expo-share-intent';
import { useTranslation } from 'react-i18next';
import { isBetaVideoUrl } from '@boardsesh/shared-schema';
import { useAuth } from './auth-provider';
import { useToast } from './toast-provider';

// Stash for a beta link shared before sign-in. Mirrors DeepLinkProvider's
// PENDING_JOIN_KEY: the auth gate redirects an unauthenticated launch to
// /auth/login (and the OAuth round-trip backgrounds the app), so we persist the
// link and replay it once auth flips true. resetOnBackground is off too, but the
// stash is the durable path across the login redirect.
const PENDING_SHARE_KEY = 'boardsesh_pending_share_link';

/**
 * Pull the first http(s) URL out of a shared payload. The OS share sheet usually
 * hands us a clean `webUrl`, but some apps share a caption + link as plain text
 * ("nice send https://instagram.com/reel/..."), and isBetaVideoUrl is anchored
 * ^...$ so it rejects surrounding words. Prefer the structured webUrl, then the
 * first URL token inside the text. Exported for unit testing.
 */
export function extractSharedLink(shareIntent: Pick<ShareIntent, 'webUrl' | 'text'> | null): string | null {
  if (!shareIntent) return null;
  const webUrl = shareIntent.webUrl?.trim();
  if (webUrl) return webUrl;
  // Stop the URL before whitespace and closing wrappers ("(url)", "<url>",
  // "url"), then strip trailing sentence punctuation / emoji glued to the URL
  // ("...reel/abc🔥", "...reel/abc."). Without this, those trailing chars fail
  // the anchored isBetaVideoUrl check and a valid link gets rejected. A trailing
  // "/" (canonical IG/TikTok form) and query/fragment chars are preserved.
  const match = shareIntent.text?.match(/https?:\/\/[^\s)\]}>"'«»]+/u);
  if (!match) return null;
  const trimmed = match[0].replace(/[\s\p{S}.,;:!?…]+$/u, '');
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Share-target receiver for the beta-video flow. Reads links shared into the app
 * from another app's share sheet (Instagram / TikTok) via expo-share-intent and
 * routes to the /share-beta picker. Attaching happens on that screen — this
 * provider never writes.
 *
 * Auth survival mirrors DeepLinkProvider: a link that arrives while signed out is
 * stashed in AsyncStorage and replayed once `useAuth().isAuthenticated` flips
 * true. Non-beta URLs are rejected with a toast and never routed.
 */
export function ShareTargetProvider({ children }: { children: ReactNode }) {
  const router = useRouter();
  const segments = useSegments();
  const { isAuthenticated } = useAuth();
  const { t } = useTranslation('session');
  const { showToast } = useToast();

  // Whether the /share-beta modal is the focused route, read by the navigate
  // handler without resubscribing. `includes` (not segments[0]) so a future
  // route-group nesting can't silently break the reuse check.
  const onShareBetaRef = useRef(false);
  onShareBetaRef.current = segments.includes('share-beta');
  // resetOnBackground defaults to true; turn it off so the OAuth round-trip
  // (which backgrounds the app) can't wipe a share before we've consumed it.
  const { hasShareIntent, shareIntent, resetShareIntent } = useShareIntent({ resetOnBackground: false });

  // Latest auth state for the async handlers, so the receive effect can read it
  // without resubscribing on every auth change.
  const isAuthenticatedRef = useRef(isAuthenticated);
  isAuthenticatedRef.current = isAuthenticated;

  const navigateToShare = useCallback(
    (link: string) => {
      // If the share modal is already open (rapid successive shares, or the
      // post-login replay landing on it), swap the link in place instead of
      // pushing a second modal. Each shared reel carries a different `link`, so
      // router.navigate would stack a fresh /share-beta rather than reuse the
      // open one — that stacking is what made the app sluggish. share-beta.tsx
      // reacts to the updated `link` param.
      if (onShareBetaRef.current) {
        router.setParams({ link });
        return;
      }
      router.navigate({ pathname: '/share-beta', params: { link } });
    },
    [router],
  );

  const handleLink = useCallback(
    async (link: string) => {
      if (isAuthenticatedRef.current) {
        navigateToShare(link);
        return;
      }
      // Signed out: stash it for replay after login. The auth gate is about to
      // redirect to /auth/login.
      try {
        await AsyncStorage.setItem(PENDING_SHARE_KEY, link);
      } catch (error) {
        if (__DEV__) console.warn('[share-target] failed to stash pending share', error);
        reportHandledError(error, { tags: { source: 'share-target', op: 'stash-pending-share' } });
      }
    },
    [navigateToShare],
  );

  // React to an incoming share. Capture the link, then reset the native module
  // so the same share isn't re-processed; resetting also flips hasShareIntent
  // false, so this effect short-circuits on the next run rather than looping.
  useEffect(() => {
    if (!hasShareIntent) return;
    const link = extractSharedLink(shareIntent);
    resetShareIntent();
    if (!link) return;
    if (!isBetaVideoUrl(link)) {
      showToast(t('mobile.betaVideos.urlInvalid'), 'error');
      return;
    }
    void handleLink(link);
  }, [hasShareIntent, shareIntent, resetShareIntent, handleLink, showToast, t]);

  // Replay a pending share once authenticated (post-login, or a link received
  // while signed out). Clears the stash on consume so it fires exactly once.
  useEffect(() => {
    if (!isAuthenticated) return;
    let cancelled = false;
    void (async () => {
      try {
        const pendingLink = await AsyncStorage.getItem(PENDING_SHARE_KEY);
        if (cancelled || !pendingLink) return;
        await AsyncStorage.removeItem(PENDING_SHARE_KEY);
        if (isBetaVideoUrl(pendingLink)) navigateToShare(pendingLink);
      } catch (error) {
        if (__DEV__) console.warn('[share-target] failed to consume pending share', error);
        reportHandledError(error, { tags: { source: 'share-target', op: 'consume-pending-share' } });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isAuthenticated, navigateToShare]);

  return <>{children}</>;
}
