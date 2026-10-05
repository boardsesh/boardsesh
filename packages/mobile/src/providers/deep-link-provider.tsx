import { useCallback, useEffect, useRef, type ReactNode } from 'react';
import * as Linking from 'expo-linking';
import { useRouter, type Href } from 'expo-router';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { reportHandledError } from '../lib/error-reporting';
import { isLegacyPreviewLink } from '../lib/legacy-preview-link';
import { RELAXES_ANONYMOUS_ROUTES } from '../lib/routing/anonymous-auth-gate';
import { isBoardLinkPath, parseBoardLinkPath } from '../lib/routing/board-deep-link';
import { clearBoardLinkReplay, setBoardLinkReplay } from '../lib/routing/board-link-replay';
import { useAuth } from './auth-provider';

// Stash for a join that arrived before the user was signed in. The auth gate
// (auth-provider) redirects an unauthenticated cold-start to /auth/login and
// swallows the deep link's intended route, so we persist the target sessionId
// and replay it once auth flips to authenticated.
const PENDING_JOIN_KEY = 'boardsesh_pending_join_session_id';
const PENDING_LEGACY_PREVIEW_KEY = 'boardsesh_pending_legacy_preview';
// A board or climb link (`/{board}/…`, `/b/{slug}/…`) that arrived signed out,
// stored as `{ path, stashedAt }`. Same reason as the join stash, and the path
// a new climber takes: tap a shared climb, install, sign up, tap it again.
const PENDING_BOARD_LINK_KEY = 'boardsesh_pending_board_link';

/**
 * A stashed board link is followed for a day. A join is asked for again on
 * arrival, so an old one is harmless; a climb link opens straight away, and
 * landing someone on a climb they tapped last week, at a sign-in they did for
 * another reason, would read as the app misbehaving.
 */
export const PENDING_BOARD_LINK_MAX_AGE_MS = 24 * 60 * 60 * 1000;

// The launch URL is the same for the life of the process, and this provider
// remounts on every sign-in and sign-out (the auth gate swaps the tree). Without
// this, signing out hours after opening the app from a climb link would stash
// that link again and the next sign-in would land on it. One launch, one stash.
let handledLaunchBoardUrl: string | null = null;

type PendingBoardLink = { path: string; stashedAt: number };

