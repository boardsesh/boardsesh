import { useEffect, useMemo, useRef, useState } from 'react';
import { Platform } from 'react-native';
import type { ClimbQueueItem } from '@boardsesh/queue';
import { parseSetIds, toBoardName } from '@boardsesh/board-config';
import type { BoardConnection } from '../../components/play-drawer/lightbulb-control';
import { getAuthToken } from '../auth-store';
import { BACKEND_URL, WEB_BASE_URL } from '../env';
import {
  startLiveActivitySession,
  endLiveActivitySession,
  updateLiveActivity,
  updateLiveActivityClimb,
  isLiveActivityAvailable,
} from './live-activity-plugin';

type BoardConfig = {
  boardName: string;
  layoutId: number;
  sizeId: number;
  setIds: string;
};

type AndroidNotificationStrings = {
  channelName: string;
  channelDescription: string;
  contentTitleFallback: string;
  previousLabel: string;
  nextLabel: string;
  relightLabel: string;
  reconnectLabel: string;
  onWallTemplate: string;
};

type UseLiveActivityOptions = {
  queue: ClimbQueueItem[];
  currentClimbQueueItem: ClimbQueueItem | null;
  board: BoardConfig | null;
  sessionId: string | null;
  isSessionActive: boolean;
  widgetNavigationAllowed: boolean;
  isPartySession: boolean;
  /** Board-connection ownership; drives the widget bulb + Previous/Next visibility. */
  boardConnection: BoardConnection;
  /** Display name of the peer holding the board (heldByPeer only). */
  holderDisplayName?: string | null;
  /** Localized strings for the Android foreground-service notification (ignored on iOS). */
  androidNotification?: AndroidNotificationStrings;
  /** Android-only on-device thumbnail (BoardRenderer overlay + bundled backgrounds). */
  androidThumbnailOverlayPath?: string | null;
  androidThumbnailBackgroundPaths?: string[];
};

// Both iOS (ActivityKit) and Android (foreground service) back the session-
// presence surface; everything else short-circuits at the plugin layer.
const supportsSessionPresence = Platform.OS === 'ios' || Platform.OS === 'android';

function getGraphqlHttpUrl(): string {
  return `${BACKEND_URL.replace(/\/+$/, '')}/graphql`;
}

