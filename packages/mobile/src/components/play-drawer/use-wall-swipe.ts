import { useCallback, useEffect, useRef, useState } from 'react';
import { usePanGesture } from 'react-native-gesture-handler';
import {
  cancelAnimation,
  runOnJS,
  useSharedValue,
  withDelay,
  withSequence,
  withSpring,
  withTiming,
} from 'react-native-reanimated';
import { hapticError, hapticMedium } from '../../lib/haptics';
import { markWallSwipeUsed, recordWallSwipePeekPlayed } from '../../lib/wall-swipe-hint';
import type { DriveStartOutcome } from './use-wall-control';
import {
  PEEK_FADE_HOLD_MS,
  PEEK_FADE_MS,
  PEEK_HOLD_MS,
  PEEK_IN_MS,
  peekProgress,
  SWIPE_ACTIVE_OFFSET_X,
  SWIPE_COMMIT_PROGRESS,
  SWIPE_FAIL_OFFSET_Y,
  SWIPE_FILL_MS,
  SWIPE_SPRING_BACK,
  wallSwipeCommits,
  wallSwipeProgress,
} from './wall-swipe';

/**
 * How long a committed swipe waits to see the drive arm before it gives up.
 * The runner arms synchronously, so the next render shows it well inside this.
 */
export const SWIPE_ARM_GRACE_MS = 1000;
/**
 * A live drive whose climb doesn't read lit yet (`markDriveLive` lands a beat
 * before the link's lit confirm): the frost holds this long for `driving`, then
 * lets go quietly. A live drive is never an error.
 */
export const SWIPE_LIVE_GRACE_MS = 1500;

export type UseWallSwipeOptions = {
  /** The swipe is offered here (the model's `swipeAction`, and the flag). */
  enabled: boolean;
  /** The model says this phone drives the wall: a held swipe has landed. */
  driving: boolean;
  /** The drive the swipe started (the model's `drivePhase`). */
  drivePhase: 'off' | 'arming' | 'live';
  /** Start driving. Anything but `started` springs back with an error buzz. */
  onSwipe?: () => DriveStartOutcome;
  /** A drag let go short of the commit point (or cancelled by the system). */
  onCancel?: () => void;
  /** The peek's counter (`useWallSwipePeek`): it plays on each change past 0. */
  peekToken: number;
  /** Reduce Motion: the peek fades where it stands instead of sliding. */
  reduceMotion: boolean;
  /** The button's measured width. */
  width: number;
  /** A frozen frame for the stories: the frost wiped in this far, no gesture. */
  preview?: number | null;
};

/**
 * The wall button's swipe left to drive (#7113): a pan that wipes the frost in
 * from the trailing edge as the finger moves, all on the UI thread.
 *
 * - Commits at 55% of the width, or on a fling under −800 pt/s past 25%.
 * - A medium buzz when the drag crosses the commit point, once per crossing.
 * - Short of it, the frost springs back. Past it, it fills the width in 150 ms
 *   and holds until the drive goes live; a refusal, or a drive that ends while
 *   still arming (a failed connect), springs it back with an error buzz.
 * - `consumePanned` lets the Pressable drop the tap or hold a pan ended in, and
 *   `noteLongPress` makes a drag after a hold that already fired do nothing.
 * - The frost mounts once a drag gets going or the peek plays (`frostArmed`),
 *   never on a plain tap, and unmounts once it is back at rest.
 */
