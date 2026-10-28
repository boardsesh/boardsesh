// The floating rest-timer readout (#5378) — the one surface that answers "how
// long have I been resting, and is my phone about to move the wall on me".
//
// PERFORMANCE CONTRACT: the 1 Hz ticker is LOCAL to this component (and to
// `RestTimerClock` below). Nothing above either of them re-renders per second.
// That is why the machine state lives in a module store read through
// `useSyncExternalStore` rather than a context — see lib/rest-timer-store.ts.
//
// Time is read through `nowMs()` from lib/clock, never `Date.now()`: screenshot
// mode freezes it, so a capture of a running timer is byte-identical run to run.

import { useCallback, useEffect, useState } from 'react';
import type { TFunction } from 'i18next';
import {
  StyleSheet,
  View,
  type AccessibilityActionEvent,
  type AccessibilityActionInfo,
  type ColorValue,
} from 'react-native';
import { useTranslation } from 'react-i18next';
import { LargeContentViewer } from '../LargeContentViewer';
import { Text } from '../Text';
import { Icon } from '../Icon';
import { PressableSurface } from '../PressableSurface';
import { useTheme } from '../../providers/theme-provider';
import { useReduceMotion } from '../../hooks/use-reduce-motion';
import { useRestTimerState } from '../../hooks/use-rest-timer';
import { useEffectiveRestPacing } from '../../hooks/use-effective-rest-pacing';
import { nowMs } from '../../lib/clock';
import { hapticMedium } from '../../lib/haptics';
import { pauseRestTimer, resetRestTimer, resumeRestTimer } from '../../lib/rest-timer-store';
import {
  formatRestTimerElapsed,
  formatRestTimerSigned,
  formatRestTimerTarget,
  isRestTimerTargetExceeded,
} from '../../lib/rest-timer';
import {
  getMsUntilNextRestTimerSecond,
  getRestTimerCountdownLeadSeconds,
  getRestTimerCycleElapsedSeconds,
  isRestTimerFinalCountdown,
} from '../../lib/rest-timer-auto-advance';
import { REST_TIMER_PILL_HEIGHT, TOOLBAR_CAPSULE_MAX_WIDTH, glassSize } from '../../theme/layout';
import { spacing } from '../../theme/tokens';
import { CHROME_LABEL_MAX_FONT_SCALE, REST_CLOCK_MAX_FONT_SCALE } from '../../theme/typography';
import { TICK_GUTTER } from '../tick/tick-sheet-metrics';
import { AccessoryBarSurface } from './AccessoryBarSurface';
import { RestTimerPacerCaption } from './RestTimerPacerCaption';

/** Narrowest the full-size pill goes, so a short "0:12" still reads as a pill. */
const PILL_MIN_WIDTH = 120;

const RESET_ACTION = 'rest-timer-reset';

/**
 * What the climber is looking at. Ordered by precedence, which is also the order
 * the states are resolved in {@link useRestTimerDisplay}:
 *
 *   waiting     armed, nothing to count from yet (afterTick before the first tick)
 *   paused      frozen; the number does not move
 *   queueEnded  an auto-advance found nothing left to advance to
 *   exceeded    past the target — the red state, deliberately NOT green
 *   final       the last seconds before the target, through 0:00 (#5396): the
 *               brand tint, so "get on the holds now" is one glance
 *   running     counting up, still inside the target
 */
export type RestTimerPhase = 'waiting' | 'paused' | 'queueEnded' | 'exceeded' | 'final' | 'running';

/**
 * The 1 Hz ticker. Deliberately a component-local `useState` + `setTimeout`
 * rather than anything shared: every consumer that calls this re-renders once a
 * second, so it must only ever be called by a leaf. No timer exists at all while
 * `active` is false (paused, waiting for a tick, disarmed), so a pill that is not
 * counting costs nothing.
 *
 * Each wait runs to the anchor's next whole second, not a flat 1000 ms, so the
 * digits flip on the same instants the countdown cues land on (#5396). A free
 * interval started part way through a second shows "0:03" up to a second after
 * the "3" buzz.
 */
