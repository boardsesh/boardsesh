import { useCallback, useEffect, useRef, type ReactNode } from 'react';
import * as Linking from 'expo-linking';
import { useRouter } from 'expo-router';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { reportHandledError } from '../lib/error-reporting';
import { parsePreviewChannel, parsePreviewLinkChannel } from '../lib/preview-link';
import { useAuth } from './auth-provider';

// Stash for a join that arrived before the user was signed in. The auth gate
// (auth-provider) redirects an unauthenticated cold-start to /auth/login and
// swallows the deep link's intended route, so we persist the target sessionId
// and replay it once auth flips to authenticated.
const PENDING_JOIN_KEY = 'boardsesh_pending_join_session_id';

// Same stash, same reason, for the OTA-preview link in a PR comment
// (/preview/pr-1234). Without it a signed-out tester taps the link, gets bounced
// to /auth/login, and the channel is gone by the time they're back — the link
// silently does nothing.
const PENDING_PREVIEW_KEY = 'boardsesh_pending_preview_channel';

// Loose UUID-ish guard: 8-4-4-4-12 hex, the shape our session ids take. Rejects
// obvious garbage (`http`, `..`, empty) before we push a route that would just
// render "Session not found". Case-insensitive — ids are lowercase but a shared
// link could be upper/mixed.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isValidSessionId(value: string | null | undefined): value is string {
  return typeof value === 'string' && UUID_RE.test(value.trim());
}

/**
 * Pull a sessionId out of a Boardsesh join link. Handles every shape we accept:
 * the Universal/App Link `https://www.boardsesh.com/join/{id}`, the custom
 * scheme `com.boardsesh.app://join/{id}` (where `join` lands in `hostname`),
 * a leading locale segment (`/es/join/{id}`), and stray leading/trailing
 * slashes. Returns null when the URL isn't a join link or the id is malformed.
 */
export function parseJoinSessionId(url: string): string | null {
  let parsed: Linking.ParsedURL;
  try {
    parsed = Linking.parse(url);
  } catch {
    return null;
  }

  // Reassemble the full path. For https links `hostname` is the domain and the
  // route lives entirely in `path` (`join/{id}`). For the custom scheme
  // `com.boardsesh.app://join/{id}` the first segment (`join`) is parsed into
  // `hostname` with the id in `path` — so we only fold `hostname` in when it
  // isn't a web domain (contains a dot).
  const segments: string[] = [];
  if (parsed.hostname && !parsed.hostname.includes('.')) {
    segments.push(parsed.hostname);
  }
  if (parsed.path) {
    segments.push(...parsed.path.split('/'));
  }

  const cleaned = segments.map((segment) => segment.trim()).filter((segment) => segment.length > 0);

  // Drop a leading two-letter locale segment (`es`, `fr`). No route prefix is
  // two letters, so this can't swallow a real segment.
  if (cleaned.length > 0 && /^[a-z]{2}$/.test(cleaned[0])) {
    cleaned.shift();
  }

  if (cleaned.length < 2 || cleaned[0] !== 'join') return null;
  const sessionId = cleaned[1];
  return isValidSessionId(sessionId) ? sessionId : null;
}

/**
 * Deep-link receiver for the multiplayer join flow. Listens for join links
 * (cold start via `getInitialURL`, warm via the `url` event) and routes to the
 * join-confirmation modal. Joining itself happens on the modal's confirm — this
 * provider never joins.
 *
 * Auth survival: a link that arrives while signed out is stashed in AsyncStorage
 * and replayed once `useAuth().isAuthenticated` flips true (the auth gate routes
 * the cold-start to login first). Clears the stash on consume.
 */
