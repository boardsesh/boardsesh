// One hand-rolled slider for a bounded number, on reanimated + gesture-handler.
//
// Hand-rolled, and staying that way: a native slider dependency would move the
// native fingerprint, force a fresh store build, and lock every OTA behind it.
// Lifted out of `PaceSlider` (playback/PlaybackControls.tsx) when the rest timer
// needed the same control — the performance details below are the reason it was
// worth sharing rather than copying, because each one is a bug somebody already
// hit:
//
//   - `lastReported` gates the per-frame `runOnJS` hop on the ROUNDED value
//     actually changing, so a drag costs the JS thread one hop per displayed
//     step rather than one per rendered frame.
//   - `committedPosition` mirrors the committed value into a shared value
//     instead of listing `value` in the gesture's deps, which would rebuild the
//     whole gesture on every commit the slider itself makes.
//   - `activeOffsetX` / `failOffsetY` claim the touch only on horizontal intent,
//     so a vertical drag falls through to whatever scrolls behind it.
//   - the re-sync effect runs only while NOT dragging, and only once layout has
//     given a real track width — otherwise the thumb snaps to the left edge and
//     jumps back on the next frame.
//
// What it does NOT own is the shape of the track. The mapping, the haptic
// ladder, the VoiceOver step and the release-magnet are injected, because they
// are the part that is about the NUMBER: a pace runs on a log track whose rungs
// widen with the value, a rest length on a power curve with rungs every 30 s.
// Each caller keeps that maths in its own module, tested there, and hands it
// over as worklets.
//
// The pan gesture is invisible to VoiceOver / TalkBack, so the track is also
// published as one `adjustable` node with increment / decrement actions.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { StyleSheet, View, type LayoutChangeEvent } from 'react-native';
import Animated, { runOnJS, useAnimatedStyle, useSharedValue, withSpring } from 'react-native-reanimated';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import { useTheme } from '../providers/theme-provider';
import { hapticSelection } from '../lib/haptics';
import { iosSystemColors } from '../theme/ios-colors';
import { springs } from '../theme/animations';
import {
  clampToRange,
  linearRatioToValue,
  linearValueToRatio,
  positionToRatio,
  shouldReportValue,
  trackPosition,
} from './value-slider.logic';

const THUMB_SIZE = 20;
const TRACK_HEIGHT = 6;

// Hoisted so the adjustable node isn't handed a fresh array every render.
const ADJUSTABLE_ACTIONS = [{ name: 'increment' }, { name: 'decrement' }] as const;

type ValueSliderProps = {
  /** The committed value. Drives the thumb whenever a drag is not in flight. */
  value: number;
  min: number;
  max: number;
  /**
   * The track's shape: the value at a 0–1 position, and the position for a
   * value. Pass both or neither — they must be exact inverses, or a cancelled
   * drag puts the thumb somewhere the value isn't. Both MUST be worklets and
   * both must clamp: they run inside the gesture, on every frame.
   *
   * The default is a straight line from `min` to `max`. A range that spans
   * orders of magnitude passes its own pair instead (`paceSecondsAtRatio` /
   * `paceRatioForSeconds`, `restSecondsAtRatio` / `restRatioForSeconds`).
   */
  ratioToValue?: (ratio: number) => number;
  valueToRatio?: (value: number) => number;
  /**
   * Quantiser for a displayed / committed value: a tenth of a second for a pace,
   * 15 s for a rest length. MUST be a worklet (`'worklet'` directive or a
   * top-level pure function the plugin can lift) — it runs inside the gesture.
   */
  round: (raw: number) => number;
  /**
   * Which rung of the haptic ladder a value sits on. The slider ticks once each
   * time this changes, so evenly spaced rungs wrap `notchIndex(value, step)` and
   * a ladder that widens with the value (the pace track's) writes its own. A
   * worklet, and stable across renders — a fresh identity rebuilds the gesture.
   */
  notch: (value: number) => number;
  /**
   * Travel floor between two ticks, in px. 0 (the default) lets every rung tick.
   * A shaped track worth tens of units per pixel at its far end passes
   * `MIN_NOTCH_TRAVEL_PX`; see that constant for why a proportional ladder must
   * not.
   */
  minNotchTravelPx?: number;
  /**
   * Optional release-magnet: given the value the slider is about to commit
   * (`rounded`) and the un-rounded value under the thumb (`raw`), return what to
   * commit.
   *
   * A function rather than a { value, tolerance } pair because the two callers
   * judge a landing in different units, and neither judgement survives being
   * made in the other's. The pace slider measures its window in DISPLAYED steps
   * — around a 0.75 s default the only reachable values are 0.7 and 0.8, so a
   * window narrower than that gap would make the magnet dead code — and commits
   * the UN-rounded magnet, which is the point: the pill reads "0.8s" either way,
   * but the pace is 750ms on the nose rather than 800. The rest slider measures
   * its window on the RAW landing instead, which is what widens 1:00's band from
   * 15 s to 20 s while leaving 0:45 and 1:15 reachable.
   */
  magnet?: (rounded: number, raw: number) => number;
  /** The spoken value. */
  format: (value: number) => string;
  accessibilityLabel: string;
  /**
   * One VoiceOver / TalkBack step, up (1) or down (-1). Must land on a value the
   * thumb could also reach, and must clamp — a screen-reader user has no thumb
   * to nudge back into range. `adjustValue` is the fixed-step version.
   */
  adjust: (value: number, direction: 1 | -1) => number;
  /** Drop the thumb's grab-grow when the OS asks for less motion. */
  reduceMotion?: boolean;
  /** Fired as the thumb moves, already gated on the rounded value changing. */
  onLiveChange: (value: number) => void;
  /** Fired once, on release (or a track tap): the one write per gesture. */
  onCommit: (value: number) => void;
  /**
   * A cancelled drag commits nothing, so whatever has been showing live values
   * has to be put back. Omit it and the slider re-reports the committed value,
   * which is right for a caller whose display is just a number; pass it when the
   * caller's display has a state this slider cannot express (the rest timer's
   * `Off`).
   */
  onCancel?: () => void;
  testID?: string;
};

