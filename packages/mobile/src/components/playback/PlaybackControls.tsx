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
  type SharedValue,
} from 'react-native-reanimated';
import { useTranslation } from 'react-i18next';
import { Text } from '../Text';
import { Icon } from '../Icon';
import { GlassCluster } from '../GlassCluster';
import { ValuePill } from '../ValuePill';
import { ValueSlider } from '../ValueSlider';
import type { IconName } from '../icon-map';
import { useTheme } from '../../providers/theme-provider';
import { hapticLight, hapticSelection, hapticSuccess } from '../../lib/haptics';
import { withAlpha } from '../../theme/colors';
import { glassSize } from '../../theme/layout';
import { spacing, borderRadius } from '../../theme/tokens';
import { springs, timing } from '../../theme/animations';
import {
  clampPaceSeconds,
  paceNotch,
  paceRatioForSeconds,
  paceSecondsAtNotchOffset,
  paceSecondsAtRatio,
  roundPaceSeconds,
  snapToMagnet,
  MAX_PACE_SECONDS,
  MIN_PACE_SECONDS,
} from './playback-speed-report';

/**
 * Width floor for the pace pill, sized to the longest label the control can
 * produce ("9.9s" — past ten seconds `roundPaceSeconds` drops the decimal, so
 * "60s" is shorter), so stepping through the presets doesn't resize it and walk
 * the transport row sideways.
 */
const PACE_PILL_MIN_WIDTH = 64;

// Seconds-per-frame the pill cycles through on tap; long-press reveals the fine
// slider for anything in between. Mirrors Apple Podcasts' tap-to-cycle control.
//
// Spread across the whole 0.3-60s range rather than bunched at the fast end: the
// catalogue's routes are paced from half a second to a minute a frame, and a
// preset list that stopped at 5s left two thirds of the range reachable only by
// dragging.
const PACE_STEPS = [0.5, 1, 3, 10, 20] as const;

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

/** Next pace preset strictly above `current` seconds, wrapping past the top. */
function nextPaceStep(current: number): number {
  return PACE_STEPS.find((step) => step > current + 0.001) ?? PACE_STEPS[0];
}

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

type PlaybackControlsProps = {
  frameIndex: number;
  frameCount: number;
  isPlaying: boolean;
  /**
   * Seconds the current frame is held for — what the pill displays, what the
   * slider edits, and what the progress cue glides at. The reader passes the
   * authored pace seen through its playback multiplier; the setter passes the
   * pace it is authoring. One number either way, so the two surfaces cannot
   * disagree about what the control means.
   */
  paceSeconds: number;
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
  /**
   * The pace a release near it snaps to, so one value on the track is easy to
   * land on exactly. The reader passes the climb's authored pace (snapping back
   * to what the setter intended); the setter passes the 750ms default.
   */
  magnetSeconds: number;
  onPlay: () => void;
  onPause: () => void;
  onSeek: (index: number) => void;
  /** Commits a pace. Already clamped into range by the time it fires. */
  onPaceSecondsChange: (seconds: number) => void;
};

/** The pill label, at the precision `roundPaceSeconds` keeps (3.0 → "3s"). */
function formatPace(seconds: number): string {
  const rounded = roundPaceSeconds(seconds);
  return Number.isInteger(rounded) ? `${rounded}s` : `${rounded.toFixed(1)}s`;
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
          // Capped below the 1.5 default: this row is a fixed 32dp inside a card
          // that clips, and caption1's 16dp line box at 1.5 plus 8dp of padding
          // is exactly 32 with nothing spare. The reader's copy of this chip, in
          // the transport row, keeps the full range.
          maxFontSizeMultiplier={1.2}
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
        // Dimmed by the glyph colour alone, the way the prev/next chevrons 40dp
        // away are. Stacking an opacity on `tertiaryLabel` (already ~30% alpha on
        // iOS) puts the mark near 15% and under the 3:1 non-text floor.
        style={styles.framePairButton}
        testID="playback-delete-frame"
      >
        <Icon name="minus" size={20} color={canDelete ? systemColors.secondaryLabel : systemColors.tertiaryLabel} />
      </Pressable>
    </View>
  );
}

/**
 * The pace slider: `ValueSlider` on the pace track.
 *
 * A wrapper, not an implementation — the thumb, the gesture, the per-frame
 * report gate and the cancelled-drag restore all live in the shared control,
 * which the rest timer's rest-length slider uses too. What stays here is the
 * only part that is about PACE: the log track, the ladder its haptics and its
 * VoiceOver steps walk, the magnet target and the spoken label. Each of those is
 * a reference into `playback-speed-report`, which stays the one place the pace
 * maths lives — including why the track is logarithmic (see
 * `paceSecondsAtRatio`: across a 200:1 range a linear one would bury every
 * sub-second pace in its first half-percent).
 */