export function useWallSwipe({
  enabled,
  driving,
  drivePhase,
  onSwipe,
  onCancel,
  peekToken,
  reduceMotion,
  width,
  preview = null,
}: UseWallSwipeOptions) {
  const progress = useSharedValue(0);
  const opacity = useSharedValue(1);
  const widthValue = useSharedValue(width);
  const crossed = useSharedValue(false);
  /** A hold fired during this touch: the board sheet is opening, so a drag does nothing. */
  const longPressed = useSharedValue(false);
  const [frostArmed, setFrostArmed] = useState(false);
  const [releaseArmed, setReleaseArmed] = useState(false);
  const [committed, setCommitted] = useState(false);
  const committedRef = useRef(false);
  const previewRef = useRef(preview);
  previewRef.current = preview;
  const pannedRef = useRef(false);
  const seenArmingRef = useRef(false);
  const latest = useRef({ onSwipe, onCancel });
  latest.current = { onSwipe, onCancel };

  useEffect(() => {
    widthValue.value = width;
  }, [width, widthValue]);

  const commit = useCallback((next: boolean) => {
    committedRef.current = next;
    setCommitted(next);
  }, []);
  const armFrost = useCallback(() => setFrostArmed(true), []);
  // Back at rest: the frost goes, so an idle button carries none of it.
  const disarmFrost = useCallback(() => {
    if (committedRef.current || previewRef.current !== null) return;
    setFrostArmed(false);
  }, []);
  const markPanned = useCallback(() => {
    pannedRef.current = true;
  }, []);
  // The Pressable's press lands after the pan ends, so the flag clears a tick later.
  const clearPanned = useCallback(() => {
    setTimeout(() => {
      pannedRef.current = false;
    }, 0);
  }, []);
  const springBack = useCallback(() => {
    progress.value = withSpring(0, SWIPE_SPRING_BACK, (finished) => {
      'worklet';
      if (finished) runOnJS(disarmFrost)();
    });
  }, [progress, disarmFrost]);
  const handleCross = useCallback((past: boolean) => {
    setReleaseArmed(past);
    if (past) hapticMedium();
  }, []);
  const handleCommit = useCallback(() => {
    setReleaseArmed(false);
    const outcome = latest.current.onSwipe?.() ?? 'unavailable';
    if (outcome === 'started') {
      seenArmingRef.current = false;
      commit(true);
      void markWallSwipeUsed();
      return;
    }
    springBack();
    hapticError();
  }, [springBack, commit]);
  const handleCancel = useCallback(() => {
    setReleaseArmed(false);
    latest.current.onCancel?.();
  }, []);

  const gesture = usePanGesture({
    enabled: enabled && !committed && preview === null,
    activeOffsetX: SWIPE_ACTIVE_OFFSET_X,
    failOffsetY: SWIPE_FAIL_OFFSET_Y,
    onBegin: () => {
      'worklet';
      longPressed.value = false;
    },
    onActivate: () => {
      'worklet';
      runOnJS(markPanned)();
      if (longPressed.value) return;
      cancelAnimation(progress);
      opacity.value = 1;
      crossed.value = false;
      runOnJS(armFrost)();
    },
    onUpdate: (event) => {
      'worklet';
      if (longPressed.value) return;
      const next = wallSwipeProgress(event.translationX, widthValue.value);
      progress.value = next;
      const past = next >= SWIPE_COMMIT_PROGRESS;
      if (past !== crossed.value) {
        crossed.value = past;
        runOnJS(handleCross)(past);
      }
    },
    onDeactivate: (event) => {
      'worklet';
      if (longPressed.value) return;
      crossed.value = false;
      if (!event.canceled && wallSwipeCommits(progress.value, event.velocityX)) {
        progress.value = withTiming(1, { duration: SWIPE_FILL_MS });
        runOnJS(handleCommit)();
        return;
      }
      // A system gesture (Android's edge back) cancels the pan: the same cancel.
      progress.value = withSpring(0, SWIPE_SPRING_BACK, (finished) => {
        'worklet';
        if (finished) runOnJS(disarmFrost)();
      });
      runOnJS(handleCancel)();
    },
    onFinalize: () => {
      'worklet';
      runOnJS(clearPanned)();
    },
  });

  // A committed swipe holds the full frost until the drive lands or ends.
  useEffect(() => {
    if (!committed) return undefined;
    const release = (withError: boolean) => {
      commit(false);
      springBack();
      if (withError) hapticError();
    };
    if (driving) {
      // The full frost takes over: the wipe goes away under it.
      cancelAnimation(progress);
      progress.value = 0;
      commit(false);
      setFrostArmed(false);
      return undefined;
    }
    if (drivePhase === 'live') {
      // Live, the climb not read lit yet: wait for it, and never buzz an error.
      seenArmingRef.current = false;
      const timer = setTimeout(() => release(false), SWIPE_LIVE_GRACE_MS);
      return () => clearTimeout(timer);
    }
    if (drivePhase === 'arming') {
      seenArmingRef.current = true;
      return undefined;
    }
    if (seenArmingRef.current) {
      release(true);
      return undefined;
    }
    const timer = setTimeout(() => release(true), SWIPE_ARM_GRACE_MS);
    return () => clearTimeout(timer);
  }, [committed, driving, drivePhase, progress, springBack, commit]);

  // The one-time peek: in 28 pt and back, or under Reduce Motion a fade in place.
  // It waits for the button's width, and only a peek that plays is counted.
  const playedPeekRef = useRef(0);
  useEffect(() => {
    // Only a new token plays it, never a change of Reduce Motion.
    if (peekToken === playedPeekRef.current || preview !== null) return;
    const share = peekProgress(width);
    if (share <= 0) return;
    playedPeekRef.current = peekToken;
    recordWallSwipePeekPlayed();
    setFrostArmed(true);
    if (reduceMotion) {
      progress.value = share;
      opacity.value = 0;
      opacity.value = withSequence(
        withTiming(1, { duration: PEEK_FADE_MS }),
        withDelay(
          PEEK_FADE_HOLD_MS,
          withTiming(0, { duration: PEEK_FADE_MS }, (finished) => {
            'worklet';
            if (!finished) return;
            progress.value = 0;
            opacity.value = 1;
            runOnJS(disarmFrost)();
          }),
        ),
      );
      return;
    }
    progress.value = withSequence(
      withTiming(share, { duration: PEEK_IN_MS }),
      withDelay(
        PEEK_HOLD_MS,
        withSpring(0, SWIPE_SPRING_BACK, (finished) => {
          'worklet';
          if (finished) runOnJS(disarmFrost)();
        }),
      ),
    );
  }, [peekToken, preview, reduceMotion, progress, opacity, width, disarmFrost]);

  // The stories' frozen frame.
  useEffect(() => {
    if (preview === null) return;
    setFrostArmed(true);
    progress.value = preview;
    opacity.value = 1;
  }, [preview, progress, opacity]);

  /** Whether a pan just ended: the tap or hold it ended in is dropped. */
  const consumePanned = useCallback(() => pannedRef.current, []);
  /** A hold fired: a drag in the same touch does nothing. */
  const noteLongPress = useCallback(() => {
    longPressed.value = true;
  }, [longPressed]);

  return {
    gesture,
    progress,
    opacity,
    frostArmed,
    /** The drag is past the commit point: the label says what letting go does. */
    releaseArmed: preview === null ? releaseArmed : preview >= SWIPE_COMMIT_PROGRESS,
    /** Let go past the commit point: the frost holds until the drive lands. */
    committed,
    consumePanned,
    noteLongPress,
  };
}
