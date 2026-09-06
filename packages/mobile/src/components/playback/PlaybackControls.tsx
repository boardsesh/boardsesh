import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { View, Pressable, ScrollView, StyleSheet, type ColorValue, type LayoutChangeEvent } from 'react-native';
import Animated, {
  FadeIn,
  FadeOut,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
  withSequence,
  runOnJS,
  type SharedValue,
} from 'react-native-reanimated';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import { useTranslation } from 'react-i18next';
import { Text } from '../Text';
import { Icon } from '../Icon';
import { GlassCluster } from '../GlassCluster';
import type { IconName } from '../icon-map';
import { useTheme } from '../../providers/theme-provider';
import { hapticLight, hapticSelection, hapticSuccess } from '../../lib/haptics';
// Aliased: this file reads scheme-aware brand from `useTheme()` for foregrounds
// (slider/progress fills). `staticBrandColors` is intentionally the static set,
// used only for the active speed pill — a FILL with white text that must stay
// legible in both schemes (the lifted dark tint would fail white-on-fill).
import { brandColors as staticBrandColors, withAlpha } from '../../theme/colors';
import { iosSystemColors } from '../../theme/ios-colors';
import { glassSize } from '../../theme/layout';
import { spacing, borderRadius, opacity } from '../../theme/tokens';
import { springs, timing } from '../../theme/animations';
import {
  clampPaceSeconds,
  roundedReportPaceSeconds,
  roundedReportSpeed,
  shouldReportPaceSeconds,
  shouldReportSpeed,
  valueToTrackPosition,
  MAX_PACE_SECONDS,
  MIN_PACE_SECONDS,
} from './playback-speed-report';

// Continuous range; mirrors web's effective span. 1× is the natural default and
// gets a gentle release-magnet (see commit()).
const MIN_SPEED = 0.1;
const MAX_SPEED = 10;
const THUMB_SIZE = 20;
const TRACK_HEIGHT = 6;

// Discrete speeds the pill cycles through on tap; long-press reveals the fine
// slider for anything in between. Mirrors Apple Podcasts' tap-to-cycle control.
const SPEED_STEPS = [0.5, 1, 1.5, 2, 3] as const;

// Seconds-per-frame the pill cycles through when the creator is authoring the
// climb's own pace rather than reading it through a multiplier.
const PACE_STEPS = [0.5, 0.8, 1.5, 3, 5] as const;

/** The pace the release-magnet pulls to — `DEFAULT_PACE_MS` (750ms) in seconds. */
const MAGNET_PACE_SECONDS = 0.75;

// Frame-strip geometry. Chips read as chips at 32dp and reach the 44dp touch
// floor through hitSlop, and the row is now exactly one chip tall: the 44 it used
// to be bought the touch floor for a native add Button that has since moved into
// the transport row as an icon. That fixes the card's resting height in strip
// mode at 116dp (8 margin + 12 padding + 32 strip + 8 gap + 44 transport + 12
// padding); CreateDrawer reserves that number, so changing any of these changes
// a layout contract.
const CHIP_SIZE = 32;
const CHIP_GAP = spacing[2];
const CHIP_STEP = CHIP_SIZE + CHIP_GAP;
const UNDERLINE_HEIGHT = 2;

/** Next preset strictly above `current`, wrapping to the slowest past the top. */
function nextSpeedStep(current: number): number {
  return SPEED_STEPS.find((step) => step > current + 0.001) ?? SPEED_STEPS[0];
}

/** Next pace preset strictly above `current` seconds, wrapping past the top. */
function nextPaceStep(current: number): number {
  return PACE_STEPS.find((step) => step > current + 0.001) ?? PACE_STEPS[0];
}

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

// Hoisted so the adjustable node isn't handed a fresh array every render.
const ADJUSTABLE_ACTIONS = [{ name: 'increment' }, { name: 'decrement' }] as const;

/**
 * How the pill reads and writes the cadence. 'multiplier' is the reader's lens
 * over whatever pace the setter authored; 'seconds' authors that pace directly.
 */
type PaceUnit = 'multiplier' | 'seconds';

