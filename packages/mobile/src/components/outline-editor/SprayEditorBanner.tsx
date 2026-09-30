import React, { type ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';
import { Text } from '../Text';
import { Button } from '../Button';
import { GlassSurface } from '../GlassSurface';
import { useTheme } from '../../providers/theme-provider';
import { iosSystemColors } from '../../theme/ios-colors';
import { borderRadius, spacing } from '../../theme/tokens';

type SprayEditorBannerProps = {
  message: string;
  /** Optional action at the trailing edge — Cancel for Trace and Join, Try again for a failed scan. */
  actionLabel?: string;
  onAction?: () => void;
  /** Error copy reads in the system red; everything else in the label colour. */
  tone?: 'info' | 'error';
  /** A second row under the message — the Draw / Corners toggle while adding holds. */
  accessory?: ReactNode;
};

/**
 * One line of glass pinned to the top of the photo: what the editor is waiting
 * for (Trace, Join, Add), what went wrong, or why the wall is empty.
 *
 * Announced politely, so a screen reader hears the instruction the moment a
 * one-shot tool starts rather than having to go looking for it.
 */
export const SprayEditorBanner = React.memo(function SprayEditorBanner({
  message,
  actionLabel,
  onAction,
  tone = 'info',
  accessory,
}: SprayEditorBannerProps) {
  const { systemColors } = useTheme();
  return (
    <View style={styles.root}>
      <GlassSurface glassEffectStyle="regular" borderRadius={borderRadius.xl} style={StyleSheet.absoluteFill} />
      <View style={styles.line}>
        <Text
          variant="subheadline"
          color={tone === 'error' ? iosSystemColors.systemRed : systemColors.label}
          accessibilityLiveRegion="polite"
          style={styles.message}
        >
          {message}
        </Text>
        {actionLabel && onAction ? (
          <Button title={actionLabel} variant="text" size="small" over="content" onPress={onAction} />
        ) : null}
      </View>
      {accessory ? <View style={styles.accessory}>{accessory}</View> : null}
    </View>
  );
});

const styles = StyleSheet.create({
  root: {
    gap: spacing[2],
    borderRadius: borderRadius.xl,
    overflow: 'hidden',
    paddingVertical: spacing[2],
    paddingLeft: spacing[4],
    paddingRight: spacing[2],
  },
  line: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[2],
  },
  accessory: {
    paddingRight: spacing[2],
  },
  message: {
    flex: 1,
  },
});