export function useRestTimerNow(active: boolean, anchorMs: number | null): number {
  const [now, setNow] = useState<number>(() => nowMs());

  useEffect(() => {
    if (!active) return undefined;
    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    // Sampled straight away: the pill may have been mounted (or resumed) part
    // way through a second.
    const sample = () => {
      const sampledAtMs = nowMs();
      setNow(sampledAtMs);
      timeoutId = setTimeout(sample, getMsUntilNextRestTimerSecond(anchorMs, sampledAtMs));
    };
    sample();
    return () => {
      if (timeoutId !== null) clearTimeout(timeoutId);
    };
  }, [active, anchorMs]);

  return now;
}

export type RestTimerDisplay = {
  armed: boolean;
  isRunning: boolean;
  phase: RestTimerPhase;
  elapsedSeconds: number;
  targetSeconds: number | null;
  /**
   * Rest left, going NEGATIVE once the beat has gone. `null` when the rest
   * length is Off and there is nothing to count down from.
   */
  remainingSeconds: number | null;
  /**
   * The number on the clock. With a rest set this counts DOWN — and keeps going
   * past zero into the negative, so "how far over am I" is the same glance as
   * "how long left". With no rest set there is nothing to count down from, so it
   * counts up from the tick instead.
   */
  displayLabel: string;
  /** Compact target, e.g. `2m` / `1:30`. `null` when the rest length is Off. */
  targetLabel: string | null;
  /** In `queueEnded`: it was the end of the list being walked, with the queue still behind it. */
  listEnded: boolean;
  /** How many seconds the final countdown runs for this rest. 0 with no rest set. */
  leadSeconds: number;
};

/**
 * Everything a rest-timer readout shows, derived once. Calls
 * {@link useRestTimerNow}, so ONLY a leaf component may call it — a screen that
 * wants a live clock renders {@link RestTimerClock} instead of calling this.
 */
export function useRestTimerDisplay(): RestTimerDisplay {
  const { armed, anchorMs, isRunning, pausedElapsedSeconds, queueEnded, listEnded } = useRestTimerState();
  const { targetSeconds, mode } = useEffectiveRestPacing();

  // Only a running timer with something to count from needs a heartbeat.
  const ticking = armed && isRunning && anchorMs !== null;
  const now = useRestTimerNow(ticking, anchorMs);

  const elapsedSeconds = getRestTimerCycleElapsedSeconds({
    mode,
    anchorMs,
    targetSeconds,
    nowMs: now,
    isRunning,
    pausedElapsedSeconds,
  });
  const hasTarget = targetSeconds !== null && targetSeconds > 0;
  const exceeded = hasTarget && isRestTimerTargetExceeded(elapsedSeconds, targetSeconds);
  const remainingSeconds = hasTarget ? targetSeconds - elapsedSeconds : null;
  const leadSeconds = getRestTimerCountdownLeadSeconds(targetSeconds);

  const phase: RestTimerPhase = !isRunning
    ? 'paused'
    : anchorMs === null
      ? 'waiting'
      : queueEnded
        ? 'queueEnded'
        : exceeded
          ? 'exceeded'
          : isRestTimerFinalCountdown(remainingSeconds, leadSeconds)
            ? 'final'
            : 'running';

  return {
    armed,
    isRunning,
    phase,
    elapsedSeconds,
    targetSeconds,
    remainingSeconds,
    // Waiting has nothing to count yet, so the number IS the target — a false
    // 0:00 would read as "your rest already started".
    displayLabel:
      phase === 'waiting' && hasTarget
        ? formatRestTimerTarget(targetSeconds)
        : remainingSeconds !== null
          ? formatRestTimerSigned(remainingSeconds)
          : formatRestTimerElapsed(elapsedSeconds),
    targetLabel: hasTarget ? formatRestTimerTarget(targetSeconds) : null,
    listEnded: queueEnded && listEnded,
    leadSeconds,
  };
}

