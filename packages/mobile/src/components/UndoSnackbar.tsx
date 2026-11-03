import { PressableSurface } from './PressableSurface';
import { useEffect, useRef, type RefObject } from 'react';
import { Platform, StyleSheet, View, type ViewInstance, type ViewStyle } from 'react-native';
import Animated, { FadeInDown, FadeOutDown } from 'react-native-reanimated';
import { Snackbar } from 'react-native-paper';
import { Text } from './Text';
import { borderRadius, spacing, shadowColor } from '../theme/tokens';
import { useTheme } from '../providers/theme-provider';
import { selectByVariant } from '../theme/variants';
import { announceQueued } from '../lib/announce-queued';
import { useAnnounceBodyFocus } from './play-drawer/use-announce-body-focus';

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
  /**
   * Move the screen reader onto Undo each time the snackbar shows. For a caller
   * whose removal unmounts the control the climber was on (the queue's ⋯, its
   * Remove bar, a removed row); pass it only while a screen reader runs.
   */
  focusUndoOnShow?: boolean;
};

type UndoSnackbarBodyProps = UndoSnackbarProps & { undoRef: RefObject<ViewInstance | null> };

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
  const { visible, nonce, message, focusUndoOnShow = false } = props;
  const undoRef = useRef<ViewInstance>(null);
  // Runs before the announcement below, so VoiceOver lands on Undo and the
  // queued message follows it instead of being cut off by the focus move.
  useAnnounceBodyFocus(undoRef, visible && focusUndoOnShow, nonce);
  // VoiceOver doesn't read an `alert` role appearing; say it once per show
  // (keyed on `nonce`). Android's Snackbar / live region already speaks.
  const messageRef = useRef(message);
  messageRef.current = message;
  useEffect(() => {
    if (visible && Platform.OS === 'ios') announceQueued(messageRef.current);
  }, [visible, nonce]);
  return selectByVariant(uiVariant, {
    material: <UndoSnackbarMaterial {...props} undoRef={undoRef} />,
    liquidGlass: <UndoSnackbarGlass {...props} undoRef={undoRef} />,
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
  undoRef,
}: UndoSnackbarBodyProps) {
  const wrapperStyle: ViewStyle = { bottom };

  return (
    <Snackbar
      // Paper arms its dismiss timer once per mount and never re-reads
      // `duration`, so a new duration mid-show (a screen reader switched on or
      // off) needs a fresh mount to take effect.
      key={`${nonce}:${duration}`}
      visible={visible}
      onDismiss={onDismiss}
      duration={duration}
      wrapperStyle={wrapperStyle}
      action={{
        label: undoLabel,
        onPress: onUndo,
        accessibilityLabel: undoAccessibilityLabel ?? undoLabel,
        // Paper types this ref by RN's retired `View` class; the value it holds
        // is the button's host instance, the same thing the glass pill's ref holds.
        touchableRef: undoRef as unknown as RefObject<View>,
      }}
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
  undoRef,
}: UndoSnackbarBodyProps) {
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
          <PressableSurface
            ref={undoRef}
            onPress={onUndo}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel={undoAccessibilityLabel ?? undoLabel}
          >
            <Text variant="subheadline" color={brandColors.primary} style={styles.undo}>
              {undoLabel}
            </Text>
          </PressableSurface>
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