export function DeepLinkProvider({ children }: { children: ReactNode }) {
  const router = useRouter();
  const { isAuthenticated } = useAuth();

  // Latest auth state for the async link handlers, so the listener effect can
  // stay mounted across auth changes without re-subscribing.
  const isAuthenticatedRef = useRef(isAuthenticated);
  isAuthenticatedRef.current = isAuthenticated;

  const navigateToJoin = useCallback(
    (sessionId: string) => {
      // navigate (not push): Expo Router's built-in linking already routes a
      // tapped/launched join link to this modal when authenticated. navigate
      // reuses that existing instance (same route + params) instead of stacking
      // a duplicate, while still opening the modal in the post-login replay case
      // where the original route was swallowed by the auth-gate redirect.
      router.navigate({ pathname: '/join/[sessionId]', params: { sessionId } });
    },
    [router],
  );

  const handleSessionId = useCallback(
    async (sessionId: string) => {
      if (isAuthenticatedRef.current) {
        navigateToJoin(sessionId);
        return;
      }
      // Signed out: stash it so we can replay after login. The auth gate is
      // about to redirect to /auth/login.
      try {
        await AsyncStorage.setItem(PENDING_JOIN_KEY, sessionId);
      } catch (error) {
        if (__DEV__) console.warn('[deep-link] failed to stash pending join', error);
        reportHandledError(error, { tags: { source: 'deep-link', op: 'stash-pending-join' } });
      }
    },
    [navigateToJoin],
  );

  const navigateToPreview = useCallback(
    (channel: string) => {
      // navigate (not push), same reasoning as join: Expo Router's own linking
      // already routes a tapped preview link here when authenticated, so reuse
      // that instance rather than stacking a duplicate screen.
      router.navigate({ pathname: '/preview/[channel]', params: { channel } });
    },
    [router],
  );

  const handlePreviewChannel = useCallback(
    async (channel: string) => {
      if (isAuthenticatedRef.current) {
        navigateToPreview(channel);
        return;
      }
      try {
        await AsyncStorage.setItem(PENDING_PREVIEW_KEY, channel);
      } catch (error) {
        if (__DEV__) console.warn('[deep-link] failed to stash pending preview', error);
        reportHandledError(error, { tags: { source: 'deep-link', op: 'stash-pending-preview' } });
      }
    },
    [navigateToPreview],
  );

  const handleUrl = useCallback(
    (url: string | null) => {
      if (!url) return;
      const sessionId = parseJoinSessionId(url);
      if (sessionId) {
        void handleSessionId(sessionId);
        return;
      }
      const previewChannel = parsePreviewLinkChannel(url);
      if (previewChannel) void handlePreviewChannel(previewChannel);
    },
    [handleSessionId, handlePreviewChannel],
  );

  // Cold start + warm links.
  useEffect(() => {
    let cancelled = false;
    void Linking.getInitialURL().then((url) => {
      if (!cancelled) handleUrl(url);
    });
    const subscription = Linking.addEventListener('url', ({ url }) => handleUrl(url));
    return () => {
      cancelled = true;
      subscription.remove();
    };
  }, [handleUrl]);

  // Replay a pending join once the user is authenticated (post-login, or a link
  // received while signed out that we stashed above). Clears the stash on
  // consume so it fires exactly once.
  useEffect(() => {
    if (!isAuthenticated) return;
    let cancelled = false;
    void (async () => {
      try {
        const pendingSessionId = await AsyncStorage.getItem(PENDING_JOIN_KEY);
        if (cancelled || !pendingSessionId) return;
        await AsyncStorage.removeItem(PENDING_JOIN_KEY);
        if (isValidSessionId(pendingSessionId)) {
          navigateToJoin(pendingSessionId);
        }
      } catch (error) {
        if (__DEV__) console.warn('[deep-link] failed to consume pending join', error);
        reportHandledError(error, { tags: { source: 'deep-link', op: 'consume-pending-join' } });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isAuthenticated, navigateToJoin]);

  // Same replay for a pending preview channel. Re-validated on the way out, not
  // just on the way in: the stash outlives the launch that wrote it, so a value
  // left by an older build (or edited on a rooted device) must not reach
  // performChannelSwitch. Cleared on consume so it fires exactly once.
  useEffect(() => {
    if (!isAuthenticated) return;
    let cancelled = false;
    void (async () => {
      try {
        const pendingChannel = await AsyncStorage.getItem(PENDING_PREVIEW_KEY);
        if (cancelled || !pendingChannel) return;
        await AsyncStorage.removeItem(PENDING_PREVIEW_KEY);
        const channel = parsePreviewChannel(pendingChannel);
        if (channel) {
          navigateToPreview(channel);
        }
      } catch (error) {
        if (__DEV__) console.warn('[deep-link] failed to consume pending preview', error);
        reportHandledError(error, { tags: { source: 'deep-link', op: 'consume-pending-preview' } });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isAuthenticated, navigateToPreview]);

  return <>{children}</>;
}
