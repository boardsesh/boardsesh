import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { View, Pressable, StyleSheet, type ColorValue, type LayoutChangeEvent } from 'react-native';
import Animated, {
  FadeIn,
  FadeOut,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
  withSequence,
  runOnJS,
} from 'react-native-reanimated';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import { useTranslation } from 'react-i18next';
import { Text } from '../Text';
import { Icon } from '../Icon';
import type { IconName } from '../icon-map';
import { useTheme } from '../../providers/theme-provider';
import { hapticLight, hapticSelection, hapticSuccess } from '../../lib/haptics';
// Aliased: this file reads scheme-aware brand from `useTheme()` for foregrounds
// (slider/progress fills). `staticBrandColors` is intentionally the static set,
// used only for the active speed pill — a FILL with white text that must stay
// legible in both schemes (the lifted dark tint would fail white-on-fill).
import { brandColors as staticBrandColors } from '../../theme/colors';
import { iosSystemColors } from '../../theme/ios-colors';
import { spacing, borderRadius } from '../../theme/tokens';
import { springs, timing } from '../../theme/animations';
import { roundedReportSpeed, shouldReportSpeed } from './playback-speed-report';

// Continuous range; mirrors web's effective span. 1× is the natural default and
// gets a gentle release-magnet (see commit()).
const MIN_SPEED = 0.5;
const MAX_SPEED = 10;
const THUMB_SIZE = 20;
const TRACK_HEIGHT = 6;

// Discrete speeds the pill cycles through on tap; long-press reveals the fine
// slider for anything in between. Mirrors Apple Podcasts' tap-to-cycle control.
const SPEED_STEPS = [0.5, 1, 1.5, 2, 3] as const;

/** Next preset strictly above `current`, wrapping to the slowest past the top. */
function nextSpeedStep(current: number): number {
  return SPEED_STEPS.find((step) => step > current + 0.001) ?? SPEED_STEPS[0];
}

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

type PlaybackControlsProps = {
  frameIndex: number;
  frameCount: number;
  isPlaying: boolean;
  speed: number;
  /** Native per-frame pace (ms) — glides the progress cue at the playback cadence. */
  paceMs: number;
  onPlay: () => void;
  onPause: () => void;
  onSeek: (index: number) => void;
  onSpeedChange: (speed: number) => void;
};

