import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Pressable, StyleSheet, View, type ColorValue } from 'react-native';
import { useTranslation } from 'react-i18next';
import { useOptionalBoardProvider } from '@boardsesh/board-react';
import { TOOLBAR_CAPSULE_HEIGHT } from '../../theme/layout';
import { CHROME_LABEL_MAX_FONT_SCALE } from '../../theme/typography';
import { useRepTimerPreference } from '../../lib/rep-timer-preference';
import { Text } from '../Text';
import { useTheme } from '../../providers/theme-provider';
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

type RepTimerControlState = {
  startedAtMs: number | null;
  isRunning: boolean;
  pausedElapsedSeconds: number;
};

type RepTimerDisplayProps = {
  elapsedSeconds: number;
  hasReferenceTime: boolean;
  isRunning: boolean;
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
  labelColor,
  valueColor,
  targetExceededColor = valueColor,
  align = 'center',
}: RepTimerDisplayProps) {
  const { t } = useTranslation('session');
  const { targetSeconds, loaded } = useRepTimerPreference();
  const elapsedLabel = formatRepTimerElapsed(elapsedSeconds);

  if (!loaded || targetSeconds === null) return null;

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
  const board = useOptionalBoardProvider();
  const { brandColors, systemColors } = useTheme();
  const { t } = useTranslation('session');
  const { targetSeconds } = useRepTimerPreference();
  const capsuleRadius = surfaceTreatment === 'docked' ? 0 : height / 2;
  const endActionReservedWidth = endAction ? endActionSize + 8 : 0;
  const lastSavedTickAt = board?.lastSavedTickAt ?? null;
  const [timerState, setTimerState] = useState(() => createRepTimerControlState(lastSavedTickAt));
  const singlePressTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const firstPressStartedAtRef = useRef<number | null>(null);
  const ignoreNextPressRef = useRef(false);
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

  useEffect(() => {
    setTimerState(createRepTimerControlState(lastSavedTickAt));
  }, [lastSavedTickAt]);

  useEffect(() => {
    return () => {
      if (singlePressTimeoutRef.current) clearTimeout(singlePressTimeoutRef.current);
      firstPressStartedAtRef.current = null;
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
      ignoreNextPressRef.current = true;
      resetTimer(pressedAtMs);
      return;
    }
    firstPressStartedAtRef.current = pressedAtMs;
  }, [resetTimer]);

  const handleTimerPress = useCallback(() => {
    if (ignoreNextPressRef.current) {
      ignoreNextPressRef.current = false;
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

  return (
    <AccessoryBarSurface
      height={height}
      borderRadius={capsuleRadius}
      treatment={surfaceTreatment}
      style={[styles.capsule, fillWidth ? null : styles.capsuleCap]}
    >
      <Pressable
        accessibilityLabel={accessibilityLabel}
        accessibilityRole="button"
        onPressIn={handleTimerPressIn}
        onPress={handleTimerPress}
        style={[
          styles.pressTarget,
          {
            height,
            paddingRight: 16 + endActionReservedWidth,
          },
        ]}
      >
        <RepTimerDisplay
          elapsedSeconds={elapsedSeconds}
          hasReferenceTime={hasReferenceTime}
          isRunning={timerState.isRunning}
          labelColor={systemColors.secondaryLabel}
          valueColor={systemColors.label}
          targetExceededColor={brandColors.error}
        />
      </Pressable>
      {endAction ? <View style={[styles.endActionSlot, { width: endActionSize, height }]}>{endAction}</View> : null}
    </AccessoryBarSurface>
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
});