type PlaybackControlsBaseProps = {
  frameIndex: number;
  frameCount: number;
  isPlaying: boolean;
  speed: number;
  /** Native per-frame pace (ms) — glides the progress cue at the playback cadence. */
  paceMs: number;
  /**
   * A party peer is counting this route's frames differently, so their
   * playback isn't being followed. Renders a one-line passive notice.
   */
  peerFrameMismatch?: boolean;
  /**
   * Replaces the frame counter with a chip when this transport is no longer the
   * thing driving the wall. The create drawer passes "On the wall" after handing
   * the route to the queue: the wall then shows the whole route, so a counter
   * reading "2 / 3" over it would be a lie. Omit it and the counter renders.
   */
  wallStateLabel?: string | null;
  /**
   * Creator-only. Present ⇒ the card grows a frame strip, and the transport
   * row's left slot carries add/remove instead of the counter. Absent (the play
   * drawer) ⇒ the card renders the plain counter exactly as it always has, so
   * this transport stays one component across both callers.
   */
  frameEditing?: {
    /** Inserts a copy of the active frame after it. */
    onAddFrame: () => void;
    /** Removes the active frame. No-ops at one frame; the button is disabled there. */
    onDeleteFrame: () => void;
  };
  onPlay: () => void;
  onPause: () => void;
  onSeek: (index: number) => void;
  onSpeedChange: (speed: number) => void;
};

/**
 * Which unit the pill reads and writes, paired with the callback that unit needs.
 *
 * A union rather than two independent optional props: in seconds mode the pill
 * authors the climb's own `frames_pace`, so a caller that asks for seconds and
 * forgets `onPaceChange` would render a control that silently discards every
 * change. That is exactly the bug this component's seconds mode exists to fix,
 * so the type refuses to express it.
 */
type PaceControlProps =
  /** The reader's lens over whatever pace the setter authored. Shows "1×". */
  | { paceUnit?: 'multiplier'; onPaceChange?: never }
  /** The setter authoring that pace directly. Shows "0.8s". */
  | { paceUnit: 'seconds'; onPaceChange: (paceMs: number) => void };

type PlaybackControlsProps = PlaybackControlsBaseProps & PaceControlProps;

// Trim a trailing `.0` like web (7.0 → "7", 6.3 → "6.3").
function formatSpeed(speed: number): string {
  const rounded = Math.round(speed * 10) / 10;
  return Number.isInteger(rounded) ? `${rounded}×` : `${rounded.toFixed(1)}×`;
}

/** The seconds-per-frame label, trimmed the way `formatSpeed` trims (3.0 → "3s"). */
function formatPace(seconds: number): string {
  const rounded = Math.round(seconds * 10) / 10;
  return Number.isInteger(rounded) ? `${rounded}s` : `${rounded.toFixed(1)}s`;
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
      <Icon name={direction === 'prev' ? 'chevron.left' : 'chevron.right'} size={20} color={color} />
    </AnimatedPressable>
  );
}

/**
 * One frame in the strip. Selected reads as a tonal brand chip rather than a
 * fill, so the strip never competes with the Save CTA for loudest thing on the
 * sheet.
 */
const FrameChip = memo(function FrameChip({
  index,
  selected,
  label,
  onSeek,
}: {
  index: number;
  selected: boolean;
  label: string;
  onSeek: (index: number) => void;
}) {
  const { systemColors, brandColors, radii } = useTheme();
  const handlePress = useCallback(() => {
    hapticSelection();
    onSeek(index);
  }, [index, onSeek]);
  return (
    <Pressable
      onPress={handlePress}
      // 32dp chip + 6dp of slop on each edge = the 44dp touch floor, without
      // widening the 32dp strip row the card's height budget is built on.
      hitSlop={6}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ selected }}
      style={[
        styles.frameChip,
        {
          borderRadius: radii.button,
          backgroundColor: selected ? withAlpha(brandColors.primary, 0.32) : systemColors.fill,
        },
      ]}
    >
      <Text
        variant="footnote"
        color={selected ? brandColors.primary : systemColors.secondaryLabel}
        style={[styles.frameChipDigit, selected && styles.frameChipDigitSelected]}
      >
        {index + 1}
      </Text>
    </Pressable>
  );
});

