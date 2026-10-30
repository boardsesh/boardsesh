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
import { markWallSwipeUsed } from '../../lib/wall-swipe-hint';
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

export type UseWallSwipeOptions = {
  /** The swipe is offered here (the model's `swipeAction`, and the flag). */
  enabled: boolean;
  /** The model says this phone drives the wall: a held swipe has landed. */
  driving: boolean;
  /** The drive the swipe started is arming (connect or first light in flight). */
  arming: boolean;
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
 *   and holds until the model says driving; a refusal, or a drive that ends
 *   before it went live (a failed connect), springs it back with an error buzz.
 * - `consumePanned` lets the Pressable drop the tap or hold a pan ended in.
 * - The frost mounts on the first touch (`frostArmed`), not before.
 */
export function useWallSwipe({
  enabled,
  driving,
  arming,
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
  const [frostArmed, setFrostArmed] = useState(false);
  const [releaseArmed, setReleaseArmed] = useState(false);
  const [committed, setCommitted] = useState(false);
  const pannedRef = useRef(false);
  const seenArmingRef = useRef(false);
  const latest = useRef({ onSwipe, onCancel });
  latest.current = { onSwipe, onCancel };

  useEffect(() => {
    widthValue.value = width;
  }, [width, widthValue]);

  const armFrost = useCallback(() => setFrostArmed(true), []);
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
    progress.value = withSpring(0, SWIPE_SPRING_BACK);
  }, [progress]);
  const handleCross = useCallback((past: boolean) => {
    setReleaseArmed(past);
    if (past) hapticMedium();
  }, []);
  const handleCommit = useCallback(() => {
    setReleaseArmed(false);
    const outcome = latest.current.onSwipe?.() ?? 'unavailable';
    if (outcome === 'started') {
      seenArmingRef.current = false;
      setCommitted(true);
      void markWallSwipeUsed();
      return;
    }
    springBack();
    hapticError();
  }, [springBack]);
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
      runOnJS(armFrost)();
    },
    onActivate: () => {
      'worklet';
      cancelAnimation(progress);
      opacity.value = 1;
      crossed.value = false;
      runOnJS(markPanned)();
    },
    onUpdate: (event) => {
      'worklet';
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
      crossed.value = false;
      if (!event.canceled && wallSwipeCommits(progress.value, event.velocityX)) {
        progress.value = withTiming(1, { duration: SWIPE_FILL_MS });
        runOnJS(handleCommit)();
        return;
      }
      progress.value = withSpring(0, SWIPE_SPRING_BACK);
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
    const fail = () => {
      setCommitted(false);
      springBack();
      hapticError();
    };
    if (driving) {
      // The full frost takes over: the wipe goes away under it.
      cancelAnimation(progress);
      progress.value = 0;
      setCommitted(false);
      return undefined;
    }
    if (arming) {
      seenArmingRef.current = true;
      return undefined;
    }
    if (seenArmingRef.current) {
      fail();
      return undefined;
    }
    const timer = setTimeout(fail, SWIPE_ARM_GRACE_MS);
    return () => clearTimeout(timer);
  }, [committed, driving, arming, progress, springBack]);

  // The one-time peek: in 28 pt and back, or under Reduce Motion a fade in place.
  const playedPeekRef = useRef(0);
  useEffect(() => {
    // Only a new token plays it, never a change of Reduce Motion.
    if (peekToken === playedPeekRef.current || preview !== null) return;
    playedPeekRef.current = peekToken;
    const share = peekProgress(widthValue.value);
    if (share <= 0) return;
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
          }),
        ),
      );
      return;
    }
    progress.value = withSequence(
      withTiming(share, { duration: PEEK_IN_MS }),
      withDelay(PEEK_HOLD_MS, withSpring(0, SWIPE_SPRING_BACK)),
    );
  }, [peekToken, preview, reduceMotion, progress, opacity, widthValue]);

  // The stories' frozen frame.
  useEffect(() => {
    if (preview === null) return;
    setFrostArmed(true);
    progress.value = preview;
    opacity.value = 1;
  }, [preview, progress, opacity]);

  /** Whether a pan just ended: the tap or hold it ended in is dropped. */
  const consumePanned = useCallback(() => pannedRef.current, []);

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
  };
}
