import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Pressable, StyleSheet, View, type ColorValue, type AccessibilityActionEvent } from 'react-native';
import { useTranslation } from 'react-i18next';
import { useOptionalBoardProvider } from '@boardsesh/board-react';
import { TOOLBAR_CAPSULE_HEIGHT } from '../../theme/layout';
import { CHROME_LABEL_MAX_FONT_SCALE } from '../../theme/typography';
import { useRepTimerPreference } from '../../lib/rep-timer-preference';
import { Text } from '../Text';
import { useTheme } from '../../providers/theme-provider';
import { useNativeGlass } from '../../hooks/use-native-glass';
import { shadows } from '../../theme/tokens';
import { GlassSurface } from '../GlassSurface';
import { AccessoryBarSurface, type AccessoryBarSurfaceTreatment } from './AccessoryBarSurface';
import {
  formatRepTimerElapsed,
  formatRepTimerTarget,
  getRepTimerElapsedSecondsFromStart,
  getRepTimerStartMs,
  isRepTimerTargetExceeded,
} from './rep-timer';

const REP_TIMER_CAPSULE_MAX_WIDTH = 220;
const DOUBLE_TAP_RESET_DELAY_MS = 240;
const HEADER_TIMER_PILL_HEIGHT = 34;
const HEADER_TIMER_PILL_RADIUS = HEADER_TIMER_PILL_HEIGHT / 2;
const HEADER_TIMER_HIT_SLOP = { top: 6, right: 4, bottom: 6, left: 4 };

type RepTimerControlState = {
  startedAtMs: number | null;
  isRunning: boolean;
  pausedElapsedSeconds: number;
};

type RepTimerControl = {
  enabled: boolean;
  elapsedSeconds: number;
  elapsedLabel: string;
  hasReferenceTime: boolean;
  isRunning: boolean;
  targetSeconds: number | null;
  targetLabel: string | null;
  accessibilityLabel: string | undefined;
  accessibilityHint: string | undefined;
  accessibilityActions: { name: string; label: string }[] | undefined;
  handleAccessibilityAction: (event: AccessibilityActionEvent) => void;
  handleTimerPressIn: () => void;
  handleTimerPress: () => void;
};

type RepTimerDisplayProps = {
  elapsedSeconds: number;
  hasReferenceTime: boolean;
  isRunning: boolean;
  targetSeconds: number | null;
  labelColor: ColorValue;
  valueColor: ColorValue;
  targetExceededColor?: ColorValue;
  align?: 'left' | 'center';
};

function createRepTimerControlState(lastSavedTickAt: string | null): RepTimerControlState {
  const startedAtMs = getRepTimerStartMs(lastSavedTickAt);
  return {
    startedAtMs,
    isRunning: startedAtMs !== null,
    pausedElapsedSeconds: 0,
  };
}

function useRepTimerNowMs(isRunning: boolean): number {
  const [nowMs, setNowMs] = useState(() => Date.now());

  useEffect(() => {
    setNowMs(Date.now());
    if (!isRunning) return undefined;

    const timer = setInterval(() => {
      setNowMs(Date.now());
    }, 1000);

    return () => clearInterval(timer);
  }, [isRunning]);

  return nowMs;
}

export function RepTimerDisplay({
  elapsedSeconds,
  hasReferenceTime,
  isRunning,
  targetSeconds,
  labelColor,
  valueColor,
  targetExceededColor = valueColor,
  align = 'center',
}: RepTimerDisplayProps) {
  const { t } = useTranslation('session');
  const elapsedLabel = formatRepTimerElapsed(elapsedSeconds);

  if (targetSeconds === null) return null;

  const targetLabel = formatRepTimerTarget(targetSeconds);
  const resolvedValueColor =
    (hasReferenceTime || isRunning) && isRepTimerTargetExceeded(elapsedSeconds, targetSeconds)
      ? targetExceededColor
      : valueColor;

  return (
    <View style={[styles.timerText, align === 'left' ? styles.timerTextLeft : styles.timerTextCenter]}>
      <Text
        variant="caption2"
        color={labelColor}
        numberOfLines={1}
        maxFontSizeMultiplier={CHROME_LABEL_MAX_FONT_SCALE}
        style={styles.label}
      >
        {t('mobile.queue.repTimerLabel', { target: targetLabel })}
      </Text>
      <Text
        variant="headline"
        color={resolvedValueColor}
        numberOfLines={1}
        maxFontSizeMultiplier={CHROME_LABEL_MAX_FONT_SCALE}
        style={styles.value}
      >
        {elapsedLabel}
      </Text>
    </View>
  );
}