function PaceSlider({
  value,
  magnetSeconds,
  onChange,
  onLiveChange,
}: {
  value: number;
  magnetSeconds: number;
  onChange: (value: number) => void;
  onLiveChange: (value: number) => void;
}) {
  const { t } = useTranslation('session');
  // Gentle magnet to the pace that matters most on this surface, so it is easy
  // to land on exactly. Judged on the DISPLAYED value and committing the
  // un-rounded target — see `snapToMagnet` for why that is the only order that
  // reaches a 750ms default.
  const magnet = useCallback((rounded: number) => snapToMagnet(rounded, magnetSeconds), [magnetSeconds]);
  // "Seconds per frame, 0.8 seconds" — the value is the duration alone, so the
  // unit isn't announced twice.
  const format = useCallback(
    (seconds: number) => t('playView.paceValueA11y', { count: roundPaceSeconds(seconds) }),
    [t],
  );
  return (
    <ValueSlider
      value={value}
      min={MIN_PACE_SECONDS}
      max={MAX_PACE_SECONDS}
      ratioToValue={paceSecondsAtRatio}
      valueToRatio={paceRatioForSeconds}
      round={roundPaceSeconds}
      // Ticks once per rung of the pace ladder crossed, so the slider feels
      // notched at every magnitude rather than only at the fast end.
      notch={paceNotch}
      magnet={magnet}
      format={format}
      accessibilityLabel={t('playView.pace')}
      // The same ladder for a user with no thumb. A fixed step would be wrong at
      // one end or the other: 0.5s is half the range below a second, and 119
      // swipes from 0.3s to a minute.
      adjust={paceSecondsAtNotchOffset}
      onLiveChange={onLiveChange}
      onCommit={onChange}
    />
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
 * The pace pill on the right cycles presets on tap and reveals the fine slider
 * on long-press (Apple Podcasts style), keeping the resting state uncluttered.
 * It reads seconds a frame on both surfaces — the reader's old ×multiplier said
 * nothing on its own, since 0.5× is 1.5s a frame on one route and 24s on the
 * next. Pass `frameEditing` to turn the reader's transport into the setter's: a
 * frame strip in place of the counter.
 */
export function PlaybackControls({
  frameIndex,
  frameCount,
  isPlaying,
  paceSeconds,
  magnetSeconds,
  peerFrameMismatch = false,
  wallStateLabel = null,
  frameEditing,
  onPlay,
  onPause,
  onSeek,
  onPaceSecondsChange,
}: PlaybackControlsProps) {
  const theme = useTheme();
  const { systemColors } = theme;
  const { t } = useTranslation('session');
  const atFirstFrame = frameIndex <= 0;
  const atLastFrame = frameIndex >= frameCount - 1;
  // Pause while playing; replay (restart from 0) at the end; otherwise play.
  const mainIcon: IconName = isPlaying ? 'pause' : atLastFrame ? 'refresh' : 'play.fill';

  const [showSlider, setShowSlider] = useState(false);
  // Pill shows the live value while dragging, the committed one otherwise.
  const [liveValue, setLiveValue] = useState(paceSeconds);
  useEffect(() => {
    setLiveValue(paceSeconds);
  }, [paceSeconds]);

  const commitValue = useCallback(
    (next: number) => {
      onPaceSecondsChange(clampPaceSeconds(next));
    },
    [onPaceSecondsChange],
  );
  // Tap the pill to step through the presets (the common case); long-press
  // reveals the fine slider for anything in between.
  const cycleValue = useCallback(() => {
    hapticSelection();
    commitValue(nextPaceStep(paceSeconds));
  }, [commitValue, paceSeconds]);
  const toggleSlider = useCallback(() => {
    hapticLight();
    setShowSlider((open) => !open);
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
    // `paceSeconds` IS the frame interval, so the cue glides at exactly the
    // cadence the engine steps at.
    const glide = isPlaying ? Math.max(timing.instant, paceSeconds * 1000) : timing.fast;
    progress.value = withTiming(target, { duration: glide });
  }, [frameIndex, frameCount, isPlaying, paceSeconds, progress]);
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

  const pillLabel = formatPace(liveValue);

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
          <ValuePill
            label={pillLabel}
            active={showSlider}
            minWidth={PACE_PILL_MIN_WIDTH}
            onCycle={cycleValue}
            onToggleSlider={toggleSlider}
            // "Seconds per frame, 0.8 seconds" — the value is the duration
            // alone, so the unit isn't announced twice.
            accessibilityLabel={`${t('playView.pace')}, ${t('playView.paceValueA11y', {
              count: roundPaceSeconds(liveValue),
            })}`}
            accessibilityHint={t('playView.paceHint')}
          />
        </View>
      </View>

      {peerFrameMismatch && (
        <Text variant="caption1" color={systemColors.secondaryLabel} style={styles.mismatchNotice}>
          {t('playView.peerFrameMismatch')}
        </Text>
      )}

      {showSlider && (
        <Animated.View entering={FadeIn.duration(timing.fast)} exiting={FadeOut.duration(timing.instant)}>
          <PaceSlider
            value={paceSeconds}
            magnetSeconds={magnetSeconds}
            onChange={commitValue}
            onLiveChange={setLiveValue}
          />
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
  wallStateChip: {
    paddingHorizontal: spacing[2],
    paddingVertical: spacing[1],
    borderRadius: borderRadius.full,
    overflow: 'hidden',
  },
  mismatchNotice: {
    textAlign: 'center',
  },
});