/** The stored link, or null when the value is not one we wrote or has expired. */
function readPendingBoardLink(stored: string | null, nowMs: number): string | null {
  if (!stored) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(stored);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const { path, stashedAt } = parsed as Partial<PendingBoardLink>;
  if (typeof stashedAt !== 'number' || !Number.isFinite(stashedAt)) return null;
  const ageMs = nowMs - stashedAt;
  // A negative age is a clock that moved back; treat it as unknown, not fresh.
  if (ageMs < 0 || ageMs > PENDING_BOARD_LINK_MAX_AGE_MS) return null;
  return isBoardLinkPath(path) ? path : null;
}

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
 *
 * Board and climb links get the auth survival and nothing else: signed in, Expo
 * Router has already opened the route, so this provider leaves them alone.
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

  const navigateToLegacyPreviewDestination = useCallback(() => {
    router.navigate('/changelog');
  }, [router]);

  const handleLegacyPreview = useCallback(async () => {
    if (isAuthenticatedRef.current) {
      navigateToLegacyPreviewDestination();
      return;
    }
    try {
      await AsyncStorage.setItem(PENDING_LEGACY_PREVIEW_KEY, '1');
    } catch (error) {
      if (__DEV__) console.warn('[deep-link] failed to stash pending legacy preview', error);
      reportHandledError(error, { tags: { source: 'deep-link', op: 'stash-pending-legacy-preview' } });
    }
  }, [navigateToLegacyPreviewDestination]);

  const handleBoardLink = useCallback(async (url: string, boardPath: string, isLaunchUrl: boolean) => {
    // The browser app keeps the path itself, as `?next=` on the login URL.
    if (RELAXES_ANONYMOUS_ROUTES) return;
    if (isLaunchUrl) {
      if (handledLaunchBoardUrl === url) return;
      handledLaunchBoardUrl = url;
    }
    // Signed in: Expo Router has already opened the route.
    if (isAuthenticatedRef.current) return;
    try {
      const pendingBoardLink: PendingBoardLink = { path: boardPath, stashedAt: Date.now() };
      await AsyncStorage.setItem(PENDING_BOARD_LINK_KEY, JSON.stringify(pendingBoardLink));
    } catch (error) {
      if (__DEV__) console.warn('[deep-link] failed to stash pending board link', error);
      reportHandledError(error, { tags: { source: 'deep-link', op: 'stash-pending-board-link' } });
    }
  }, []);

  const handleUrl = useCallback(
    (url: string | null, isLaunchUrl: boolean) => {
      if (!url) return;
      const sessionId = parseJoinSessionId(url);
      if (sessionId) {
        void handleSessionId(sessionId);
        return;
      }
      if (isLegacyPreviewLink(url)) {
        void handleLegacyPreview();
        return;
      }
      const boardPath = parseBoardLinkPath(url);
      if (boardPath) void handleBoardLink(url, boardPath, isLaunchUrl);
    },
    [handleBoardLink, handleLegacyPreview, handleSessionId],
  );

  // Cold start + warm links.
  useEffect(() => {
    let cancelled = false;
    void Linking.getInitialURL().then((url) => {
      if (!cancelled) handleUrl(url, true);
    });
    const subscription = Linking.addEventListener('url', ({ url }) => handleUrl(url, false));
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

  // Preserve retired /preview/pr-N links through the auth gate. The original
  // route no longer exists, so replay the safe What's New destination after
  // login. Preview selection is available from More and the user drawer.
  useEffect(() => {
    if (!isAuthenticated) return;
    let cancelled = false;
    void (async () => {
      try {
        const pendingLegacyPreview = await AsyncStorage.getItem(PENDING_LEGACY_PREVIEW_KEY);
        if (cancelled || pendingLegacyPreview !== '1') return;
        await AsyncStorage.removeItem(PENDING_LEGACY_PREVIEW_KEY);
        if (!cancelled) navigateToLegacyPreviewDestination();
      } catch (error) {
        if (__DEV__) console.warn('[deep-link] failed to consume pending legacy preview', error);
        reportHandledError(error, { tags: { source: 'deep-link', op: 'consume-pending-legacy-preview' } });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isAuthenticated, navigateToLegacyPreviewDestination]);

  // Open the board or climb a signed-out link pointed at, once, after sign-in.
  // The stored path is checked again before it reaches the router: it has to be
  // one this build would have written, and no older than a day.
  //
  // The read is handed to the onboarding gate as a promise (`board-link-replay`)
  // so the first-board picker is never pushed over the climb it opens.
  useEffect(() => {
    if (!isAuthenticated || RELAXES_ANONYMOUS_ROUTES) {
      clearBoardLinkReplay();
      return;
    }
    let cancelled = false;
    const replayed = (async (): Promise<boolean> => {
      try {
        const stored = await AsyncStorage.getItem(PENDING_BOARD_LINK_KEY);
        if (cancelled || !stored) return false;
        await AsyncStorage.removeItem(PENDING_BOARD_LINK_KEY);
        const boardPath = readPendingBoardLink(stored, Date.now());
        if (!boardPath) return false;
        // No `cancelled` check from here: the stash is already gone, so backing
        // out now would lose the climb for good. Same as the join replay above.
        // `boardPath` is a validated app path; typed routes can't know that.
        router.navigate(boardPath as Href);
        return true;
      } catch (error) {
        if (__DEV__) console.warn('[deep-link] failed to consume pending board link', error);
        reportHandledError(error, { tags: { source: 'deep-link', op: 'consume-pending-board-link' } });
        return false;
      }
    })();
    setBoardLinkReplay(replayed);
    return () => {
      cancelled = true;
    };
  }, [isAuthenticated, router]);

  return <>{children}</>;
}