type RestTimerClockProps = {
  /** Type scale for the digits. The Record tab's arm row uses `headline`. */
  variant?: 'title1' | 'title2' | 'headline' | 'body';
  color?: ColorValue;
};

/**
 * A live `m:ss` readout, tabular so the digits do not jitter. Its own leaf so
 * the screen hosting it never re-renders on the tick — the arm row stays static
 * while this counts. The sheet's display-size equivalent, with the phase spelled
 * out beneath it, is {@link RestTimerHeroClock}.
 */
export function RestTimerClock({ variant = 'title1', color }: RestTimerClockProps) {
  const { systemColors, brandColors } = useTheme();
  const { armed, phase, displayLabel } = useRestTimerDisplay();

  if (!armed) return null;

  return (
    <LargeContentViewer title={displayLabel}>
      <Text
        variant={variant}
        color={color ?? phaseColor(phase, systemColors, brandColors)}
        maxFontSizeMultiplier={CHROME_LABEL_MAX_FONT_SCALE}
        style={styles.tabularDigits}
      >
        {displayLabel}
      </Text>
    </LargeContentViewer>
  );
}

type PhaseColorInputs = {
  label: ColorValue;
  secondaryLabel: ColorValue;
  tertiaryLabel: ColorValue;
  accent: ColorValue;
};

/**
 * The colour is the state. Past the target the digits go RED — a product
 * decision (you are over your rest, not "done"), so this must never become a
 * success green. The final countdown is the brand tint, `accent` (#6D28D9
 * light, #A78BFA dark, a notch further under Increase Contrast on iOS): 4.5:1 or
 * better on every opaque surface the pill and sheet draw on. Same semibold
 * digits, no animation: the number counting is the motion, so Reduce Motion has
 * nothing to turn off.
 */
function phaseColor(phase: RestTimerPhase, systemColors: PhaseColorInputs, brandColors: { error: string }): ColorValue {
  switch (phase) {
    case 'waiting':
      return systemColors.tertiaryLabel;
    case 'paused':
    case 'queueEnded':
      return systemColors.secondaryLabel;
    case 'exceeded':
      return brandColors.error;
    case 'final':
      return systemColors.accent;
    case 'running':
      return systemColors.label;
  }
}

type RestTimerAriaInputs = {
  phase: RestTimerPhase;
  displayLabel: string;
  targetLabel: string | null;
  remainingSeconds: number | null;
};

/**
 * What a screen reader hears from a rest-timer readout, for the pill AND the
 * sheet's hero clock. One helper because the two are the same sentence about the
 * same machine — and because spoken, the sign is useless ("minus zero twelve" is
 * not a sentence), so the overrun phrasing has to be applied in both places or
 * neither.
 *
 * Never a live region: a polite one on a 1 Hz ticker speaks every second. This
 * is a snapshot read on focus, which is what a climber actually wants.
 */
export function restTimerClockAccessibilityLabel(
  { phase, displayLabel, targetLabel, remainingSeconds }: RestTimerAriaInputs,
  t: TFunction<'session'>,
): string {
  if (phase === 'waiting') return t('mobile.restTimer.noTickAria', { target: targetLabel ?? displayLabel });
  if (phase === 'paused') return t('mobile.restTimer.pausedAria', { time: displayLabel });
  if (remainingSeconds === null) return t('mobile.restTimer.runningAria', { time: displayLabel });
  if (remainingSeconds < 0) {
    return t('mobile.restTimer.overrunAria', { time: formatRestTimerElapsed(-remainingSeconds) });
  }
  return t('mobile.restTimer.countdownAria', { time: displayLabel });
}

