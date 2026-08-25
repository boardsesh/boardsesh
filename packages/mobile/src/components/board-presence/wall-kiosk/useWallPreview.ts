import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  boardHistoryEntryKey,
  useBoardHistoryPagination,
  useBoardPresenceActions,
  useBoardPresenceCurrent,
  useBoardPresenceFeed,
} from '@boardsesh/board-presence-react';
import type { BoardPresenceClimb } from '@boardsesh/shared-schema';
import { useOptionalBluetoothContext } from '../../../providers/bluetooth-provider';
import { useBoardConnectionState } from '../../ble/use-board-connection-state';

/** Auto-return to live after this long with no scrub activity while previewing. */
export const PREVIEW_IDLE_MS = 30_000;

export type WallPreviewStepDirection = 'older' | 'newer';

/** Why "Light this" is unavailable, if it is. */
export type WallLightBlockedReason = 'not-driver' | 'no-frames' | 'no-leds-not-held' | null;

export type WallPreviewState = {
  /** The climb to render in the hero: the previewed one, or the live one. */
  displayedClimb: BoardPresenceClimb | null;
  /** What is physically lit on the wall right now (independent of preview). */
  liveClimb: BoardPresenceClimb | null;
  /** The previewed history entry, or null when live. */
  previewClimb: BoardPresenceClimb | null;
  isPreviewing: boolean;
  /** How many entries back from the live head the preview sits (0 = live). */
  stepsBack: number;
  /** ISO timestamp of the previewed entry, for the reel readout. */
  previewTimestamp: string | null;
  /** Total known history entries, for an "N of M" range readout. */
  historyCount: number;
  /** When the wall is dark, the newest history entry (what was last on the wall,
   *  for the idle-recovery content); null while something is lit. */
  lastLitClimb: BoardPresenceClimb | null;

  canStepOlder: boolean;
  canStepNewer: boolean;
  isLoadingOlder: boolean;

  step: (dir: WallPreviewStepDirection) => void;
  /** Jump to the oldest LOADED entry. */
  goOldest: () => void;
  /** Return to the live wall. */
  backToLive: () => void;

  /** True when EITHER transport can put the previewed climb on the wall. */
  canLight: boolean;
  lightBlockedReason: WallLightBlockedReason;
  isLighting: boolean;
  lightError: boolean;
  /** Put the previewed climb back on the wall (frames-guarded, driver-gated).
   *  On a wall with no lights that means reporting it to the board feed rather
   *  than writing LED frames — `relightPresenceClimb` picks the transport. */
  lightThis: () => void;

  /** A newer climb lit after preview began, so Light-this needs a second confirm. */
  pendingOverride: boolean;
  confirmOverride: () => void;
  cancelOverride: () => void;
};

function dedupeNewestFirst(a: BoardPresenceClimb[], b: BoardPresenceClimb[]): BoardPresenceClimb[] {
  const seen = new Set<string>();
  const out: BoardPresenceClimb[] = [];
  for (const climb of a) {
    const key = boardHistoryEntryKey(climb);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(climb);
  }
  for (const climb of b) {
    const key = boardHistoryEntryKey(climb);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(climb);
  }
  // The live window is already newest-first and older pages are strictly older,
  // but sort defensively so the scrubber's index math is always monotonic.
  out.sort((left, right) => right.seq - left.seq);
  return out;
}

/**
 * Which blocked affordance the scrubber should offer, if any. Split out of the
 * hook so the precedence is one readable ladder instead of a ternary chain: a
 * wall with no light kit gets "take the wall", an unheld wall WITH lights gets
 * the Bluetooth connect prompt, and only then does a frameless entry report as
 * such.
 */
function deriveLightBlockedReason({
  ledless,
  wallHeldLocally,
  canDriveWall,
  previewHasFrames,
}: {
  ledless: boolean;
  wallHeldLocally: boolean;
  canDriveWall: boolean;
  /** null when nothing is previewed. */
  previewHasFrames: boolean | null;
}): WallLightBlockedReason {
  if (ledless && !wallHeldLocally) return 'no-leds-not-held';
  if (!canDriveWall) return 'not-driver';
  if (previewHasFrames === false) return 'no-frames';
  return null;
}

