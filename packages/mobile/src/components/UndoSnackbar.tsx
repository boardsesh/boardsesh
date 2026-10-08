import { useEffect } from 'react';
import { Pressable, StyleSheet, View, type ViewStyle } from 'react-native';
import Animated, { FadeInDown, FadeOutDown } from 'react-native-reanimated';
import { Snackbar } from 'react-native-paper';
import { Text } from './Text';
import { borderRadius, spacing, shadowColor } from '../theme/tokens';
import { useTheme } from '../providers/theme-provider';
import { selectByVariant } from '../theme/variants';

export type UndoSnackbarProps = {
  visible: boolean;
  /** Changes on each show so the timer resets + the entrance replays. */
  nonce: number;
  /** What just happened, e.g. "You changed the wall". */
  message: string;
  /** The action's visible label ("Undo"). */
  undoLabel: string;
  /** The action's spoken label, when it needs more than `undoLabel`. */
  undoAccessibilityLabel?: string;
  onDismiss: () => void;
  onUndo: () => void;
  duration: number;
  /** Distance from the bottom of the snackbar's container. */
  bottom: number;
};

/**
 * "Something happened · Undo" — the shared body behind every undo snackbar
 * (HIG "Undo and redo": let people take back a destructive action in one tap).
 * A Material 3 Paper Snackbar on the Material variant and the Liquid-Glass pill
 * otherwise. It positions itself absolutely against whatever contains it, so
 * the caller decides where it lives: a root `Portal` for app chrome, or inline
 * inside a native sheet, where a portal would draw behind the sheet.
 */
export function UndoSnackbar(props: UndoSnackbarProps) {
  const { variant: uiVariant } = useTheme();
  return selectByVariant(uiVariant, {
    material: <UndoSnackbarMaterial {...props} />,
    liquidGlass: <UndoSnackbarGlass {...props} />,
  });
}

function UndoSnackbarMaterial({
  visible,
  nonce,
  message,
  undoLabel,
  undoAccessibilityLabel,
  onDismiss,
  onUndo,
  duration,
  bottom,
}: UndoSnackbarProps) {
  const wrapperStyle: ViewStyle = { bottom };

  return (
    <Snackbar
      key={nonce}
      visible={visible}
      onDismiss={onDismiss}
      duration={duration}
      wrapperStyle={wrapperStyle}
      action={{ label: undoLabel, onPress: onUndo, accessibilityLabel: undoAccessibilityLabel ?? undoLabel }}
    >
      {message}
    </Snackbar>
  );
}

function UndoSnackbarGlass({
  visible,
  nonce,
  message,
  undoLabel,
  undoAccessibilityLabel,
  onDismiss,
  onUndo,
  duration,
  bottom,
}: UndoSnackbarProps) {
  const { systemColors, brandColors } = useTheme();

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
            {message}
          </Text>
          <Pressable
            onPress={onUndo}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel={undoAccessibilityLabel ?? undoLabel}
          >
            <Text variant="subheadline" color={brandColors.primary} style={styles.undo}>
              {undoLabel}
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