/**
 * The rest-timer sheet's hero: the live clock at display size with the PHASE
 * spelled out under it.
 *
 * It lives in this file, not the sheet, because it calls
 * {@link useRestTimerDisplay} — and that hook's contract is that only a leaf may,
 * since it re-renders once a second. Hoisting it into the sheet would put the
 * whole form (two rails' worth of chips, a collapsible section, three native
 * controls) on the 1 Hz heartbeat.
 *
 * One accessible element, not three: the digits and the caption are one reading,
 * and a screen reader that stops on each in turn reads "1:20" then "2:00 rest"
 * with no sentence between them.
 */
export function RestTimerHeroClock() {
  const { t } = useTranslation('session');
  const { systemColors, brandColors } = useTheme();
  const { armed, phase, displayLabel, targetSeconds, targetLabel, remainingSeconds, listEnded } = useRestTimerDisplay();

  if (!armed) return null;

  // The caption carries what the number cannot: which phase the machine is in,
  // and — while it is simply running — which rest length it is counting against.
  // `formatRestTimerElapsed`, so the caption is byte-identical to the rail chip
  // the climber tapped; `formatRestTimerTarget` would print "2m" beside a "2:00"
  // chip and read as a different setting.
  const caption =
    phase === 'waiting'
      ? t('mobile.restTimer.waitingForTick')
      : phase === 'paused'
        ? t('mobile.restTimer.clockCaptionPaused')
        : phase === 'queueEnded'
          ? listEnded
            ? t('mobile.restTimer.listEnded')
            : t('mobile.restTimer.queueEnded')
          : phase === 'exceeded'
            ? t('mobile.restTimer.clockCaptionOver')
            : targetSeconds !== null && targetSeconds > 0
              ? t('mobile.restTimer.clockCaptionRest', { target: formatRestTimerElapsed(targetSeconds) })
              : t('mobile.restTimer.clockCaptionCountUp');

  return (
    <View style={styles.heroGroup}>
      <View
        style={styles.hero}
        accessible
        accessibilityRole="text"
        accessibilityLabel={`${restTimerClockAccessibilityLabel({ phase, displayLabel, targetLabel, remainingSeconds }, t)}. ${caption}`}
        testID="rest-timer-hero-clock"
      >
        <Text
          variant="largeTitle"
          color={phaseColor(phase, systemColors, brandColors)}
          // Not the global 1.5x: see REST_CLOCK_MAX_FONT_SCALE — an hour-long
          // overrun is the widest string this can print, and 1.5x overflows it.
          maxFontSizeMultiplier={REST_CLOCK_MAX_FONT_SCALE}
          numberOfLines={1}
          style={styles.tabularDigits}
          testID="rest-timer-hero-digits"
        >
          {displayLabel}
        </Text>
        <Text
          variant="subheadline"
          color={systemColors.secondaryLabel}
          style={styles.heroCaption}
          testID="rest-timer-hero-caption"
        >
          {caption}
        </Text>
      </View>
      {/* Who paces a crew's clock (#5382). Outside the clock's one accessible
          element: it is a separate fact, and it changes when the board does. */}
      <RestTimerPacerCaption variant="subheadline" centered scalesWithText style={styles.heroPacer} />
    </View>
  );
}

export type RestTimerPillProps = {
  /** Opens the options sheet. Owned by the host so each mount gets its own sheet. */
  onPress: () => void;
  /**
   * The drawer-header tier: a 32pt mini pill carrying a 44pt hit-slop, per the
   * "label-only pill" rung in docs/ai-design-guidelines.md. Drops the secondary
   * line (there is no room beside the grabber) but KEEPS the auto-advance glyph,
   * which is the whole point of showing the pill there.
   */
  compact?: boolean;
};