export function ValueSlider({
  value,
  min,
  max,
  ratioToValue,
  valueToRatio,
  round,
  notch,
  minNotchTravelPx = 0,
  magnet,
  format,
  accessibilityLabel,
  adjust,
  reduceMotion = false,
  onLiveChange,
  onCommit,
  onCancel,
  testID,
}: ValueSliderProps) {
  const theme = useTheme();
  const { systemColors } = theme;
  const [trackWidth, setTrackWidth] = useState(0);
  const usable = Math.max(0, trackWidth - THUMB_SIZE);
  const position = useSharedValue(0);
  const startPosition = useSharedValue(0);
  const dragging = useSharedValue(false);
  const thumbScale = useSharedValue(1);
  const lastNotch = useSharedValue(-1);
  const lastNotchPosition = useSharedValue(0);
  const lastReported = useSharedValue(Number.NaN);
  const committedPosition = useSharedValue(value);

  // The straight-line fallback, for a caller that has not shaped its track.
  // Worklets, so the gesture can call them on the UI thread like any injected
  // pair, and memoised so they are not a fresh identity to rebuild it on.
  const defaultRatioToValue = useCallback(
    (ratio: number) => {
      'worklet';
      return linearRatioToValue(ratio, min, max);
    },
    [min, max],
  );
  const defaultValueToRatio = useCallback(
    (candidate: number) => {
      'worklet';
      return linearValueToRatio(candidate, min, max);
    },
    [min, max],
  );
  const toValue = ratioToValue ?? defaultRatioToValue;
  const toRatio = valueToRatio ?? defaultValueToRatio;

  // Keep the thumb synced to the external value while not dragging (peer sync,
  // commit echoes, resets, a sibling control writing the same setting). Read the
  // SharedValue with `.get()` (Reanimated's JS-thread accessor), not `.value`.
  useEffect(() => {
    committedPosition.value = value;
    if (usable <= 0 || dragging.get()) return;
    position.value = trackPosition(toRatio(value), usable);
  }, [value, usable, toRatio, position, dragging, committedPosition]);

  const reportLive = useCallback(
    (px: number) => onLiveChange(round(toValue(positionToRatio(px, usable)))),
    [onLiveChange, round, toValue, usable],
  );
  const commit = useCallback(
    (px: number) => {
      const raw = toValue(positionToRatio(px, usable));
      const rounded = round(raw);
      const snapped = magnet ? magnet(rounded, raw) : rounded;
      onLiveChange(snapped);
      onCommit(clampToRange(snapped, min, max));
    },
    [onCommit, onLiveChange, round, toValue, usable, magnet, min, max],
  );
  // A cancelled drag: the owner restores its own display if it has one this
  // slider can't express, otherwise the committed value is re-reported.
  const restore = useCallback(
    (committed: number) => {
      if (onCancel) onCancel();
      else onLiveChange(committed);
    },
    [onCancel, onLiveChange],
  );

  const pan = useMemo(
    () =>
      Gesture.Pan()
        // Claim the touch only on horizontal intent; a vertical drag falls
        // through to the scroller behind it (matches QueueItemRow).
        .activeOffsetX([-10, 10])
        .failOffsetY([-10, 10])
        .onBegin(() => {
          dragging.value = true;
          startPosition.value = position.value;
          if (!reduceMotion) thumbScale.value = withSpring(1.25, springs.snappy);
          const atThumb = round(toValue(positionToRatio(position.value, usable)));
          lastNotch.value = notch(atThumb);
          lastNotchPosition.value = position.value;
          lastReported.value = atThumb;
          runOnJS(hapticSelection)();
        })
        .onUpdate((event) => {
          const next = Math.max(0, Math.min(usable, startPosition.value + event.translationX));
          position.value = next;
          // Gate the cross-thread report on the DISPLAYED value changing —
          // without this it fires a runOnJS hop + a React setState (and a
          // re-render of whatever owns the value) on every drag frame.
          const report = shouldReportValue(next, usable, toValue, round, lastReported.value);
          if (report.changed) {
            lastReported.value = report.rounded;
            runOnJS(reportLive)(next);
          }
          // Tick once per rung crossed, so a continuous track feels detented —
          // but never twice inside `minNotchTravelPx`, which is what keeps the
          // far end of a shaped track from buzzing.
          const crossed = notch(report.rounded);
          if (crossed !== lastNotch.value && Math.abs(next - lastNotchPosition.value) >= minNotchTravelPx) {
            lastNotch.value = crossed;
            lastNotchPosition.value = next;
            runOnJS(hapticSelection)();
          }
        })
        .onEnd(() => {
          runOnJS(commit)(position.value);
        })
        .onFinalize((_event, success) => {
          dragging.value = false;
          if (!reduceMotion) thumbScale.value = withSpring(1, springs.snappy);
          // A cancelled drag never reaches `onEnd`, so nothing commits — but the
          // caller has been showing live values the whole way down and the prop
          // it mirrors never moved, so the effect that syncs them won't re-fire.
          if (!success) {
            const committed = committedPosition.value;
            position.value = trackPosition(toRatio(committed), usable);
            runOnJS(restore)(committed);
          }
        }),
    [
      usable,
      toValue,
      toRatio,
      notch,
      minNotchTravelPx,
      round,
      reduceMotion,
      position,
      startPosition,
      dragging,
      thumbScale,
      lastNotch,
      lastNotchPosition,
      lastReported,
      committedPosition,
      restore,
      reportLive,
      commit,
    ],
  );

  // Tap-to-seek on the track.
  const tap = useMemo(
    () =>
      Gesture.Tap().onEnd((event) => {
        if (usable <= 0) return;
        const next = Math.max(0, Math.min(usable, event.x - THUMB_SIZE / 2));
        position.value = next;
        runOnJS(reportLive)(next);
        runOnJS(commit)(next);
      }),
    [usable, position, reportLive, commit],
  );

  const composed = useMemo(() => Gesture.Race(pan, tap), [pan, tap]);

  const thumbStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: position.value }, { scale: thumbScale.value }],
  }));
  const fillStyle = useAnimatedStyle(() => ({ width: position.value + THUMB_SIZE / 2 }));

  const handleLayout = useCallback((event: LayoutChangeEvent) => {
    setTrackWidth(event.nativeEvent.layout.width);
  }, []);

  const handleAccessibilityAction = useCallback(
    ({ nativeEvent }: { nativeEvent: { actionName: string } }) => {
      const next = adjust(value, nativeEvent.actionName === 'increment' ? 1 : -1);
      onLiveChange(next);
      onCommit(next);
    },
    [value, adjust, onCommit, onLiveChange],
  );

  return (
    <GestureDetector gesture={composed}>
      <View
        style={styles.trackWrapper}
        onLayout={handleLayout}
        accessible
        accessibilityRole="adjustable"
        accessibilityLabel={accessibilityLabel}
        accessibilityValue={{ text: format(value), min, max, now: value }}
        accessibilityActions={ADJUSTABLE_ACTIONS}
        onAccessibilityAction={handleAccessibilityAction}
        testID={testID}
      >
        {/* Android would otherwise publish each child of an adjustable composite
            as its own node, so the slider reads as three unlabelled views. */}
        <View
          style={[styles.track, { backgroundColor: systemColors.fill }]}
          importantForAccessibility="no-hide-descendants"
        />
        <Animated.View
          style={[styles.fill, { backgroundColor: theme.brandColors.primary }, fillStyle]}
          importantForAccessibility="no-hide-descendants"
        />
        {/* White fill alone is ~1.09:1 against the track — the brand ring is what
            clears WCAG 1.4.11's 3:1 for a UI component, in both schemes. */}
        <Animated.View
          style={[styles.thumb, { borderColor: theme.brandColors.primary }, thumbStyle]}
          importantForAccessibility="no-hide-descendants"
        />
      </View>
    </GestureDetector>
  );
}

const styles = StyleSheet.create({
  trackWrapper: {
    alignSelf: 'stretch',
    height: 28,
    justifyContent: 'center',
  },
  track: {
    height: TRACK_HEIGHT,
    borderRadius: TRACK_HEIGHT / 2,
  },
  fill: {
    position: 'absolute',
    left: 0,
    height: TRACK_HEIGHT,
    borderRadius: TRACK_HEIGHT / 2,
  },
  thumb: {
    position: 'absolute',
    left: 0,
    width: THUMB_SIZE,
    height: THUMB_SIZE,
    borderRadius: THUMB_SIZE / 2,
    backgroundColor: iosSystemColors.white,
    borderWidth: 2,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowRadius: 3,
    shadowOpacity: 0.2,
    elevation: 2,
  },
});
