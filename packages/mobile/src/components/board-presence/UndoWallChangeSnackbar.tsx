import { useEffect } from 'react';
import { Pressable, StyleSheet, View, type ViewStyle } from 'react-native';
import Animated, { FadeInDown, FadeOutDown } from 'react-native-reanimated';
import { Portal, Snackbar } from 'react-native-paper';
import { useTranslation } from 'react-i18next';
import { Text } from '../Text';
import { borderRadius, spacing, shadowColor } from '../../theme/tokens';
import { useTheme } from '../../providers/theme-provider';
import { selectByVariant } from '../../theme/variants';
import { useBottomChromeMetrics } from '../../hooks/use-bottom-chrome-metrics';

// Held longer than the queue-added snackbar (someone may be mid-route on the
// wall the user just changed) — the accidental-takeover safety net.
const UNDO_DURATION = 8000;

type UndoWallChangeSnackbarProps = {
  visible: boolean;
  /** Changes on each show so the timer resets + the entrance replays. */
  nonce: number;
  onDismiss: () => void;
  /** Re-light the previous wall climb and re-report it to the wall feed. */
  onUndo: () => void;
  duration?: number;
};

/**
 * "You changed the wall · Undo" snackbar. Fires right after THIS device reports
 * a wall change so the climber who just (maybe accidentally) re-lit the wall can
 * restore the previous climb with one tap. The Undo action re-sends the previous
 * wall climb — queue navigation is never touched. Routes to a Material 3 Paper
 * Snackbar on the Material variant and the Liquid-Glass pill otherwise, matching
 * QueueAddedSnackbar's split.
 */
export function UndoWallChangeSnackbar(props: UndoWallChangeSnackbarProps) {
  const { variant: uiVariant } = useTheme();
  const bottomChrome = useBottomChromeMetrics();
  const bottom = bottomChrome.floatingControlBottom + spacing[2];
  return (
    <Portal>
      {selectByVariant(uiVariant, {
        material: <UndoWallChangeSnackbarMaterial {...props} bottom={bottom} />,
        liquidGlass: <UndoWallChangeSnackbarGlass {...props} bottom={bottom} />,
      })}
    </Portal>
  );
}

type PortaledUndoWallChangeSnackbarProps = UndoWallChangeSnackbarProps & {
  bottom: number;
};

function UndoWallChangeSnackbarMaterial({
  visible,
  nonce,
  onDismiss,
  onUndo,
  bottom,
  duration = UNDO_DURATION,
}: PortaledUndoWallChangeSnackbarProps) {
  const { t } = useTranslation('session');

  const wrapperStyle: ViewStyle = { bottom };

  return (
    <Snackbar
      key={nonce}
      visible={visible}
      onDismiss={onDismiss}
      duration={duration}
      wrapperStyle={wrapperStyle}
      action={{
        label: t('mobile.boardPresence.undo'),
        onPress: onUndo,
        accessibilityLabel: t('mobile.boardPresence.undoAria'),
      }}
    >
      {t('mobile.boardPresence.wallChanged')}
    </Snackbar>
  );
}

function UndoWallChangeSnackbarGlass({
  visible,
  nonce,
  onDismiss,
  onUndo,
  bottom,
  duration = UNDO_DURATION,
}: PortaledUndoWallChangeSnackbarProps) {
  const { systemColors, brandColors } = useTheme();
  const { t } = useTranslation('session');

  useEffect(() => {
    if (!visible) return undefined;
    const timer = setTimeout(onDismiss, duration);
    return () => clearTimeout(timer);
  }, [visible, nonce, duration, onDismiss]);

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
            {t('mobile.boardPresence.wallChanged')}
          </Text>
          <Pressable
            onPress={onUndo}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel={t('mobile.boardPresence.undoAria')}
          >
            <Text variant="subheadline" color={brandColors.primary} style={styles.undo}>
              {t('mobile.boardPresence.undo')}
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
  undo: {
    fontWeight: '700',
  },
});