function useRepTimerControl(): RepTimerControl {
  const board = useOptionalBoardProvider();
  const { t } = useTranslation('session');
  const { targetSeconds, loaded } = useRepTimerPreference();
  const lastSavedTickAt = board?.lastSavedTickAt ?? null;
  const [timerState, setTimerState] = useState(() => createRepTimerControlState(lastSavedTickAt));
  const singlePressTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const firstPressStartedAtRef = useRef<number | null>(null);
  const pendingDoubleTapPressedAtRef = useRef<number | null>(null);
  const pendingDoubleTapTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const nowMs = useRepTimerNowMs(timerState.isRunning);
  const elapsedSeconds = timerState.isRunning
    ? getRepTimerElapsedSecondsFromStart(timerState.startedAtMs, nowMs)
    : timerState.pausedElapsedSeconds;
  const hasReferenceTime = timerState.startedAtMs !== null || timerState.pausedElapsedSeconds > 0;
  const elapsedLabel = formatRepTimerElapsed(elapsedSeconds);
  const targetLabel = targetSeconds === null ? null : formatRepTimerTarget(targetSeconds);
  const accessibilityLabel =
    targetLabel === null
      ? undefined
      : hasReferenceTime || timerState.isRunning
        ? t('mobile.queue.repTimerAccessibility', { time: elapsedLabel, target: targetLabel })
        : t('mobile.queue.repTimerNoTickAccessibility', { target: targetLabel });
  const accessibilityHint = targetLabel === null ? undefined : t('mobile.queue.repTimerHint');
  const accessibilityActions =
    targetLabel === null ? undefined : [{ name: 'reset', label: t('mobile.queue.repTimerResetAction') }];

  useEffect(() => {
    setTimerState(createRepTimerControlState(lastSavedTickAt));
  }, [lastSavedTickAt]);

  useEffect(() => {
    return () => {
      if (singlePressTimeoutRef.current) clearTimeout(singlePressTimeoutRef.current);
      if (pendingDoubleTapTimeoutRef.current) clearTimeout(pendingDoubleTapTimeoutRef.current);
      firstPressStartedAtRef.current = null;
      pendingDoubleTapPressedAtRef.current = null;
      pendingDoubleTapTimeoutRef.current = null;
    };
  }, []);

  const toggleTimer = useCallback((pressedAtMs: number) => {
    setTimerState((current) => {
      if (current.isRunning) {
        return {
          ...current,
          isRunning: false,
          pausedElapsedSeconds: getRepTimerElapsedSecondsFromStart(current.startedAtMs, pressedAtMs),
        };
      }
      return {
        startedAtMs: pressedAtMs - current.pausedElapsedSeconds * 1000,
        isRunning: true,
        pausedElapsedSeconds: current.pausedElapsedSeconds,
      };
    });
  }, []);

  const resetTimer = useCallback((pressedAtMs: number) => {
    setTimerState((current) =>
      current.isRunning
        ? { startedAtMs: pressedAtMs, isRunning: true, pausedElapsedSeconds: 0 }
        : { startedAtMs: null, isRunning: false, pausedElapsedSeconds: 0 },
    );
  }, []);

  const handleTimerPressIn = useCallback(() => {
    const pressedAtMs = Date.now();
    if (singlePressTimeoutRef.current) {
      clearTimeout(singlePressTimeoutRef.current);
      singlePressTimeoutRef.current = null;
      firstPressStartedAtRef.current = null;
      pendingDoubleTapPressedAtRef.current = pressedAtMs;
      if (pendingDoubleTapTimeoutRef.current) clearTimeout(pendingDoubleTapTimeoutRef.current);
      pendingDoubleTapTimeoutRef.current = setTimeout(() => {
        pendingDoubleTapPressedAtRef.current = null;
        pendingDoubleTapTimeoutRef.current = null;
      }, DOUBLE_TAP_RESET_DELAY_MS);
      return;
    }
    firstPressStartedAtRef.current = pressedAtMs;
  }, []);

  const handleTimerPress = useCallback(() => {
    if (pendingDoubleTapPressedAtRef.current !== null) {
      const pressedAtMs = pendingDoubleTapPressedAtRef.current;
      pendingDoubleTapPressedAtRef.current = null;
      if (pendingDoubleTapTimeoutRef.current) {
        clearTimeout(pendingDoubleTapTimeoutRef.current);
        pendingDoubleTapTimeoutRef.current = null;
      }
      resetTimer(pressedAtMs);
      return;
    }
    const pressedAtMs = firstPressStartedAtRef.current ?? Date.now();
    firstPressStartedAtRef.current = null;
    if (singlePressTimeoutRef.current) {
      clearTimeout(singlePressTimeoutRef.current);
      singlePressTimeoutRef.current = null;
      resetTimer(pressedAtMs);
      return;
    }
    singlePressTimeoutRef.current = setTimeout(() => {
      singlePressTimeoutRef.current = null;
      toggleTimer(pressedAtMs);
    }, DOUBLE_TAP_RESET_DELAY_MS);
  }, [resetTimer, toggleTimer]);

  const handleAccessibilityAction = useCallback(
    (event: AccessibilityActionEvent) => {
      if (event.nativeEvent.actionName === 'reset') {
        resetTimer(Date.now());
      }
    },
    [resetTimer],
  );

  return {
    enabled: loaded && targetSeconds !== null,
    elapsedSeconds,
    elapsedLabel,
    hasReferenceTime,
    isRunning: timerState.isRunning,
    targetSeconds,
    targetLabel,
    accessibilityLabel,
    accessibilityHint,
    accessibilityActions,
    handleAccessibilityAction,
    handleTimerPressIn,
    handleTimerPress,
  };
}