/**
 * The creator's frame strip: one tappable chip per frame, in place of the
 * reader's `1 / 4` counter.
 *
 * Add and remove used to live here — add as a labelled button pinned outside the
 * scroller, remove in the header's overflow menu. Both moved into the transport
 * row below as one icon pair (`FrameEditPair`), which is what the strip's empty
 * left slot was for. The scroller now owns the full row width, so the chips no
 * longer share it with a control that must never scroll away.
 *
 * The 2dp underline is driven by the SAME shared value the reader's top progress
 * bar uses, so it glides at `paceMs / speed` during playback: one position cue on
 * the card rather than two saying the same thing.
 */
function FrameStrip({
  frameCount,
  frameIndex,
  progress,
  onSeek,
  wallStateLabel,
}: {
  frameCount: number;
  frameIndex: number;
  progress: SharedValue<number>;
  onSeek: (index: number) => void;
  /** Rendered at the strip's trailing edge, in the space the add button left.
   *  The reader shows this in the transport row's left slot, but in edit mode
   *  that slot is permanently the add/remove pair. */
  wallStateLabel: string | null;
}) {
  const { brandColors, systemColors } = useTheme();
  const { t } = useTranslation('session');
  const scrollRef = useRef<ScrollView>(null);
  const [viewportWidth, setViewportWidth] = useState(0);

  const handleViewportLayout = useCallback((event: LayoutChangeEvent) => {
    setViewportWidth(event.nativeEvent.layout.width);
  }, []);

  // Past ~9 frames the strip is wider than the row, so keep the frame you are
  // sitting on centred rather than letting playback walk it off the edge.
  useEffect(() => {
    if (viewportWidth <= 0) return;
    const chipCentre = frameIndex * CHIP_STEP + CHIP_SIZE / 2;
    scrollRef.current?.scrollTo({ x: Math.max(0, chipCentre - viewportWidth / 2), y: 0, animated: true });
  }, [frameIndex, viewportWidth]);

  const chips = useMemo(
    () =>
      Array.from({ length: frameCount }, (_, index) => ({
        index,
        label: t('playView.frameCounterA11y', { index: index + 1, total: frameCount }),
      })),
    [frameCount, t],
  );

  const travel = Math.max(0, frameCount - 1) * CHIP_STEP;
  const underlineStyle = useAnimatedStyle(() => ({ transform: [{ translateX: progress.value * travel }] }));

  return (
    <View style={styles.stripRow} testID="playback-frame-strip">
      <View style={styles.stripScroller} onLayout={handleViewportLayout}>
        <ScrollView
          ref={scrollRef}
          horizontal
          showsHorizontalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={styles.stripContent}
        >
          {chips.map((chip) => (
            <FrameChip
              key={chip.index}
              index={chip.index}
              label={chip.label}
              selected={chip.index === frameIndex}
              onSeek={onSeek}
            />
          ))}
          <Animated.View
            style={[styles.frameUnderline, { backgroundColor: brandColors.primary }, underlineStyle]}
            pointerEvents="none"
          />
        </ScrollView>
      </View>

      {wallStateLabel ? (
        <Text
          variant="caption1"
          color={systemColors.secondaryLabel}
          numberOfLines={1}
          style={[styles.wallStateChip, { backgroundColor: systemColors.fill }]}
        >
          {wallStateLabel}
        </Text>
      ) : null}
    </View>
  );
}

/**
 * Add and remove frame, as one capsule in the transport row's left slot.
 *
 * Contained rather than two bare glyphs, because the row would otherwise read as
 * five interchangeable marks: the pair is a filled capsule on `systemColors.fill`
 * and prev/play/next are bare, so the card gets one grammar — fill is a frame
 * command, bare is transport. The ink stays `secondaryLabel` so the only white
 * glyph in the row is still play.
 *
 * `minus` rather than a trash can, even though this deletes: the action bar 60dp
 * below already spends a trash on "clear every hold", and two trash cans a thumb
 * apart meaning different things is a worse confusion than the one stroke
 * between + and −. Delete is a decrement of the strip directly above it.
 *
 * Neither half is red. `DELETE_FRAME` pushes onto the undo stack (see
 * `use-create-climb.ts`), so Undo three rows down restores the frame AND the
 * index — colour is for loss you cannot walk back, and a standing red glyph here
 * would outshout Save.
 */