/** The prepared workout shares the timer's surface, but has no running clock yet. */
export function WorkoutStartPill({
  onPress,
  compact = false,
  firstClimbName,
}: RestTimerPillProps & { firstClimbName: string | null }) {
  const { t } = useTranslation('session');
  const { systemColors, brandColors } = useTheme();
  const reduceMotion = useReduceMotion();
  const height = compact ? glassSize.mini : REST_TIMER_PILL_HEIGHT;
  const disabled = firstClimbName === null;
  const title = t('mobile.workoutRunner.startWorkout');

  return (
    <AccessoryBarSurface height={height} style={compact ? styles.pillCompact : styles.pill}>
      <PressableSurface
        onPress={onPress}
        disabled={disabled}
        feedback={reduceMotion ? 'none' : 'scale'}
        hitSlop={compact ? 8 : 0}
        accessibilityRole="button"
        accessibilityLabel={title}
        accessibilityHint={
          firstClimbName === null
            ? t('mobile.workoutRunner.startEmptyHint')
            : t('mobile.workoutRunner.startHint', { name: firstClimbName })
        }
        testID="workout-start-pill"
        style={[styles.row, { height, borderRadius: height / 2 }, compact ? styles.rowCompact : null]}
      >
        <Icon
          maxFontSizeMultiplier={1}
          name="play.fill"
          size={compact ? 14 : 16}
          color={disabled ? systemColors.tertiaryLabel : brandColors.primary}
        />
        <LargeContentViewer title={title} onActivate={disabled ? undefined : onPress} style={styles.labelViewer}>
          <Text
            variant={compact ? 'subheadline' : 'headline'}
            color={disabled ? systemColors.tertiaryLabel : brandColors.primary}
            maxFontSizeMultiplier={CHROME_LABEL_MAX_FONT_SCALE}
            numberOfLines={1}
          >
            {title}
          </Text>
        </LargeContentViewer>
      </PressableSurface>
    </AccessoryBarSurface>
  );
}

/**
 * `[ 🕐  1:42   Rest · 2m   ⏭ ]` — one row, on the shared accessory surface so it
 * inherits Liquid Glass / M3 tonal / blur / Reduce-Transparency for free.
 *
 * Tap opens the sheet; long-press is a pause/resume shortcut (never the only
 * path to it — the sheet has the labelled buttons).
 */