type RepTimerCapsuleProps = {
  height?: number;
  fillWidth?: boolean;
  endAction?: ReactNode;
  endActionSize?: number;
  surfaceTreatment?: AccessoryBarSurfaceTreatment;
};

export function RepTimerCapsule({
  height = TOOLBAR_CAPSULE_HEIGHT,
  fillWidth = false,
  endAction,
  endActionSize = 0,
  surfaceTreatment = 'floating',
}: RepTimerCapsuleProps) {
  const { brandColors, systemColors } = useTheme();
  const timer = useRepTimerControl();
  const capsuleRadius = surfaceTreatment === 'docked' ? 0 : height / 2;
  const endActionReservedWidth = endAction ? endActionSize + 8 : 0;

  if (!timer.enabled) return null;

  return (
    <AccessoryBarSurface
      height={height}
      borderRadius={capsuleRadius}
      treatment={surfaceTreatment}
      style={[styles.capsule, fillWidth ? null : styles.capsuleCap]}
    >
      <Pressable
        accessibilityLabel={timer.accessibilityLabel}
        accessibilityHint={timer.accessibilityHint}
        accessibilityRole="button"
        accessibilityActions={timer.accessibilityActions}
        onAccessibilityAction={timer.handleAccessibilityAction}
        onPressIn={timer.handleTimerPressIn}
        onPress={timer.handleTimerPress}
        style={[
          styles.pressTarget,
          {
            height,
            paddingRight: 16 + endActionReservedWidth,
          },
        ]}
      >
        <RepTimerDisplay
          elapsedSeconds={timer.elapsedSeconds}
          hasReferenceTime={timer.hasReferenceTime}
          isRunning={timer.isRunning}
          targetSeconds={timer.targetSeconds}
          labelColor={systemColors.secondaryLabel}
          valueColor={systemColors.label}
          targetExceededColor={brandColors.error}
        />
      </Pressable>
      {endAction ? <View style={[styles.endActionSlot, { width: endActionSize, height }]}>{endAction}</View> : null}
    </AccessoryBarSurface>
  );
}

export function RepTimerHeaderPill() {
  const { brandColors, systemColors } = useTheme();
  const nativeGlass = useNativeGlass();
  const timer = useRepTimerControl();

  if (!timer.enabled) return null;

  const valueColor =
    timer.targetSeconds !== null &&
    (timer.hasReferenceTime || timer.isRunning) &&
    isRepTimerTargetExceeded(timer.elapsedSeconds, timer.targetSeconds)
      ? brandColors.error
      : systemColors.label;

  return (
    <Pressable
      accessibilityLabel={timer.accessibilityLabel}
      accessibilityHint={timer.accessibilityHint}
      accessibilityRole="button"
      accessibilityActions={timer.accessibilityActions}
      onAccessibilityAction={timer.handleAccessibilityAction}
      hitSlop={HEADER_TIMER_HIT_SLOP}
      onPressIn={timer.handleTimerPressIn}
      onPress={timer.handleTimerPress}
      style={[
        styles.headerPill,
        !nativeGlass && shadows.sm,
        !nativeGlass && { borderWidth: StyleSheet.hairlineWidth, borderColor: systemColors.separator },
      ]}
    >
      <GlassSurface
        glassEffectStyle="regular"
        fallbackColor={systemColors.elevatedSurface}
        borderRadius={HEADER_TIMER_PILL_RADIUS}
        style={StyleSheet.absoluteFill}
        pointerEvents="none"
      />
      <Text
        variant="subheadline"
        color={valueColor}
        numberOfLines={1}
        maxFontSizeMultiplier={CHROME_LABEL_MAX_FONT_SCALE}
        style={styles.headerTimerText}
      >
        {timer.elapsedLabel}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  capsule: {
    flex: 1,
  },
  capsuleCap: {
    maxWidth: REP_TIMER_CAPSULE_MAX_WIDTH,
  },
  pressTarget: {
    justifyContent: 'center',
    paddingLeft: 16,
  },
  timerText: {
    minWidth: 0,
  },
  timerTextCenter: {
    alignItems: 'center',
  },
  timerTextLeft: {
    alignItems: 'flex-start',
  },
  label: {
    fontWeight: '600',
    textTransform: 'uppercase',
  },
  value: {
    fontVariant: ['tabular-nums'],
    fontWeight: '700',
  },
  endActionSlot: {
    position: 'absolute',
    top: 0,
    right: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  headerPill: {
    alignItems: 'center',
    justifyContent: 'center',
    minWidth: 72,
    maxWidth: 96,
    height: HEADER_TIMER_PILL_HEIGHT,
    borderRadius: HEADER_TIMER_PILL_RADIUS,
    paddingHorizontal: 12,
    overflow: 'hidden',
  },
  headerTimerText: {
    fontVariant: ['tabular-nums'],
    fontWeight: '700',
  },
});
