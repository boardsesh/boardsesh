import { useEffect, useState, type ReactNode } from 'react';
import { StyleSheet, View, type ColorValue } from 'react-native';
import { useTranslation } from 'react-i18next';
import { useOptionalBoardProvider } from '@boardsesh/board-react';
import { TOOLBAR_CAPSULE_HEIGHT, TOOLBAR_CAPSULE_MAX_WIDTH } from '../../theme/layout';
import { CHROME_LABEL_MAX_FONT_SCALE } from '../../theme/typography';
import { Text } from '../Text';
import { useTheme } from '../../providers/theme-provider';
import { AccessoryBarSurface, type AccessoryBarSurfaceTreatment } from './AccessoryBarSurface';
import { formatRepTimerElapsed, getRepTimerElapsedSeconds } from './rep-timer';

type RepTimerDisplayProps = {
  lastSavedTickAt: string | null;
  labelColor: ColorValue;
  valueColor: ColorValue;
  align?: 'left' | 'center';
};

function useRepTimerNowMs(lastSavedTickAt: string | null): number {
  const [nowMs, setNowMs] = useState(() => Date.now());

  useEffect(() => {
    setNowMs(Date.now());
    if (!lastSavedTickAt) return undefined;

    const timer = setInterval(() => {
      setNowMs(Date.now());
    }, 1000);

    return () => clearInterval(timer);
  }, [lastSavedTickAt]);

  return nowMs;
}

export function RepTimerDisplay({ lastSavedTickAt, labelColor, valueColor, align = 'center' }: RepTimerDisplayProps) {
  const { t } = useTranslation('session');
  const nowMs = useRepTimerNowMs(lastSavedTickAt);
  const elapsedSeconds = getRepTimerElapsedSeconds(lastSavedTickAt, nowMs);
  const elapsedLabel = formatRepTimerElapsed(elapsedSeconds);
  const accessibilityLabel = lastSavedTickAt
    ? t('mobile.queue.repTimerAccessibility', { time: elapsedLabel })
    : t('mobile.queue.repTimerNoTickAccessibility');

  return (
    <View
      accessible
      accessibilityLabel={accessibilityLabel}
      style={[styles.timerText, align === 'left' ? styles.timerTextLeft : styles.timerTextCenter]}
    >
      <Text
        variant="caption2"
        color={labelColor}
        numberOfLines={1}
        maxFontSizeMultiplier={CHROME_LABEL_MAX_FONT_SCALE}
        style={styles.label}
      >
        {t('mobile.queue.repTimerLabel')}
      </Text>
      <Text
        variant="headline"
        color={valueColor}
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
  const { systemColors } = useTheme();
  const capsuleRadius = surfaceTreatment === 'docked' ? 0 : height / 2;
  const endActionReservedWidth = endAction ? endActionSize + 8 : 0;

  return (
    <AccessoryBarSurface
      height={height}
      borderRadius={capsuleRadius}
      treatment={surfaceTreatment}
      style={[styles.capsule, fillWidth ? null : styles.capsuleCap]}
    >
      <View
        style={[
          styles.content,
          {
            height,
            paddingRight: 16 + endActionReservedWidth,
          },
        ]}
      >
        <RepTimerDisplay
          lastSavedTickAt={board?.lastSavedTickAt ?? null}
          labelColor={systemColors.secondaryLabel}
          valueColor={systemColors.label}
        />
      </View>
      {endAction ? <View style={[styles.endActionSlot, { width: endActionSize, height }]}>{endAction}</View> : null}
    </AccessoryBarSurface>
  );
}

const styles = StyleSheet.create({
  capsule: {
    flex: 1,
  },
  capsuleCap: {
    maxWidth: TOOLBAR_CAPSULE_MAX_WIDTH,
  },
  content: {
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