// Trim a trailing `.0` like web (7.0 → "7", 6.3 → "6.3").
function formatSpeed(speed: number): string {
  const rounded = Math.round(speed * 10) / 10;
  return Number.isInteger(rounded) ? `${rounded}×` : `${rounded.toFixed(1)}×`;
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

/** A frame-step button (chevron) — distinct from the action bar's climb-skip arrows. */
function StepButton({
  direction,
  disabled,
  onPress,
  label,
  color,
}: {
  direction: 'prev' | 'next';
  disabled: boolean;
  onPress: () => void;
  label: string;
  color: ColorValue;
}) {
  const scale = useSharedValue(1);
  const animatedStyle = useAnimatedStyle(() => ({ transform: [{ scale: scale.value }] }));
  return (
    <AnimatedPressable
      onPress={onPress}
      onPressIn={() => {
        scale.value = withSpring(0.85, springs.snappy);
      }}
      onPressOut={() => {
        scale.value = withSpring(1, springs.snappy);
      }}
      disabled={disabled}
      hitSlop={8}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
      style={[styles.stepButton, animatedStyle]}
    >
      <Icon name={direction === 'prev' ? 'chevron.left' : 'chevron.right'} size={28} color={color} />
    </AnimatedPressable>
  );
}

/** Speed pill: tap cycles through the presets, long-press reveals the fine slider. */
function SpeedPill({
  label,
  active,
  onCycle,
  onToggleSlider,
  accessibilityLabel,
}: {
  label: string;
  active: boolean;
  onCycle: () => void;
  onToggleSlider: () => void;
  accessibilityLabel: string;
}) {
  const { systemColors } = useTheme();
  const scale = useSharedValue(1);
  const animatedStyle = useAnimatedStyle(() => ({ transform: [{ scale: scale.value }] }));
  return (
    <AnimatedPressable
      onPress={onCycle}
      onLongPress={onToggleSlider}
      delayLongPress={300}
      onPressIn={() => {
        scale.value = withSpring(0.92, springs.snappy);
      }}
      onPressOut={() => {
        scale.value = withSpring(1, springs.snappy);
      }}
      hitSlop={8}
      accessibilityRole="button"
      accessibilityState={{ expanded: active }}
      accessibilityLabel={accessibilityLabel}
      style={[
        styles.speedPill,
        { backgroundColor: active ? staticBrandColors.primary : systemColors.fill },
        animatedStyle,
      ]}
    >
      <Text variant="footnote" color={active ? iosSystemColors.white : systemColors.label} style={styles.speedPillText}>
        {label}
      </Text>
    </AnimatedPressable>
  );
}

/**
 * Hand-rolled speed slider on reanimated + gesture-handler — no native slider
 * dependency (which would force a fresh build and break OTA updates). The thumb
 * tracks a shared value on the UI thread and grows on grab; speed is committed
 * once on release (one engine update / one party-sync broadcast), with a haptic
 * tick every 0.5× and a magnet to 1×. The live value is reported up to the pill
 * via `onLiveChange`.
 */
function SpeedSlider({
  value,
  onChange,
  onLiveChange,
}: {
  value: number;
  onChange: (speed: number) => void;
  onLiveChange: (speed: number) => void;
}) {
  const theme = useTheme();
  const { systemColors } = theme;
  const [trackWidth, setTrackWidth] = useState(0);
  const usable = Math.max(0, trackWidth - THUMB_SIZE);
  const position = useSharedValue(0);
  const startPosition = useSharedValue(0);
  const dragging = useSharedValue(false);
  const thumbScale = useSharedValue(1);
  const lastNotch = useSharedValue(-1);
  // The last 0.1×-rounded speed pushed via `reportLive`, so the per-frame
  // worklet skips the cross-thread `runOnJS` hop (and the PlaybackControls
  // re-render it triggers) when the displayed value hasn't actually changed.
  const lastReported = useSharedValue(-1);

  const ratioToSpeed = useCallback(
    (ratio: number) => Math.round((MIN_SPEED + clamp01(ratio) * (MAX_SPEED - MIN_SPEED)) * 10) / 10,
    [],
  );

  // Keep the thumb synced to the external value while not dragging (peer sync,
  // commit echoes, resets). Skip until layout gives a real track width — otherwise
  // `usable` is 0 and the thumb snaps to the left before jumping into place. Read
  // the SharedValue with `.get()` (Reanimated JS-thread accessor), not `.value`.
  useEffect(() => {
    if (usable <= 0 || dragging.get()) return;
    position.value = clamp01((value - MIN_SPEED) / (MAX_SPEED - MIN_SPEED)) * usable;
  }, [value, usable, position, dragging]);

  const reportLive = useCallback(
    (px: number) => onLiveChange(ratioToSpeed(usable > 0 ? px / usable : 0)),
    [onLiveChange, ratioToSpeed, usable],
  );
  const commit = useCallback(
    (px: number) => {
      const raw = ratioToSpeed(usable > 0 ? px / usable : 0);
      // Gentle magnet to 1× — the natural default is easy to land on exactly.
      const snapped = Math.abs(raw - 1) <= 0.1 ? 1 : raw;
      onLiveChange(snapped);
      onChange(snapped);
    },
    [onChange, onLiveChange, ratioToSpeed, usable],
  );

  const pan = useMemo(
    () =>
      Gesture.Pan()
        // Claim the touch only on horizontal intent; a vertical drag falls
        // through to the BottomSheetScrollView (matches QueueItemRow).
        .activeOffsetX([-10, 10])
        .failOffsetY([-10, 10])
        .onBegin(() => {
          dragging.value = true;
          startPosition.value = position.value;
          thumbScale.value = withSpring(1.25, springs.snappy);
          lastNotch.value =
            Math.round((MIN_SPEED + (usable > 0 ? position.value / usable : 0) * (MAX_SPEED - MIN_SPEED)) * 2) / 2;
          lastReported.value = roundedReportSpeed(position.value, usable);
          runOnJS(hapticSelection)();
        })
        .onUpdate((event) => {
          const next = Math.max(0, Math.min(usable, startPosition.value + event.translationX));
          position.value = next;
          // Tick once per 0.5× crossed, so the continuous slider feels notched.
          const speedAtNext = MIN_SPEED + (usable > 0 ? next / usable : 0) * (MAX_SPEED - MIN_SPEED);
          const notch = Math.round(speedAtNext * 2) / 2;
          if (notch !== lastNotch.value) {
            lastNotch.value = notch;
            runOnJS(hapticSelection)();
          }
          // Gate the cross-thread report on the 0.1×-rounded display value
          // changing — without this it fires a runOnJS hop + a React setState
          // (and a PlaybackControls re-render) on every drag frame.
          const report = shouldReportSpeed(next, usable, lastReported.value);
          if (report.changed) {
            lastReported.value = report.rounded;
            runOnJS(reportLive)(next);
          }
        })
        .onEnd(() => {
          runOnJS(commit)(position.value);
        })
        .onFinalize(() => {
          dragging.value = false;
          thumbScale.value = withSpring(1, springs.snappy);
        }),
    [usable, position, startPosition, dragging, thumbScale, lastNotch, lastReported, reportLive, commit],
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

  return (
    <GestureDetector gesture={composed}>
      <View style={styles.sliderTrackWrapper} onLayout={handleLayout}>
        <View style={[styles.sliderTrack, { backgroundColor: systemColors.fill }]} />
        <Animated.View style={[styles.sliderFill, { backgroundColor: theme.brandColors.primary }, fillStyle]} />
        <Animated.View style={[styles.sliderThumb, thumbStyle]} />
      </View>
    </GestureDetector>
  );
}

/**
 * Transport + speed controls for multi-frame route playback. Rendered only when
 * the active climb is a route (`isAnimatable`); boulders never mount it. Sits in
 * its own surface tied to the board, so it reads as one player distinct from the
 * climb-level action bar below. Play is a ghost glyph (not a filled circle) so the
 * green Tick stays the only hero button; the speed pill on the right cycles the
 * presets on tap and reveals the fine slider on long-press (Apple Podcasts style),
 * keeping the resting state uncluttered.
 */
export function PlaybackControls({
  frameIndex,
  frameCount,
  isPlaying,
  speed,
  paceMs,
  onPlay,
  onPause,
  onSeek,
  onSpeedChange,
}: PlaybackControlsProps) {
  const theme = useTheme();
  const { systemColors } = theme;
  const { t } = useTranslation('session');
  const atFirstFrame = frameIndex <= 0;
  const atLastFrame = frameIndex >= frameCount - 1;
  // Pause while playing; replay (restart from 0) at the end; otherwise play.
  const mainIcon: IconName = isPlaying ? 'pause' : atLastFrame ? 'refresh' : 'play.fill';

  const [showSpeed, setShowSpeed] = useState(false);
  // Pill shows the live value while dragging, the committed speed otherwise.
  const [liveSpeed, setLiveSpeed] = useState(speed);
  useEffect(() => {
    setLiveSpeed(speed);
  }, [speed]);
  // Tap the pill to step through the speed presets (the common case); long-press
  // reveals the fine slider for anything in between.
  const cycleSpeed = useCallback(() => {
    hapticSelection();
    onSpeedChange(nextSpeedStep(speed));
  }, [onSpeedChange, speed]);
  const toggleSpeed = useCallback(() => {
    hapticLight();
    setShowSpeed((open) => !open);
  }, []);

  // Play glyph: press-scale × state-pop, combined into one transform.
  const playPress = useSharedValue(1);
  const playPulse = useSharedValue(1);
  const wasPlayingRef = useRef(isPlaying);
  useEffect(() => {
    if (wasPlayingRef.current === isPlaying) return;
    const wasPlaying = wasPlayingRef.current;
    wasPlayingRef.current = isPlaying;
    if (!isPlaying && wasPlaying && atLastFrame) {
      // Reached the end of the route — a small celebratory beat.
      hapticSuccess();
      playPulse.value = withSequence(withTiming(1.22, { duration: timing.instant }), withSpring(1, springs.bouncy));
    } else {
      playPulse.value = withSequence(withTiming(1.12, { duration: timing.instant }), withSpring(1, springs.snappy));
    }
  }, [isPlaying, atLastFrame, playPulse]);
  const playStyle = useAnimatedStyle(() => ({ transform: [{ scale: playPress.value * playPulse.value }] }));

  // Frame-progress hairline, glided at the playback cadence so it feels alive
  // rather than stepping. Snaps quickly when paused / seeking.
  const progress = useSharedValue(frameCount > 1 ? frameIndex / (frameCount - 1) : 0);
  useEffect(() => {
    const target = frameCount > 1 ? frameIndex / (frameCount - 1) : 0;
    const glide = isPlaying ? Math.max(timing.instant, paceMs / Math.max(speed, 0.01)) : timing.fast;
    progress.value = withTiming(target, { duration: glide });
  }, [frameIndex, frameCount, isPlaying, paceMs, speed, progress]);
  // transformOrigin must live in the animated style, not the static StyleSheet —
  // the latter isn't honoured for the Reanimated-driven scaleX, so the bar would
  // grow from center instead of left-to-right.
  const progressStyle = useAnimatedStyle(() => ({
    transformOrigin: 'left',
    transform: [{ scaleX: Math.max(0, progress.value) }],
  }));

  const handleMain = useCallback(() => {
    hapticSelection();
    if (isPlaying) onPause();
    else onPlay();
  }, [isPlaying, onPlay, onPause]);
  const handlePrev = useCallback(() => {
    hapticSelection();
    onSeek(frameIndex - 1);
  }, [onSeek, frameIndex]);
  const handleNext = useCallback(() => {
    hapticSelection();
    onSeek(frameIndex + 1);
  }, [onSeek, frameIndex]);

  return (
    <View style={[styles.container, { backgroundColor: systemColors.tertiaryBackground }]}>
      <Animated.View
        style={[styles.progressBar, { backgroundColor: theme.brandColors.primary }, progressStyle]}
        pointerEvents="none"
      />

      <View style={styles.transportRow}>
        <View style={styles.sideLeft}>
          <Text variant="footnote" style={styles.counter}>
            <Text style={[styles.counterCurrent, { color: systemColors.label }]}>{frameIndex + 1}</Text>
            <Text style={{ color: systemColors.secondaryLabel }}>{` / ${frameCount}`}</Text>
          </Text>
        </View>

        <View style={styles.centerGroup}>
          <StepButton
            direction="prev"
            disabled={atFirstFrame}
            onPress={handlePrev}
            label={t('playView.previousFrame')}
            color={atFirstFrame ? systemColors.tertiaryLabel : iosSystemColors.systemGray}
          />
          <AnimatedPressable
            onPress={handleMain}
            onPressIn={() => {
              playPress.value = withSpring(0.88, springs.snappy);
            }}
            onPressOut={() => {
              playPress.value = withSpring(1, springs.snappy);
            }}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel={
              isPlaying ? t('playView.pause') : atLastFrame ? t('playView.replay') : t('playView.play')
            }
            accessibilityState={{ selected: isPlaying }}
            style={[styles.playButton, playStyle]}
          >
            <Icon name={mainIcon} size={42} color={systemColors.label} />
          </AnimatedPressable>
          <StepButton
            direction="next"
            disabled={atLastFrame}
            onPress={handleNext}
            label={t('playView.nextFrame')}
            color={atLastFrame ? systemColors.tertiaryLabel : iosSystemColors.systemGray}
          />
        </View>

        <View style={styles.sideRight}>
          <SpeedPill
            label={formatSpeed(liveSpeed)}
            active={showSpeed}
            onCycle={cycleSpeed}
            onToggleSlider={toggleSpeed}
            accessibilityLabel={`${t('playView.speed')}, ${formatSpeed(liveSpeed)}`}
          />
        </View>
      </View>

      {showSpeed && (
        <Animated.View entering={FadeIn.duration(timing.fast)} exiting={FadeOut.duration(timing.instant)}>
          <SpeedSlider value={speed} onChange={onSpeedChange} onLiveChange={setLiveSpeed} />
        </Animated.View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    marginHorizontal: spacing[4],
    marginTop: spacing[2],
    borderRadius: borderRadius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: iosSystemColors.separator,
    paddingHorizontal: spacing[4],
    paddingVertical: spacing[3],
    gap: spacing[2],
    overflow: 'hidden',
  },
  progressBar: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    height: 3,
  },
  transportRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  sideLeft: {
    flex: 1,
    alignItems: 'flex-start',
  },
  sideRight: {
    flex: 1,
    alignItems: 'flex-end',
  },
  centerGroup: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[6],
  },
  stepButton: {
    width: 44,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
  playButton: {
    width: 52,
    height: 52,
    alignItems: 'center',
    justifyContent: 'center',
  },
  counter: {
    fontVariant: ['tabular-nums'],
  },
  counterCurrent: {
    fontWeight: '600',
  },
  speedPill: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    minWidth: 52,
    paddingHorizontal: spacing[3],
    paddingVertical: spacing[1],
    borderRadius: borderRadius.full,
  },
  speedPillText: {
    fontVariant: ['tabular-nums'],
    fontWeight: '600',
  },
  sliderTrackWrapper: {
    alignSelf: 'stretch',
    height: 28,
    justifyContent: 'center',
  },
  sliderTrack: {
    height: TRACK_HEIGHT,
    borderRadius: TRACK_HEIGHT / 2,
  },
  sliderFill: {
    position: 'absolute',
    left: 0,
    height: TRACK_HEIGHT,
    borderRadius: TRACK_HEIGHT / 2,
  },
  sliderThumb: {
    position: 'absolute',
    left: 0,
    width: THUMB_SIZE,
    height: THUMB_SIZE,
    borderRadius: THUMB_SIZE / 2,
    backgroundColor: iosSystemColors.white,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.2,
    shadowRadius: 3,
    elevation: 2,
  },
});