/**
 * The wall-kiosk preview-then-confirm state machine. Stepping back/forward through
 * the wall's own history PREVIEWS a climb on the iPad only; "Light this" then re-
 * lights the physical wall over Bluetooth.
 *
 * Position is tracked by `(climbUuid, seq)` KEY, never an array index — a live
 * climb prepends to the feed and shifts every index, but the key is immutable, so
 * a scrubbed-back preview stays put across live pushes and backfill merges.
 */
export function useWallPreview(): WallPreviewState {
  const { currentClimb } = useBoardPresenceCurrent();
  const { history: liveHistory } = useBoardPresenceFeed();
  const { olderHistory, isLoadingOlder, hasMore, loadOlder } = useBoardHistoryPagination();
  const { refresh } = useBoardPresenceActions();
  const bluetooth = useOptionalBluetoothContext();
  // `canDriveWall`, not `localConnected`: a wall with no light kit is driven by a
  // virtual hold that writes zero bytes, and that climber may re-put a climb up
  // exactly like a Bluetooth driver. `ledless` / `wallHeldLocally` only decide
  // WHICH blocked affordance to offer.
  const { canDriveWall, ledless, wallHeldLocally } = useBoardConnectionState();

  const [previewKey, setPreviewKey] = useState<string | null>(null);
  const [isLighting, setIsLighting] = useState(false);
  const [lightError, setLightError] = useState(false);
  const [pendingOverride, setPendingOverride] = useState(false);
  // Bumped by every scrub action so the idle-return effect restarts even when the
  // key doesn't change (e.g. tapping "older" at the oldest loaded entry).
  const [activityNonce, setActivityNonce] = useState(0);

  const combinedHistory = useMemo(() => dedupeNewestFirst(liveHistory, olderHistory), [liveHistory, olderHistory]);

  const liveClimb = currentClimb ?? null;
  const headKey = liveClimb ? boardHistoryEntryKey(liveClimb) : null;
  // The head is the LIVE climb's slot. When the wall is DARK (currentClimb null,
  // e.g. after a clear) there is NO head, so anchor BEFORE the list (headIndex -1):
  // step('older') from idle then lands on the newest history entry (index 0 — the
  // just-cleared climb, which the old combinedHistory[0] fallback made unreachable
  // and lit the wrong, one-too-old climb), and step('newer') from index 0 returns
  // to the dark live wall.
  const liveIndex = headKey ? combinedHistory.findIndex((climb) => boardHistoryEntryKey(climb) === headKey) : -1;
  const headIndex = liveClimb ? (liveIndex < 0 ? 0 : liveIndex) : -1;

  const previewIndex = previewKey
    ? combinedHistory.findIndex((climb) => boardHistoryEntryKey(climb) === previewKey)
    : -1;
  const previewClimb = previewIndex >= 0 ? combinedHistory[previewIndex] : null;
  const isPreviewing = previewClimb !== null;

  const displayedClimb = isPreviewing ? previewClimb : liveClimb;
  const stepsBack = isPreviewing ? Math.max(0, previewIndex - headIndex) : 0;

  // Live refs so the action callbacks stay identity-stable while reading fresh state.
  const combinedRef = useRef(combinedHistory);
  combinedRef.current = combinedHistory;
  const previewIndexRef = useRef(previewIndex);
  previewIndexRef.current = previewIndex;
  const headIndexRef = useRef(headIndex);
  headIndexRef.current = headIndex;
  const previewKeyRef = useRef(previewKey);
  previewKeyRef.current = previewKey;
  const hasMoreRef = useRef(hasMore);
  hasMoreRef.current = hasMore;
  const previewClimbRef = useRef(previewClimb);
  previewClimbRef.current = previewClimb;
  const liveClimbRef = useRef(liveClimb);
  liveClimbRef.current = liveClimb;
  const canDriveWallRef = useRef(canDriveWall);
  canDriveWallRef.current = canDriveWall;
  const bluetoothRef = useRef(bluetooth);
  bluetoothRef.current = bluetooth;
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;
  const liveSeqAtStartRef = useRef<number | null>(null);
  const pendingOlderRef = useRef(false);

  const bumpActivity = useCallback(() => setActivityNonce((nonce) => nonce + 1), []);

  // Clear a stale preview key that no longer resolves (its entry aged out) rather
  // than silently showing live while `previewKey` lingers.
  useEffect(() => {
    if (previewKey !== null && previewIndex < 0 && combinedHistory.length > 0) {
      setPreviewKey(null);
    }
  }, [previewKey, previewIndex, combinedHistory.length]);

  // Record the live head seq the moment preview begins, so Light-this can tell if
  // the wall advanced underneath.
  const wasPreviewingRef = useRef(false);
  useEffect(() => {
    const now = previewKey !== null && previewIndex >= 0;
    if (now && !wasPreviewingRef.current) {
      liveSeqAtStartRef.current = liveClimbRef.current?.seq ?? null;
    } else if (!now) {
      liveSeqAtStartRef.current = null;
      if (pendingOverride) setPendingOverride(false);
      if (lightError) setLightError(false);
    }
    wasPreviewingRef.current = now;
  }, [previewKey, previewIndex, pendingOverride, lightError]);

  // Live push mid-preview: DON'T yank (the user may be mid-restore). Only snap back
  // to live when the newly-lit climb IS the one being previewed — compare UUID,
  // not seq (a re-light gets a fresh seq, so seq-equality would never fire).
  useEffect(() => {
    if (previewKeyRef.current === null) return;
    const live = liveClimbRef.current;
    const preview = previewClimbRef.current;
    if (live && preview && live.climbUuid === preview.climbUuid) {
      setPreviewKey(null);
    }
  }, [currentClimb?.climbUuid, currentClimb?.seq]);

  // After a loadOlder page arrives, advance one entry older if a step was waiting on it.
  useEffect(() => {
    if (!pendingOlderRef.current) return;
    pendingOlderRef.current = false;
    const list = combinedRef.current;
    const next = previewIndexRef.current + 1;
    if (next > 0 && next < list.length) setPreviewKey(boardHistoryEntryKey(list[next]));
  }, [olderHistory.length]);

  // Idle auto-return: any scrub bumps activityNonce and restarts the timer; going
  // live clears it. Reading history to find the right climb never yanks you out.
  useEffect(() => {
    if (previewKey === null) return undefined;
    const timer = setTimeout(() => setPreviewKey(null), PREVIEW_IDLE_MS);
    return () => clearTimeout(timer);
  }, [previewKey, activityNonce]);

  const step = useCallback(
    (dir: WallPreviewStepDirection) => {
      bumpActivity();
      const list = combinedRef.current;
      if (list.length === 0) return;
      const head = headIndexRef.current;
      const anchor = previewKeyRef.current !== null && previewIndexRef.current >= 0 ? previewIndexRef.current : head;

      if (dir === 'older') {
        const next = anchor + 1;
        if (next < list.length) {
          setPreviewKey(boardHistoryEntryKey(list[next]));
        } else if (hasMoreRef.current) {
          pendingOlderRef.current = true;
          loadOlder();
        }
        return;
      }
      // newer: stepping onto (or past) the head returns to live rather than
      // parking in a preview of the live climb. Cancel any queued 'older' advance
      // so a late-arriving page can't undo this step.
      pendingOlderRef.current = false;
      if (anchor <= head + 1) {
        setPreviewKey(null);
      } else {
        setPreviewKey(boardHistoryEntryKey(list[anchor - 1]));
      }
    },
    [bumpActivity, loadOlder],
  );

  const goOldest = useCallback(() => {
    bumpActivity();
    const list = combinedRef.current;
    const lastIndex = list.length - 1;
    if (lastIndex <= headIndexRef.current) {
      // Nothing older is loaded yet — fetch a page (the arrival effect advances one)
      // rather than leaving the button an enabled no-op.
      if (hasMoreRef.current) {
        pendingOlderRef.current = true;
        loadOlder();
      } else {
        setPreviewKey(null);
      }
      return;
    }
    pendingOlderRef.current = false;
    setPreviewKey(boardHistoryEntryKey(list[lastIndex]));
  }, [bumpActivity, loadOlder]);

  const backToLive = useCallback(() => {
    bumpActivity();
    pendingOlderRef.current = false;
    setPreviewKey(null);
  }, [bumpActivity]);

  const doRelight = useCallback(async (climb: BoardPresenceClimb) => {
    setPendingOverride(false);
    setLightError(false);
    setIsLighting(true);
    const ok = (await bluetoothRef.current?.relightPresenceClimb(climb)) ?? false;
    setIsLighting(false);
    if (ok) {
      // Do NOT force `previewKey=null` here: `reportClimbForBoard` doesn't locally
      // apply the event, so `currentClimb` still holds the OLD live climb until the
      // BOARD_NOW_PLAYING push lands — snapping to "live" now would render the wrong
      // (old) climb. Keep the preview pinned to the climb we just lit; the UUID-snap
      // effect returns to live when the echo arrives, and a catch-up refresh nudges
      // it in case the push is dropped on a never-backgrounded kiosk.
      refreshRef.current?.();
    } else {
      setLightError(true);
    }
  }, []);

  const lightThis = useCallback(() => {
    bumpActivity();
    const climb = previewClimbRef.current;
    if (!climb || !climb.frames || !canDriveWallRef.current) return;
    // Busy wall: the physical wall advanced since preview began (including from
    // dark → lit) and it isn't the climb we're about to relight → require an
    // explicit second confirm before clobbering it.
    const live = liveClimbRef.current;
    const startSeq = liveSeqAtStartRef.current;
    const wallAdvanced = !!live && (startSeq === null || live.seq > startSeq);
    if (!pendingOverride && wallAdvanced && live && live.climbUuid !== climb.climbUuid) {
      setPendingOverride(true);
      return;
    }
    void doRelight(climb);
  }, [doRelight, pendingOverride, bumpActivity]);

  const confirmOverride = useCallback(() => {
    bumpActivity();
    const climb = previewClimbRef.current;
    if (!climb) return;
    void doRelight(climb);
  }, [doRelight, bumpActivity]);

  const cancelOverride = useCallback(() => {
    bumpActivity();
    setPendingOverride(false);
  }, [bumpActivity]);

  // Order matters: on a wall flagged as having no lights the answer is never
  // "connect Bluetooth" — there is nothing to connect to — so the take-the-wall
  // offer wins over the Bluetooth prompt.
  const lightBlockedReason = deriveLightBlockedReason({
    ledless,
    wallHeldLocally,
    canDriveWall,
    previewHasFrames: previewClimb ? !!previewClimb.frames : null,
  });
  const canLight = isPreviewing && canDriveWall && !!previewClimb?.frames && !isLighting;

  // Older is available while previewing if there's a loaded entry below the current
  // one (or a page to fetch); at live, if any entry sits below the head. The stale
  // `hasMore` (true before the first fetch) only enables the control to TRIGGER a
  // fetch — `step`/`goOldest` call `loadOlder`, so it's never a dead affordance.
  const canStepOlder = isPreviewing
    ? previewIndex < combinedHistory.length - 1 || hasMore
    : combinedHistory.length > headIndex + 1 || hasMore;
  const canStepNewer = isPreviewing && previewIndex > headIndex;

  const previewTimestamp = previewClimb?.sentAt ?? null;
  const historyCount = combinedHistory.length;
  // When the wall is dark, the newest history entry is what was last on the wall —
  // the idle-recovery content. While something is lit there's nothing to recover.
  const lastLitClimb = liveClimb === null ? (combinedHistory[0] ?? null) : null;

  // Memoize so a re-render that doesn't change any field lets the memoized
  // consumers (WallChromeRegion / WallScrubber) bail out of re-rendering.
  return useMemo<WallPreviewState>(
    () => ({
      displayedClimb,
      liveClimb,
      previewClimb,
      isPreviewing,
      stepsBack,
      previewTimestamp,
      historyCount,
      lastLitClimb,
      canStepOlder,
      canStepNewer,
      isLoadingOlder,
      step,
      goOldest,
      backToLive,
      canLight,
      lightBlockedReason,
      isLighting,
      lightError,
      lightThis,
      pendingOverride,
      confirmOverride,
      cancelOverride,
    }),
    [
      displayedClimb,
      liveClimb,
      previewClimb,
      isPreviewing,
      stepsBack,
      previewTimestamp,
      historyCount,
      lastLitClimb,
      canStepOlder,
      canStepNewer,
      isLoadingOlder,
      step,
      goOldest,
      backToLive,
      canLight,
      lightBlockedReason,
      isLighting,
      lightError,
      lightThis,
      pendingOverride,
      confirmOverride,
      cancelOverride,
    ],
  );
}