export function RestTimerPill({ onPress, compact = false }: RestTimerPillProps) {
  const { t } = useTranslation('session');
  const { systemColors, brandColors } = useTheme();
  const reduceMotion = useReduceMotion();
  const { armed, isRunning, phase, displayLabel, targetLabel, remainingSeconds, listEnded } = useRestTimerDisplay();

  const handleLongPress = useCallback(() => {
    hapticMedium();
    if (isRunning) pauseRestTimer(nowMs());
    else resumeRestTimer(nowMs());
  }, [isRunning]);

  const handleAccessibilityAction = useCallback((event: AccessibilityActionEvent) => {
    if (event.nativeEvent.actionName !== RESET_ACTION) return;
    resetRestTimer(nowMs());
  }, []);

  if (!armed) return null;

  const height = compact ? glassSize.mini : REST_TIMER_PILL_HEIGHT;
  const numberColor = phaseColor(phase, systemColors, brandColors);
  const glyphSize = compact ? 14 : 16;

  // The secondary line exists only to say something the number cannot. Once the
  // clock counts DOWN, the rest length is implicit in it — a "Rest · 1m" caption
  // beside a ticking 0:41 just repeats itself — so only the two states with no
  // meaningful number of their own carry a caption.
  const secondaryLabel =
    phase === 'waiting'
      ? t('mobile.restTimer.waitingForTick')
      : phase === 'queueEnded'
        ? listEnded
          ? t('mobile.restTimer.listEnded')
          : t('mobile.restTimer.queueEnded')
        : null;

  // Shared with the sheet's hero clock — see restTimerClockAccessibilityLabel.
  const accessibilityLabel = restTimerClockAccessibilityLabel(
    { phase, displayLabel, targetLabel, remainingSeconds },
    t,
  );

  return (
    <AccessoryBarSurface height={height} style={compact ? styles.pillCompact : styles.pill}>
      <PressableSurface
        onPress={onPress}
        onLongPress={handleLongPress}
        // Reduce Motion: no press spring, no entering animation, no pulse. The
        // colour swap at the target is what carries the moment.
        feedback={reduceMotion ? 'none' : 'scale'}
        hitSlop={compact ? 8 : 0}
        accessibilityRole="button"
        accessibilityLabel={accessibilityLabel}
        accessibilityHint={t('mobile.restTimer.openHint')}
        accessibilityActions={buildResetActions(t('mobile.restTimer.resetAction'))}
        onAccessibilityAction={handleAccessibilityAction}
        testID="rest-timer-pill"
        style={[styles.row, { height, borderRadius: height / 2 }, compact ? styles.rowCompact : null]}
      >
        <Icon maxFontSizeMultiplier={1} name="clock" size={glyphSize} color={systemColors.secondaryLabel} />
        <LargeContentViewer
          title={!compact && secondaryLabel ? `${accessibilityLabel}. ${secondaryLabel}` : accessibilityLabel}
          onActivate={onPress}
          style={styles.labelViewer}
          testID="rest-timer-pill-viewer"
        >
          <Text
            variant={compact ? 'subheadline' : 'headline'}
            color={numberColor}
            maxFontSizeMultiplier={CHROME_LABEL_MAX_FONT_SCALE}
            numberOfLines={1}
            style={styles.tabularDigits}
            testID="rest-timer-pill-elapsed"
          >
            {displayLabel}
          </Text>
          {!compact && secondaryLabel ? (
            <Text
              variant="footnote"
              color={systemColors.secondaryLabel}
              maxFontSizeMultiplier={CHROME_LABEL_MAX_FONT_SCALE}
              numberOfLines={1}
              style={styles.secondary}
              testID="rest-timer-pill-secondary"
            >
              {secondaryLabel}
            </Text>
          ) : null}
          {/* In a crew the free line says who paces the wall (#5382): its own
              leaf, so the clock's 1 Hz render passes it by. */}
          {!compact && !secondaryLabel ? <RestTimerPacerCaption style={styles.secondary} /> : null}
        </LargeContentViewer>
      </PressableSurface>
    </AccessoryBarSurface>
  );
}

// Rebuilt per render because the label is translated; the array is tiny and the
// pill re-renders once a second anyway, so memoizing it buys nothing.
function buildResetActions(label: string): ReadonlyArray<AccessibilityActionInfo> {
  return [{ name: RESET_ACTION, label }];
}

const styles = StyleSheet.create({
  pill: {
    minWidth: PILL_MIN_WIDTH,
    maxWidth: TOOLBAR_CAPSULE_MAX_WIDTH,
  },
  pillCompact: {
    maxWidth: TOOLBAR_CAPSULE_MAX_WIDTH,
  },
  labelViewer: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[2],
    flexShrink: 1,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing[3],
    gap: spacing[2],
  },
  rowCompact: {
    paddingHorizontal: spacing[2],
    gap: spacing[1],
  },
  // Tabular figures so the digits keep their column and the pill does not
  // twitch a pixel wider every time a 1 becomes an 8.
  tabularDigits: {
    fontVariant: ['tabular-nums'],
    fontWeight: '600',
  },
  secondary: {
    flexShrink: 1,
  },
  heroGroup: {
    alignItems: 'center',
    gap: spacing[1],
  },
  hero: {
    alignItems: 'center',
    gap: spacing[1],
  },
  heroCaption: {
    textAlign: 'center',
  },
  // Wraps at large text sizes: keep it off the sheet's edges, on the crew note's gutter.
  heroPacer: {
    paddingHorizontal: TICK_GUTTER,
  },
});
