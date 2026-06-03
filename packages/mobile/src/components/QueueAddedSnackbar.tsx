import { useEffect } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import Animated, { FadeInDown, FadeOutDown } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import { Text } from './Text';
import { brandColors } from '../theme/colors';
import { borderRadius, spacing, shadowColor } from '../theme/tokens';
import { useTheme } from '../providers/theme-provider';
import { useQueue } from '../providers/queue-provider';
import { TAB_BAR_HEIGHT } from './BlurTabBar';
import { BAR_CONTENT_HEIGHT } from '../theme/layout';
import { queueSnackbarBottomOffset } from './queue-snackbar-position';

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
 * host's `openQueueSheet`. Unlike the top toast, its overlay is `box-none` so
 * the "Open" button is tappable.
 */
export function QueueAddedSnackbar({
  visible,
  nonce,
  onDismiss,
  onOpen,
  duration = DEFAULT_DURATION,
}: QueueAddedSnackbarProps) {
  const insets = useSafeAreaInsets();
  const { systemColors } = useTheme();
  const { t } = useTranslation('session');
  const { state } = useQueue();

  useEffect(() => {
    if (!visible) return undefined;
    const timer = setTimeout(onDismiss, duration);
    return () => clearTimeout(timer);
  }, [visible, nonce, duration, onDismiss]);

  // Sit above the queue bar when it's showing; otherwise just above the tab bar.
  const barVisible = !!state.currentClimbQueueItem;
  const bottom = queueSnackbarBottomOffset({
    insetsBottom: insets.bottom,
    tabBarHeight: TAB_BAR_HEIGHT,
    barContentHeight: BAR_CONTENT_HEIGHT,
    gap: spacing[2],
    barVisible,
  });

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
