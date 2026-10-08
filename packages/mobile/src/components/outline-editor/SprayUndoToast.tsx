import React, { useEffect, useRef } from 'react';
import { AccessibilityInfo, StyleSheet, View } from 'react-native';
import Animated, { FadeIn, FadeOut } from 'react-native-reanimated';
import { useTranslation } from 'react-i18next';
import { Text } from '../Text';
import { Button } from '../Button';
import { GlassSurface } from '../GlassSurface';
import { useTheme } from '../../providers/theme-provider';
import { glassSize } from '../../theme/layout';
import { spacing } from '../../theme/tokens';
import { CHROME_LABEL_MAX_FONT_SCALE } from '../../theme/typography';

/** How long the toast stays up when nothing else takes it down first. */
export const SPRAY_UNDO_TOAST_MS = 4000;

/** What the toast says. `nonce` changes for every new action, so the same message twice still restarts the clock. */
export type SprayUndoToastContent = {
  message: string;
  nonce: number;
};

type SprayUndoToastProps = SprayUndoToastContent & {
  onUndo: () => void;
  /** The 4 s ran out. The screen also takes it down itself on the next edit. */
  onDismiss: () => void;
};

/**
 * "Joined 2 holds · Undo" — the one line that follows the editor's heavy
 * actions: Delete, Join, Keep all maybes and Start over. Toggles do not raise
 * it: a switched-off ring is still on the photo, and the selected ring says
 * what it is.
 *
 * A glass pill in the screen's bottom dock, above the chip bar. It lives in the
 * screen rather than the app's global toast because the editor is a modal and
 * the global toast draws behind it. Gone after 4 s, or as soon as the climber
 * edits again — an Undo that undid something other than what the toast names
 * would be worse than none.
 *
 * Announced once per action, so a screen reader hears what happened; the Undo
 * button is reachable in the normal swipe order.
 */
export const SprayUndoToast = React.memo(function SprayUndoToast({
  message,
  nonce,
  onUndo,
  onDismiss,
}: SprayUndoToastProps) {
  const { t } = useTranslation('boards');
  const { systemColors } = useTheme();
  const onDismissRef = useRef(onDismiss);
  onDismissRef.current = onDismiss;

  useEffect(() => {
    AccessibilityInfo.announceForAccessibility(message);
    const timer = setTimeout(() => onDismissRef.current(), SPRAY_UNDO_TOAST_MS);
    return () => clearTimeout(timer);
    // `nonce` restarts the clock for a new action with the same words.
  }, [message, nonce]);

  return (
    <Animated.View entering={FadeIn.duration(150)} exiting={FadeOut.duration(150)} style={styles.root}>
      <GlassSurface
        glassEffectStyle="regular"
        fallbackColor={systemColors.fill}
        borderRadius={glassSize.capsule / 2}
        style={StyleSheet.absoluteFill}
        pointerEvents="none"
      />
      <View style={styles.line}>
        <Text
          variant="subheadline"
          color={systemColors.label}
          numberOfLines={2}
          maxFontSizeMultiplier={CHROME_LABEL_MAX_FONT_SCALE}
          style={styles.message}
        >
          {message}
        </Text>
        <Button title={t('sprayEditor.bar.undo')} variant="text" size="small" over="surface" onPress={onUndo} />
      </View>
    </Animated.View>
  );
});

const styles = StyleSheet.create({
  root: {
    alignSelf: 'center',
    maxWidth: '100%',
    minHeight: glassSize.capsule,
    borderRadius: glassSize.capsule / 2,
    overflow: 'hidden',
    justifyContent: 'center',
    paddingStart: spacing[4],
    paddingEnd: spacing[1],
  },
  line: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[2],
  },
  message: {
    flexShrink: 1,
  },
});
