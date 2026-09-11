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
import {
  StyleSheet,
  View,
  type AccessibilityActionEvent,
  type AccessibilityActionInfo,
  type ColorValue,
} from 'react-native';
import { useTranslation } from 'react-i18next';
import { Text } from '../Text';
import { Icon } from '../Icon';
import { PressableSurface } from '../PressableSurface';
import { useTheme } from '../../providers/theme-provider';
import { useReduceMotion } from '../../hooks/use-reduce-motion';
import { useRestTimerState } from '../../hooks/use-rest-timer';
import { useSetting } from '../../settings';
import { nowMs } from '../../lib/clock';
import { hapticMedium } from '../../lib/haptics';
import { pauseRestTimer, resetRestTimer, resumeRestTimer } from '../../lib/rest-timer-store';
import { formatRestTimerElapsed, formatRestTimerTarget, isRestTimerTargetExceeded } from '../../lib/rest-timer';
import { getRestTimerCycleElapsedSeconds } from '../../lib/rest-timer-auto-advance';
import { REST_TIMER_PILL_HEIGHT, TOOLBAR_CAPSULE_MAX_WIDTH, glassSize } from '../../theme/layout';
import { spacing } from '../../theme/tokens';
import { CHROME_LABEL_MAX_FONT_SCALE } from '../../theme/typography';
import { AccessoryBarSurface } from './AccessoryBarSurface';

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
 *   running     counting up, still inside the target
 */
export type RestTimerPhase = 'waiting' | 'paused' | 'queueEnded' | 'exceeded' | 'running';

/**
 * The 1 Hz ticker. Deliberately a component-local `useState` + `setInterval`
 * rather than anything shared: every consumer that calls this re-renders once a
 * second, so it must only ever be called by a leaf. The interval is not created
 * at all while `active` is false (paused, waiting for a tick, disarmed), so a
 * pill that is not counting costs nothing.
 */
export function useRestTimerNow(active: boolean): number {
  const [now, setNow] = useState<number>(() => nowMs());

  useEffect(() => {
    if (!active) return undefined;
    // Re-sample immediately: the pill may have been mounted (or resumed) part
    // way through a second, and the first interval fire is up to 1 s away.
    setNow(nowMs());
    const intervalId = setInterval(() => setNow(nowMs()), 1000);
    return () => clearInterval(intervalId);
  }, [active]);

  return now;
}

export type RestTimerDisplay = {
  armed: boolean;
  isRunning: boolean;
  phase: RestTimerPhase;
  elapsedSeconds: number;
  targetSeconds: number | null;
  autoAdvance: boolean;
  /** The counting number, `m:ss` (widening to `h:mm:ss` past an hour). */
  elapsedLabel: string;
  /** Compact target, e.g. `2m` / `1:30`. `null` when the rest length is Off. */
  targetLabel: string | null;
};

/**
 * Everything a rest-timer readout shows, derived once. Calls
 * {@link useRestTimerNow}, so ONLY a leaf component may call it — a screen that
 * wants a live clock renders {@link RestTimerClock} instead of calling this.
 */
export function useRestTimerDisplay(): RestTimerDisplay {
  const { armed, anchorMs, isRunning, pausedElapsedSeconds, queueEnded } = useRestTimerState();
  const [targetSeconds] = useSetting('restTimerTargetSeconds');
  const [mode] = useSetting('restTimerMode');
  const [autoAdvance] = useSetting('restTimerAutoAdvance');

  // Only a running timer with something to count from needs a heartbeat.
  const ticking = armed && isRunning && anchorMs !== null;
  const now = useRestTimerNow(ticking);

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

  const phase: RestTimerPhase = !isRunning
    ? 'paused'
    : anchorMs === null
      ? 'waiting'
      : queueEnded
        ? 'queueEnded'
        : exceeded
          ? 'exceeded'
          : 'running';

  return {
    armed,
    isRunning,
    phase,
    elapsedSeconds,
    targetSeconds,
    autoAdvance,
    // Waiting has no elapsed to show, so the number IS the target — a false
    // 0:00 would read as "your rest already started".
    elapsedLabel:
      phase === 'waiting' && hasTarget ? formatRestTimerTarget(targetSeconds) : formatRestTimerElapsed(elapsedSeconds),
    targetLabel: hasTarget ? formatRestTimerTarget(targetSeconds) : null,
  };
}

type RestTimerClockProps = {
  /** Type scale for the digits. The sheet uses `title1`, the arm row `headline`. */
  variant?: 'title1' | 'title2' | 'headline' | 'body';
  color?: ColorValue;
};

/**
 * A live `m:ss` readout, tabular so the digits do not jitter. Its own leaf so
 * the screen hosting it never re-renders on the tick — the arm row and the sheet
 * both stay static while this counts.
 */
export function RestTimerClock({ variant = 'title1', color }: RestTimerClockProps) {
  const { systemColors, brandColors } = useTheme();
  const { armed, phase, elapsedLabel } = useRestTimerDisplay();

  if (!armed) return null;

  return (
    <Text
      variant={variant}
      color={color ?? phaseColor(phase, systemColors, brandColors)}
      maxFontSizeMultiplier={CHROME_LABEL_MAX_FONT_SCALE}
      style={styles.tabularDigits}
    >
      {elapsedLabel}
    </Text>
  );
}

type PhaseColorInputs = {
  label: ColorValue;
  secondaryLabel: ColorValue;
  tertiaryLabel: ColorValue;
};

/**
 * The colour is the state. Past the target the digits go RED — a product
 * decision (you are over your rest, not "done"), so this must never become a
 * success green.
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
    case 'running':
      return systemColors.label;
  }
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
  const { armed, isRunning, phase, elapsedLabel, targetLabel, autoAdvance } = useRestTimerDisplay();

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

  // The secondary line: what the timer is waiting for, or what it is counting
  // towards. Never both — the pill is one row of fixed height.
  const secondaryLabel =
    phase === 'waiting'
      ? t('mobile.restTimer.waitingForTick')
      : phase === 'queueEnded'
        ? t('mobile.restTimer.queueEnded')
        : targetLabel
          ? t('mobile.restTimer.pillLabel', { target: targetLabel })
          : null;

  // No live region on the ticker: a polite one would speak every second. The
  // label is a snapshot read on focus, which is what a climber actually wants.
  const accessibilityLabel =
    phase === 'waiting'
      ? t('mobile.restTimer.noTickAria', { target: targetLabel ?? elapsedLabel })
      : phase === 'paused'
        ? t('mobile.restTimer.pausedAria', { time: elapsedLabel })
        : t('mobile.restTimer.runningAria', { time: elapsedLabel, target: targetLabel ?? elapsedLabel });

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
        <Icon name="clock" size={glyphSize} color={systemColors.secondaryLabel} />
        <Text
          variant={compact ? 'subheadline' : 'headline'}
          color={numberColor}
          maxFontSizeMultiplier={CHROME_LABEL_MAX_FONT_SCALE}
          numberOfLines={1}
          style={styles.tabularDigits}
          testID="rest-timer-pill-elapsed"
        >
          {elapsedLabel}
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
        {/* The one-glance answer to "is my phone about to move the wall on me".
            Present whenever auto-advance is on, in both tiers. */}
        {autoAdvance ? (
          <View testID="rest-timer-pill-auto-advance" style={styles.autoAdvanceGlyph}>
            <Icon name="skip.next" size={glyphSize} color={brandColors.primary} />
          </View>
        ) : null}
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
  autoAdvanceGlyph: {
    justifyContent: 'center',
  },
});