function FrameEditPair({
  frameIndex,
  frameCount,
  onAddFrame,
  onDeleteFrame,
}: {
  frameIndex: number;
  frameCount: number;
  onAddFrame: () => void;
  onDeleteFrame: () => void;
}) {
  // A SEPARATE hook, not `useTranslation(['session', 'climbs'])`: with an array,
  // `t('a.b.c')` resolves against the FIRST namespace only, so these keys — which
  // live in climbs.json — would fall through and the buttons would announce their
  // raw key. CreateDrawer hit exactly this and only the emulator caught it.
  const { t: tClimbs } = useTranslation('climbs');
  const { systemColors } = useTheme();
  // A route always keeps one frame, so the last one cannot be removed. Disabled
  // rather than hidden: hiding it would reflow the capsule from 88 to 44 the
  // moment a second frame appears, walking the whole transport row sideways.
  const canDelete = frameCount > 1;

  const handleAdd = useCallback(() => {
    hapticSelection();
    onAddFrame();
  }, [onAddFrame]);
  const handleDelete = useCallback(() => {
    hapticLight();
    onDeleteFrame();
  }, [onDeleteFrame]);

  return (
    <View style={[styles.framePair, { backgroundColor: systemColors.fill }]} testID="playback-frame-edit-pair">
      <Pressable
        onPress={handleAdd}
        // Asymmetric on purpose. Nothing reaches UP: the frame chips sit 8dp
        // above with 6dp of their own slop, and a chip tap that slid into a
        // frame command would be the one mis-tap this layout could cause.
        hitSlop={{ top: 0, bottom: 6, left: 4, right: 0 }}
        accessibilityRole="button"
        accessibilityLabel={tClimbs('mobile.create.playback.addFrame')}
        accessibilityHint={tClimbs('mobile.create.playback.addFrameHint', { index: frameIndex + 1 })}
        style={styles.framePairButton}
        testID="playback-add-frame"
      >
        <Icon name="plus" size={20} color={systemColors.secondaryLabel} />
      </Pressable>

      <View style={[styles.framePairDivider, { backgroundColor: systemColors.separator }]} />

      <Pressable
        onPress={handleDelete}
        disabled={!canDelete}
        hitSlop={{ top: 0, bottom: 6, left: 0, right: 4 }}
        accessibilityRole="button"
        // The ordinal AND the total live in the label, not the hint: the label is
        // the only text this control has now, and "delete frame 1" without "of 1"
        // does not tell a blind setter the route is about to lose its last frame.
        accessibilityLabel={
          canDelete
            ? tClimbs('mobile.create.playback.deleteFrameA11y', { index: frameIndex + 1, total: frameCount })
            : tClimbs('mobile.create.playback.deleteFrameBlocked')
        }
        accessibilityHint={canDelete ? tClimbs('mobile.create.playback.deleteFrameHint') : undefined}
        accessibilityState={{ disabled: !canDelete }}
        style={[styles.framePairButton, !canDelete && styles.framePairButtonDisabled]}
        testID="playback-delete-frame"
      >
        <Icon name="minus" size={20} color={canDelete ? systemColors.secondaryLabel : systemColors.tertiaryLabel} />
      </Pressable>
    </View>
  );
}