function getGraphqlWsUrl(): string {
  return BACKEND_URL.replace(/^http(s?):\/\//, 'ws$1://').replace(/\/+$/, '') + '/graphql';
}

// Resolve the bundled board-background webp file path(s) for a board config so
// the iOS widget can composite them behind the server's holds-only overlay
// (the no-network-board-art rule — board photos ship in the bundle, never
// fetched). iOS-only: Android's foreground service has no board thumbnail.
// Resolving BEFORE startSession means the paths are staged ahead of the first
// thumbnail pre-fetch, so the initial composite already carries the board photo.
// Never rejects: a missing/partial bundle yields fewer (or zero) layers and the
// widget falls back to overlay-only.
async function resolveBoardBackgroundPaths(board: BoardConfig): Promise<string[]> {
  if (Platform.OS !== 'ios') return [];
  // Validate the loose board string against the BoardName union instead of an
  // unchecked cast — an unknown board (or empty config) skips compositing and
  // the widget falls back to the holds-only overlay.
  const boardName = toBoardName(board.boardName);
  if (!boardName) return [];
  const setIds = parseSetIds(board.setIds);
  try {
    // Imported lazily so module load doesn't pull in expo-asset + the bundled
    // board-art manifest (which require()s every board background) until a Live
    // Activity actually starts on iOS — and so non-iOS / test environments
    // without the native asset bridge never evaluate it.
    const { ensureBackgroundsCached } = await import('../background-image-cache');
    const result = await ensureBackgroundsCached({
      boardName,
      layoutId: board.layoutId,
      sizeId: board.sizeId,
      setIds,
      variant: 'thumb',
    });
    const paths = result?.paths ?? [];
    if (paths.length === 0) {
      // Pairs with the native "no board-background paths staged" log: if this
      // fires, the board photo is missing because resolution came back empty
      // (board not bundled / manifest miss), not because native couldn't read it.
      // eslint-disable-next-line no-console
      console.warn(
        `[LiveActivity] no bundled backgrounds for ${boardName}/${board.layoutId}/${board.sizeId}/${board.setIds} ` +
          `(missing ${result?.missingCount ?? 'n/a'})`,
      );
    }
    return paths;
  } catch (error) {
    // eslint-disable-next-line no-console
    console.warn('[LiveActivity] board-background resolution threw:', error instanceof Error ? error.message : error);
    return [];
  }
}

// React Native port of `packages/web/app/lib/live-activity/use-live-activity.ts`.
//
// Lifecycle: starts a session presence when (iOS or Android) + (session active)
// + (board selected) + (queue has content) + (the native surface is available —
// Live Activities authorized on iOS; always true on Android, where the
// foreground service runs regardless of POST_NOTIFICATIONS and notification
// visibility is the OS's separate concern).
// Pushes initial state, then watches the serialized queue (full update) and
// current climb (lightweight update). On iOS this drives ActivityKit; on Android
// it drives the foreground service + ongoing notification (the SessionPresence
// module). The plugin layer selects the platform module behind one API.
//
// On Expo Go / preview builds without the native module, every call short-
// circuits at the plugin layer (the selected module is null), so this hook is
// safe to mount unconditionally.
export function useLiveActivity({
  queue,
  currentClimbQueueItem,
  board,
  sessionId,
  isSessionActive,
  widgetNavigationAllowed,
  isPartySession,
  boardConnection,
  holderDisplayName,
  androidNotification,
  androidThumbnailOverlayPath,
  androidThumbnailBackgroundPaths,
}: UseLiveActivityOptions): void {
  const isActiveRef = useRef(false);
  const generationRef = useRef(0);
  const [available, setAvailable] = useState<boolean | null>(null);
  const [authToken, setAuthToken] = useState<string | null>(null);
  const [authTokenLoaded, setAuthTokenLoaded] = useState(false);

  // Keep refs for values the start callback needs without triggering restarts
  const sessionIdRef = useRef(sessionId);
  sessionIdRef.current = sessionId;
  const authTokenRef = useRef(authToken);
  authTokenRef.current = authToken;
  const androidNotificationRef = useRef(androidNotification);
  androidNotificationRef.current = androidNotification;
  const widgetNavigationAllowedRef = useRef(widgetNavigationAllowed);
  widgetNavigationAllowedRef.current = widgetNavigationAllowed;
  const isPartySessionRef = useRef(isPartySession);
  isPartySessionRef.current = isPartySession;
  const boardConnectionRef = useRef(boardConnection);
  boardConnectionRef.current = boardConnection;
  const holderDisplayNameRef = useRef(holderDisplayName);
  holderDisplayNameRef.current = holderDisplayName;
  const overlayPathRef = useRef(androidThumbnailOverlayPath);
  overlayPathRef.current = androidThumbnailOverlayPath;
  const backgroundPathsRef = useRef(androidThumbnailBackgroundPaths);
  backgroundPathsRef.current = androidThumbnailBackgroundPaths;
  const queueRef = useRef(queue);
  queueRef.current = queue;
  const currentClimbRef = useRef(currentClimbQueueItem);
  currentClimbRef.current = currentClimbQueueItem;

  // Memoize queue serialization so it only recomputes when the queue array
  // changes, not on every currentClimbQueueItem navigation.
  const serializedQueue = useMemo(
    () =>
      queue.map((q) => ({
        uuid: q.uuid,
        climbUuid: q.climb.uuid,
        climbName: q.climb.name,
        difficulty: q.climb.difficulty,
        angle: q.climb.angle,
        frames: q.climb.frames,
        setterUsername: q.climb.setter_username,
        mirrored: q.climb.mirrored === true,
      })),
    [queue],
  );
  const serializedQueueRef = useRef(serializedQueue);
  serializedQueueRef.current = serializedQueue;

  // Stabilize board by value so reference changes don't restart the session
  const boardKey = board ? `${board.boardName}:${board.layoutId}:${board.sizeId}:${board.setIds}` : null;
  // eslint-disable-next-line react-hooks/exhaustive-deps -- intentionally keyed by boardKey for value-based stability
  const stableBoard = useMemo(() => board, [boardKey]);

  // Check availability once on mount.
  useEffect(() => {
    if (!supportsSessionPresence) return;
    let cancelled = false;
    void isLiveActivityAvailable().then((result) => {
      if (!cancelled) setAvailable(result);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // Load auth token once. Re-load if the start effect's deps change (cheap
  // enough — SecureStore read).
  useEffect(() => {
    if (!supportsSessionPresence) return;
    let cancelled = false;
    void getAuthToken().then((token) => {
      if (cancelled) return;
      setAuthToken(token);
      setAuthTokenLoaded(true);
    });
    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  // Start/end session — reacts to session activation, content presence, and
  // board config. Does NOT restart when the current climb changes.
  const hasContent = queue.length > 0 || currentClimbQueueItem !== null;
  const shouldBeActive = isSessionActive && hasContent && stableBoard !== null && available === true && authTokenLoaded;

  useEffect(() => {
    if (!supportsSessionPresence || available !== true) return;

    if (shouldBeActive && !isActiveRef.current && stableBoard) {
      isActiveRef.current = true;
      const startGeneration = ++generationRef.current;

      void resolveBoardBackgroundPaths(stableBoard)
        .then((boardBackgroundPaths) => {
          // A teardown or board/session change during background resolution
          // supersedes this start — bail before requesting the activity so we
          // don't leave a dangling one the cleanup already tried to end.
          if (!isActiveRef.current || generationRef.current !== startGeneration) return undefined;
          return startLiveActivitySession({
            sessionId: sessionIdRef.current ?? `local-${Date.now()}`,
            serverUrl: WEB_BASE_URL,
            wsUrl: getGraphqlWsUrl(),
            graphqlUrl: getGraphqlHttpUrl(),
            authToken: authTokenRef.current ?? undefined,
            boardName: stableBoard.boardName,
            layoutId: stableBoard.layoutId,
            sizeId: stableBoard.sizeId,
            setIds: stableBoard.setIds,
            widgetNavigationAllowed: widgetNavigationAllowedRef.current,
            isPartySession: isPartySessionRef.current,
            boardConnection: boardConnectionRef.current,
            holderDisplayName: holderDisplayNameRef.current,
            boardBackgroundPaths,
            androidNotification: androidNotificationRef.current,
          });
        })
        .then(() => {
          if (!isActiveRef.current || generationRef.current !== startGeneration) return;
          // Send an initial update so the widget doesn't stay on "Loading...".
          const q = queueRef.current;
          const displayItem = currentClimbRef.current ?? (q.length > 0 ? q[0] : null);
          if (!displayItem) return;
          const idx = q.findIndex((item) => item.uuid === displayItem.uuid);
          if (idx === -1) return;
          void updateLiveActivity({
            climbName: displayItem.climb.name,
            climbDifficulty: displayItem.climb.difficulty,
            angle: displayItem.climb.angle,
            currentIndex: idx,
            totalClimbs: q.length,
            hasNext: idx < q.length - 1,
            hasPrevious: idx > 0,
            climbUuid: displayItem.climb.uuid,
            queue: serializedQueueRef.current,
            widgetNavigationAllowed: widgetNavigationAllowedRef.current,
            isPartySession: isPartySessionRef.current,
            boardConnection: boardConnectionRef.current,
            holderDisplayName: holderDisplayNameRef.current,
            androidThumbnailOverlayPath: overlayPathRef.current,
            androidThumbnailBackgroundPaths: backgroundPathsRef.current,
          });
        })
        .catch((error) => {
          // A newer start superseded this one — its own .then/.catch owns the
          // state, so stay silent.
          if (generationRef.current !== startGeneration) return;
          // Log first so a real start failure is never swallowed, even if the
          // session was torn down (isActiveRef false) while the start was in
          // flight — only the state reset below is conditional on still being active.
          console.warn('[LiveActivity] startSession failed:', error);
          if (!isActiveRef.current) return;
          isActiveRef.current = false;
          // Native startSession connects the WebSocket and writes the shared
          // keychain/App-Group state BEFORE the Activity.request that threw, so
          // tear those down here — JS otherwise believes nothing is active and
          // never reaches the teardown paths. endSession is idempotent.
          void endLiveActivitySession();
        });
    } else if (!shouldBeActive && isActiveRef.current) {
      void endLiveActivitySession();
      isActiveRef.current = false;
    }

    return () => {
      if (isActiveRef.current) {
        void endLiveActivitySession();
        isActiveRef.current = false;
      }
    };
  }, [shouldBeActive, stableBoard, available]);

  // Stable scalar trigger for the on-device thumbnail backgrounds: the paths array
  // has a fresh identity each render, so depending on it directly would churn the
  // effects, but excluding it entirely drops a LATE background resolution (cold
  // asset cache) from the notification until some other dep changes. The joined
  // string changes only when the resolved backgrounds change, so it re-fires the
  // push exactly when needed.
  // JSON.stringify keeps the key unambiguous: two distinct path lists can never
  // collide into one string (no single delimiter that a path might itself contain).
  const backgroundsKey = androidThumbnailBackgroundPaths ? JSON.stringify(androidThumbnailBackgroundPaths) : '';

  // Track whether the queue-sync effect fired this render cycle so the
  // climb-nav effect can skip its redundant lightweight update.
  const queueSyncedRef = useRef(false);

  // Effect 1: Queue sync — sends the full queue when items change.
  useEffect(() => {
    if (!isActiveRef.current || !stableBoard) return;

    const displayItem = currentClimbRef.current ?? (queueRef.current.length > 0 ? queueRef.current[0] : null);
    if (!displayItem) return;

    const currentIndex = queueRef.current.findIndex((q) => q.uuid === displayItem.uuid);
    if (currentIndex === -1) return;

    queueSyncedRef.current = true;
    // Reset on the next microtask so Effect 2 (climb-nav) sees true during
    // this render's synchronous effect flush, then starts the next render
    // clean. Effect 1 MUST remain declared before Effect 2 in source order —
    // React runs effects top-to-bottom within a render.
    queueMicrotask(() => {
      queueSyncedRef.current = false;
    });

    void updateLiveActivity({
      climbName: displayItem.climb.name,
      climbDifficulty: displayItem.climb.difficulty,
      angle: displayItem.climb.angle,
      currentIndex,
      totalClimbs: queueRef.current.length,
      hasNext: currentIndex < queueRef.current.length - 1,
      hasPrevious: currentIndex > 0,
      climbUuid: displayItem.climb.uuid,
      queue: serializedQueue,
      widgetNavigationAllowed,
      isPartySession,
      boardConnection,
      holderDisplayName,
      androidThumbnailOverlayPath,
      androidThumbnailBackgroundPaths,
    });
  }, [
    androidThumbnailOverlayPath,
    // Depend on backgroundsKey, not the array itself: it changes only when the
    // resolved backgrounds change, so it re-fires the push when late-resolving
    // backgrounds arrive (the array is read at effect time).
    backgroundsKey,
    boardConnection,
    holderDisplayName,
    isPartySession,
    serializedQueue,
    stableBoard,
    widgetNavigationAllowed,
  ]);

  // Effect 2: Climb navigation — lightweight update with only scalar data.
  useEffect(() => {
    if (!isActiveRef.current || !stableBoard) return;
    if (queueSyncedRef.current) return;

    const displayItem = currentClimbQueueItem ?? (queue.length > 0 ? queue[0] : null);
    if (!displayItem) return;

    const currentIndex = queue.findIndex((q) => q.uuid === displayItem.uuid);
    if (currentIndex === -1) return;

    void updateLiveActivityClimb({
      climbName: displayItem.climb.name,
      climbDifficulty: displayItem.climb.difficulty,
      angle: displayItem.climb.angle,
      currentIndex,
      totalClimbs: queue.length,
      hasNext: currentIndex < queue.length - 1,
      hasPrevious: currentIndex > 0,
      climbUuid: displayItem.climb.uuid,
      widgetNavigationAllowed,
      isPartySession,
      boardConnection,
      holderDisplayName,
      androidThumbnailOverlayPath,
      androidThumbnailBackgroundPaths,
    });
  }, [
    androidThumbnailOverlayPath,
    // See Effect 1: backgroundsKey re-fires the push on a late background resolution.
    backgroundsKey,
    boardConnection,
    currentClimbQueueItem,
    holderDisplayName,
    isPartySession,
    queue,
    stableBoard,
    widgetNavigationAllowed,
  ]);
}
