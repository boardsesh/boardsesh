import { useEffect } from 'react';
import { Pressable, StyleSheet, View, type ViewStyle } from 'react-native';
import Animated, { FadeInDown, FadeOutDown } from 'react-native-reanimated';
import { Snackbar } from 'react-native-paper';
import { useTranslation } from 'react-i18next';
import { Text } from './Text';
import { borderRadius, spacing, shadowColor } from '../theme/tokens';
import { useTheme } from '../providers/theme-provider';
import { createVariantComponent } from '../theme/variants';
import { useBottomChromeMetrics } from '../hooks/use-bottom-chrome-metrics';

const DEFAULT_DURATION = 4000;

type QueueAddedSnackbarProps = {
  visible: boolean;
  /** Changes on each show so the timer resets + the entrance replays. */
  nonce: number;
  onDismiss: () => void;
  onOpen: () => void;
  duration?: number;
};

/**
 * Bottom-anchored "Climb added to queue · Open" snackbar that floats just above
 * the persistent queue bar. Rendered inside DrawerHostProvider so it can read
 * the queue state (to drop lower when the bar is hidden) and bind "Open" to the
 * host's `openQueueSheet`. Routes to a Material 3 Paper Snackbar on the Material
 * variant and to the existing Liquid-Glass pill on the Liquid Glass variant; the
 * public prop API is identical for both.
 */
export const QueueAddedSnackbar = createVariantComponent('QueueAddedSnackbar', {
  liquidGlass: QueueAddedSnackbarGlass,
  material: QueueAddedSnackbarMaterial,
});

function QueueAddedSnackbarMaterial({
  visible,
  nonce,
  onDismiss,
  onOpen,
  duration = DEFAULT_DURATION,
}: QueueAddedSnackbarProps) {
  const { t } = useTranslation('session');
  const bottomChrome = useBottomChromeMetrics();

  // Sit above the queue controls when they are showing; otherwise just above the
  // tab bar/safe area. The nonce forces a remount so the entrance + Paper's own
  // auto-dismiss timer replay on each show. Paper's wrapper is
  // pointerEvents="box-none", so taps outside the pill reach content behind it —
  // matching the glass path's absoluteFill/box-none wrapper.
  const bottom = bottomChrome.floatingControlBottom + spacing[2];
  const wrapperStyle: ViewStyle = { bottom };

  return (
    <Snackbar
      key={nonce}
      visible={visible}
      onDismiss={onDismiss}
      duration={duration}
      wrapperStyle={wrapperStyle}
      action={{
        label: t('mobile.queueSnackbar.open'),
        onPress: onOpen,
        accessibilityLabel: t('mobile.queueSnackbar.openAria'),
      }}
    >
      {t('mobile.queueSnackbar.added')}
    </Snackbar>
  );
}

// Liquid Glass / HIG snackbar — the original implementation, unchanged.
function QueueAddedSnackbarGlass({
  visible,
  nonce,
  onDismiss,
  onOpen,
  duration = DEFAULT_DURATION,
}: QueueAddedSnackbarProps) {
  const { systemColors, brandColors } = useTheme();
  const { t } = useTranslation('session');
  const bottomChrome = useBottomChromeMetrics();

  useEffect(() => {
    if (!visible) return undefined;
    const timer = setTimeout(onDismiss, duration);
    return () => clearTimeout(timer);
  }, [visible, nonce, duration, onDismiss]);

  // Sit above the queue controls when they are showing; otherwise just above
  // the tab bar/safe area.
  const bottom = bottomChrome.floatingControlBottom + spacing[2];

  return (
    <View pointerEvents="box-none" style={StyleSheet.absoluteFill}>
      {visible ? (
        <Animated.View
          key={nonce}
          entering={FadeInDown.duration(220)}
          exiting={FadeOutDown.duration(180)}
          style={[styles.snackbar, { bottom, backgroundColor: systemColors.secondaryBackground }]}
          accessibilityRole="alert"
        >
          <Text variant="subheadline" color={systemColors.label} style={styles.message} numberOfLines={1}>
            {t('mobile.queueSnackbar.added')}
          </Text>
          <Pressable
            onPress={onOpen}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel={t('mobile.queueSnackbar.openAria')}
          >
            <Text variant="subheadline" color={brandColors.primary} style={styles.open}>
              {t('mobile.queueSnackbar.open')}
            </Text>
          </Pressable>
        </Animated.View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  snackbar: {
    position: 'absolute',
    left: spacing[2],
    right: spacing[2],
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    columnGap: spacing[3],
    paddingVertical: spacing[3],
    paddingHorizontal: spacing[4],
    borderRadius: borderRadius.lg,
    shadowColor,
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.18,
    shadowRadius: 10,
    elevation: 6,
  },
  message: {
    flexShrink: 1,
  },
  open: {
    fontWeight: '700',
  },
});