/** Cadence pill: tap cycles through the presets, long-press reveals the fine slider. */
function SpeedPill({
  label,
  active,
  onCycle,
  onToggleSlider,
  accessibilityLabel,
  accessibilityHint,
}: {
  label: string;
  active: boolean;
  onCycle: () => void;
  onToggleSlider: () => void;
  accessibilityLabel: string;
  accessibilityHint: string;
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
      accessibilityHint={accessibilityHint}
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
 * Hand-rolled cadence slider on reanimated + gesture-handler — no native slider
 * dependency (which would force a fresh build and break OTA updates). The thumb
 * tracks a shared value on the UI thread and grows on grab; the value is committed
 * once on release (one engine update / one party-sync broadcast), with a haptic
 * tick every 0.5 units and a magnet to the natural default. The live value is
 * reported up to the pill via `onLiveChange`.
 *
 * Both units share one slider: `unit` swaps the range (0.1–10× vs 0.3–10s), the
 * magnet target and the label, so the reader's multiplier and the setter's
 * seconds-per-frame can never drift into two different controls.
 */
function SpeedSlider({
  value,
  unit,
  onChange,
  onLiveChange,
}: {
  value: number;
  unit: PaceUnit;
  onChange: (value: number) => void;
  onLiveChange: (value: number) => void;
}) {
  const theme = useTheme();
  const { systemColors } = theme;
  const { t } = useTranslation('session');
  const [trackWidth, setTrackWidth] = useState(0);
  const usable = Math.max(0, trackWidth - THUMB_SIZE);
  const inSeconds = unit === 'seconds';
  const minValue = inSeconds ? MIN_PACE_SECONDS : MIN_SPEED;
  const maxValue = inSeconds ? MAX_PACE_SECONDS : MAX_SPEED;
  const position = useSharedValue(0);
  const startPosition = useSharedValue(0);
  const dragging = useSharedValue(false);
  const thumbScale = useSharedValue(1);
  const lastNotch = useSharedValue(-1);
  // The last 0.1-rounded value pushed via `reportLive`, so the per-frame
  // worklet skips the cross-thread `runOnJS` hop (and the PlaybackControls
  // re-render it triggers) when the displayed value hasn't actually changed.
  const lastReported = useSharedValue(-1);
  // The committed value, mirrored for the worklet. Listing `value` in the pan
  // gesture's deps instead would rebuild the whole gesture every time the pace
  // changes — including on every commit the slider itself makes.
  const committedPosition = useSharedValue(value);

  const ratioToValue = useCallback(
    (ratio: number) => Math.round((minValue + clamp01(ratio) * (maxValue - minValue)) * 10) / 10,
    [minValue, maxValue],
  );

  // Keep the thumb synced to the external value while not dragging (peer sync,
  // commit echoes, resets). Skip until layout gives a real track width — otherwise
  // `usable` is 0 and the thumb snaps to the left before jumping into place. Read
  // the SharedValue with `.get()` (Reanimated JS-thread accessor), not `.value`.
  useEffect(() => {
    committedPosition.value = value;
    if (usable <= 0 || dragging.get()) return;
    position.value = valueToTrackPosition(value, minValue, maxValue, usable);
  }, [value, usable, minValue, maxValue, position, dragging, committedPosition]);

  const reportLive = useCallback(
    (px: number) => onLiveChange(ratioToValue(usable > 0 ? px / usable : 0)),
    [onLiveChange, ratioToValue, usable],
  );
  const commit = useCallback(
    (px: number) => {
      const raw = ratioToValue(usable > 0 ? px / usable : 0);
      // Gentle magnet to the natural default — 1× for a reader, and 0.75s (the
      // engine's DEFAULT_PACE_MS) for a setter — so it is easy to land on exactly.
      const magnet = inSeconds ? MAGNET_PACE_SECONDS : 1;
      const snapped = Math.abs(raw - magnet) <= 0.1 ? magnet : raw;
      onLiveChange(snapped);
      onChange(snapped);
    },
    [inSeconds, onChange, onLiveChange, ratioToValue, usable],
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
            Math.round((minValue + (usable > 0 ? position.value / usable : 0) * (maxValue - minValue)) * 2) / 2;
          lastReported.value = inSeconds
            ? roundedReportPaceSeconds(position.value, usable)
            : roundedReportSpeed(position.value, usable);
          runOnJS(hapticSelection)();
        })
        .onUpdate((event) => {
          const next = Math.max(0, Math.min(usable, startPosition.value + event.translationX));
          position.value = next;
          // Tick once per 0.5 crossed, so the continuous slider feels notched.
          const valueAtNext = minValue + (usable > 0 ? next / usable : 0) * (maxValue - minValue);
          const notch = Math.round(valueAtNext * 2) / 2;
          if (notch !== lastNotch.value) {
            lastNotch.value = notch;
            runOnJS(hapticSelection)();
          }
          // Gate the cross-thread report on the 0.1-rounded display value
          // changing — without this it fires a runOnJS hop + a React setState
          // (and a PlaybackControls re-render) on every drag frame.
          const report = inSeconds
            ? shouldReportPaceSeconds(next, usable, lastReported.value)
            : shouldReportSpeed(next, usable, lastReported.value);
          if (report.changed) {
            lastReported.value = report.rounded;
            runOnJS(reportLive)(next);
          }
        })
        .onEnd(() => {
          runOnJS(commit)(position.value);
        })
        .onFinalize((_event, success) => {
          dragging.value = false;
          thumbScale.value = withSpring(1, springs.snappy);
          // A cancelled drag never reaches `onEnd`, so nothing commits — but the
          // pill has been showing live values the whole way down and the prop it
          // mirrors never moved, so the effect that syncs them won't re-fire.
          // Without this the pill keeps reading a pace the climb does not have.
          if (!success) {
            const committed = committedPosition.value;
            position.value = valueToTrackPosition(committed, minValue, maxValue, usable);
            runOnJS(onLiveChange)(committed);
          }
        }),
    [
      usable,
      inSeconds,
      minValue,
      maxValue,
      position,
      startPosition,
      dragging,
      thumbScale,
      lastNotch,
      lastReported,
      committedPosition,
      onLiveChange,
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

  // A pan gesture is invisible to VoiceOver/TalkBack, so the whole track is
  // published as one `adjustable` node with 0.5-step increment/decrement actions.
  const adjustBy = useCallback(
    (step: number) => {
      const next = Math.min(maxValue, Math.max(minValue, Math.round((value + step) * 10) / 10));
      onLiveChange(next);
      onChange(next);
    },
    [value, minValue, maxValue, onChange, onLiveChange],
  );

  return (
    <GestureDetector gesture={composed}>
      <View
        style={styles.sliderTrackWrapper}
        onLayout={handleLayout}
        accessible
        accessibilityRole="adjustable"
        accessibilityLabel={t('playView.speed')}
        accessibilityValue={{
          text: inSeconds ? formatPace(value) : formatSpeed(value),
          min: minValue,
          max: maxValue,
          now: value,
        }}
        accessibilityActions={ADJUSTABLE_ACTIONS}
        onAccessibilityAction={({ nativeEvent }) => adjustBy(nativeEvent.actionName === 'increment' ? 0.5 : -0.5)}
      >
        {/* Android would otherwise publish each child of an adjustable composite
            as its own node, so the slider reads as three unlabelled views. */}
        <View
          style={[styles.sliderTrack, { backgroundColor: systemColors.fill }]}
          importantForAccessibility="no-hide-descendants"
        />
        <Animated.View
          style={[styles.sliderFill, { backgroundColor: theme.brandColors.primary }, fillStyle]}
          importantForAccessibility="no-hide-descendants"
        />
        {/* White fill alone is ~1.09:1 against the track — the brand ring is what
            clears WCAG 1.4.11's 3:1 for a UI component, in both schemes. */}
        <Animated.View
          style={[styles.sliderThumb, { borderColor: theme.brandColors.primary }, thumbStyle]}
          importantForAccessibility="no-hide-descendants"
        />
      </View>
    </GestureDetector>
  );
}

/**
 * Transport + cadence controls for multi-frame route playback. Rendered only when
 * the active climb is a route (`isAnimatable`); boulders never mount it. Sits in
 * its own surface tied to the board, so it reads as one player distinct from the
 * climb-level action bar below.
 *
 * Prev/play/next are one 44dp cluster (iOS 26 fuses them into a single lozenge,
 * Material groups them into a surfaceContainer) rather than a 52pt hero play
 * glyph: this card is never the defining action on its sheet — Tick is, and in
 * the creator Save is — and the old glyph was the loudest thing on both.
 *
 * The cadence pill on the right cycles presets on tap and reveals the fine slider
 * on long-press (Apple Podcasts style), keeping the resting state uncluttered.
 * Pass `frameEditing` and `paceUnit="seconds"` to turn the reader's transport into
 * the setter's: a frame strip in place of the counter, and seconds-per-frame in
 * place of the multiplier.
 */
export function PlaybackControls({
  frameIndex,
  frameCount,
  isPlaying,
  speed,
  paceMs,
  peerFrameMismatch = false,
  wallStateLabel = null,
  frameEditing,
  paceUnit = 'multiplier',
  onPaceChange,
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

  const inSeconds = paceUnit === 'seconds';
  // The pill's committed value in the unit it displays: the reader sees the
  // multiplier over the author's pace, the setter sees the pace itself.
  const committedValue = inSeconds ? paceMs / 1000 : speed;

  const [showSpeed, setShowSpeed] = useState(false);
  // Pill shows the live value while dragging, the committed one otherwise.
  const [liveValue, setLiveValue] = useState(committedValue);
  useEffect(() => {
    setLiveValue(committedValue);
  }, [committedValue]);

  const commitValue = useCallback(
    (next: number) => {
      if (inSeconds) onPaceChange?.(Math.round(clampPaceSeconds(next) * 1000));
      else onSpeedChange(next);
    },
    [inSeconds, onPaceChange, onSpeedChange],
  );
  // Tap the pill to step through the presets (the common case); long-press
  // reveals the fine slider for anything in between.
  const cycleValue = useCallback(() => {
    hapticSelection();
    commitValue(inSeconds ? nextPaceStep(committedValue) : nextSpeedStep(committedValue));
  }, [commitValue, inSeconds, committedValue]);
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

  // Frame-progress cue, glided at the playback cadence so it feels alive rather
  // than stepping. Snaps quickly when paused / seeking. One shared value drives
  // BOTH presentations — the reader's top hairline and the creator's chip
  // underline — so the two can never disagree about where playback is.
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

  const pillLabel = inSeconds ? formatPace(liveValue) : formatSpeed(liveValue);

  return (
    <View
      style={[
        styles.container,
        // Scheme-resolved, not the static light `iosSystemColors.separator` this
        // used to hardcode — that value is a dark translucent grey and vanished
        // against the card's own dark fill, so the card had no edge at night.
        { backgroundColor: systemColors.tertiaryBackground, borderColor: systemColors.separator },
      ]}
    >
      {/* The strip carries its own underline off the same shared value, so the
          top hairline would be a second cue for one position. */}
      {!frameEditing && (
        <Animated.View
          style={[styles.progressBar, { backgroundColor: theme.brandColors.primary }, progressStyle]}
          pointerEvents="none"
        />
      )}

      {frameEditing && (
        <FrameStrip
          frameCount={frameCount}
          frameIndex={frameIndex}
          progress={progress}
          onSeek={onSeek}
          wallStateLabel={wallStateLabel}
        />
      )}

      <View style={styles.transportRow}>
        {/* Sized to its content in edit mode, not `flex: 1`. Two 44dp halves need
            88 and an even third of an SE's 311dp card is 81.5 — the capsule would
            have overflowed a container that clips. */}
        <View style={[styles.sideLeft, frameEditing && styles.sideLeftEditing]}>
          {frameEditing ? (
            <FrameEditPair
              frameIndex={frameIndex}
              frameCount={frameCount}
              onAddFrame={frameEditing.onAddFrame}
              onDeleteFrame={frameEditing.onDeleteFrame}
            />
          ) : wallStateLabel ? (
            <Text
              variant="caption1"
              color={systemColors.secondaryLabel}
              numberOfLines={1}
              style={[styles.wallStateChip, { backgroundColor: systemColors.fill }]}
            >
              {wallStateLabel}
            </Text>
          ) : (
            <Text
              variant="footnote"
              style={styles.counter}
              numberOfLines={1}
              accessible
              accessibilityRole="text"
              accessibilityLabel={t('playView.frameCounterA11y', { index: frameIndex + 1, total: frameCount })}
            >
              <Text style={[styles.counterCurrent, { color: systemColors.label }]}>{frameIndex + 1}</Text>
              <Text style={{ color: systemColors.secondaryLabel }}>{` / ${frameCount}`}</Text>
            </Text>
          )}
        </View>

        {/* One cluster, one height: iOS 26 merges the three into a single glass
            lozenge and Material into one surfaceContainer, which is only true
            while every member is 44dp (see GlassCluster's guardrail). */}
        <GlassCluster spacing={CHIP_GAP} style={styles.centerGroup}>
          <StepButton
            direction="prev"
            disabled={atFirstFrame}
            onPress={handlePrev}
            label={t('playView.previousFrame')}
            color={atFirstFrame ? systemColors.tertiaryLabel : systemColors.secondaryLabel}
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
            <Icon name={mainIcon} size={24} color={systemColors.label} />
          </AnimatedPressable>
          <StepButton
            direction="next"
            disabled={atLastFrame}
            onPress={handleNext}
            label={t('playView.nextFrame')}
            color={atLastFrame ? systemColors.tertiaryLabel : systemColors.secondaryLabel}
          />
        </GlassCluster>

        <View style={styles.sideRight}>
          <SpeedPill
            label={pillLabel}
            active={showSpeed}
            onCycle={cycleValue}
            onToggleSlider={toggleSpeed}
            accessibilityLabel={`${t('playView.speed')}, ${pillLabel}`}
            accessibilityHint={t('playView.speedHint')}
          />
        </View>
      </View>

      {peerFrameMismatch && (
        <Text variant="caption1" color={systemColors.secondaryLabel} style={styles.mismatchNotice}>
          {t('playView.peerFrameMismatch')}
        </Text>
      )}

      {showSpeed && (
        <Animated.View entering={FadeIn.duration(timing.fast)} exiting={FadeOut.duration(timing.instant)}>
          <SpeedSlider value={committedValue} unit={paceUnit} onChange={commitValue} onLiveChange={setLiveValue} />
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
  // One chip tall. It was 44 only so the native add Button in it could reach the
  // touch floor — that button is now the icon pair in the transport row, and the
  // chips reach 44 through hitSlop. The card's 116dp strip-mode reserve is
  // 8 margin + 12 padding + 32 here + 8 gap + 44 transport + 12 padding.
  stripRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[2],
    height: CHIP_SIZE,
  },
  stripScroller: {
    // Claims the row's whole width now that nothing is pinned beside it, except
    // when the wall-state chip takes the trailing edge.
    flex: 1,
    height: CHIP_SIZE,
  },
  stripContent: {
    alignItems: 'center',
    gap: CHIP_GAP,
  },
  frameChip: {
    width: CHIP_SIZE,
    height: CHIP_SIZE,
    alignItems: 'center',
    justifyContent: 'center',
  },
  frameChipDigit: {
    fontVariant: ['tabular-nums'],
  },
  frameChipDigitSelected: {
    fontWeight: '600',
  },
  // Out of flow, so it neither takes a slot in the gapped row nor grows it.
  // Inset from the chip's edges rather than spanning it: a full-width 2dp bar
  // flush against a rounded chip reads as a rendering seam, not a cue.
  frameUnderline: {
    position: 'absolute',
    bottom: 0,
    left: spacing[1],
    width: CHIP_SIZE - spacing[2],
    height: UNDERLINE_HEIGHT,
    borderRadius: UNDERLINE_HEIGHT / 2,
  },
  transportRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  sideLeft: {
    flex: 1,
    alignItems: 'flex-start',
  },
  // Content-sized, so the 88dp capsule is never squeezed by an even three-way
  // split of a narrow card. Costs the centre cluster ~6dp of optical centring on
  // the smallest phone, which is the cheaper of the two.
  sideLeftEditing: {
    flex: 0,
    flexShrink: 0,
  },
  // One capsule holding + and −, the Stepper idiom. `overflow: hidden` clips the
  // Android ripple to the capsule.
  framePair: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: borderRadius.full,
    overflow: 'hidden',
    height: glassSize.inline,
  },
  framePairButton: {
    width: glassSize.inline,
    height: glassSize.inline,
    alignItems: 'center',
    justifyContent: 'center',
  },
  framePairButtonDisabled: {
    opacity: opacity.disabled,
  },
  framePairDivider: {
    width: StyleSheet.hairlineWidth,
    height: 20,
  },
  sideRight: {
    flex: 1,
    alignItems: 'flex-end',
  },
  centerGroup: {
    flexDirection: 'row',
    alignItems: 'center',
    // Matches the GlassCluster `spacing`, so on iOS 26 the three shapes fuse
    // exactly as they meet instead of leaving a seam.
    gap: spacing[2],
  },
  stepButton: {
    width: 44,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
  playButton: {
    width: 44,
    height: 44,
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
    // Wide enough for the longest label the pill cycles to ("0.8s"), so stepping
    // through the presets doesn't resize it and walk the transport row sideways.
    minWidth: 64,
    // Meets the 44dp touch floor on its own now that the card has the room —
    // it used to reach it only via hitSlop, which left the pill visually
    // shorter than every control it shares the row with.
    minHeight: 44,
    paddingHorizontal: spacing[3],
    paddingVertical: spacing[1],
    borderRadius: borderRadius.full,
  },
  wallStateChip: {
    paddingHorizontal: spacing[2],
    paddingVertical: spacing[1],
    borderRadius: borderRadius.full,
    overflow: 'hidden',
  },
  mismatchNotice: {
    textAlign: 'center',
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
    borderWidth: 2,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowRadius: 3,
    shadowOpacity: 0.2,
    elevation: 2,
  },
});
