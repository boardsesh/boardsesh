import { View, Pressable, StyleSheet } from 'react-native';
import { Text } from '../Text';
import { useTheme } from '../../providers/theme-provider';
import { glassSize } from '../../theme/layout';
import { spacing, borderRadius } from '../../theme/tokens';

type InlineConfirmBannerProps = {
  title: string;
  message: string;
  confirmLabel: string;
  cancelLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
};

/**
 * A confirm rendered as sheet CONTENT rather than as a dialog.
 *
 * `useConfirm` cannot be used from inside this drawer on Android: the Material
 * path renders a Paper `Dialog` inside a `Portal`, which is a JS view mounted at
 * the app root, while the create drawer is a NATIVE @expo/ui bottom sheet
 * composited above that root. The dialog paints behind the sheet and is never
 * seen — the promise just never resolves to `true`, so the action silently does
 * nothing. (iOS is fine: the same provider uses a native `Alert` there, which is
 * its own window.) The toast overlay has the identical problem, which is why
 * `toast-provider` carries a warning about it.
 *
 * Inline content cannot be occluded by the sheet it lives in, which is why
 * `DuplicateBanner` — the other thing in this drawer that must not be missed —
 * is built the same way.
 */
export function InlineConfirmBanner({
  title,
  message,
  confirmLabel,
  cancelLabel,
  onConfirm,
  onCancel,
}: InlineConfirmBannerProps) {
  const { systemColors, brandColors } = useTheme();
  return (
    <View style={[styles.banner, { backgroundColor: systemColors.fill }]} accessibilityRole="alert">
      <View style={styles.text}>
        <Text variant="footnote" style={styles.title}>
          {title}
        </Text>
        <Text variant="footnote" color={systemColors.secondaryLabel}>
          {message}
        </Text>
      </View>
      <View style={styles.actions}>
        <Pressable onPress={onCancel} accessibilityRole="button" hitSlop={8} style={styles.action}>
          <Text variant="footnote" color={systemColors.secondaryLabel}>
            {cancelLabel}
          </Text>
        </Pressable>
        <Pressable onPress={onConfirm} accessibilityRole="button" hitSlop={8} style={styles.action}>
          <Text variant="footnote" color={brandColors.error}>
            {confirmLabel}
          </Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  banner: {
    marginHorizontal: spacing[4],
    marginTop: spacing[2],
    padding: spacing[3],
    borderRadius: borderRadius.md,
    gap: spacing[2],
  },
  text: {
    gap: spacing[1],
  },
  title: {
    fontWeight: '600',
  },
  actions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: spacing[4],
  },
  // The NODE has to clear the 44dp touch floor, not just the effective area:
  // `hitSlop` is invisible to an accessibility scanner and to anyone aiming at
  // the glyph, and the measured node is what an audit reports. Padding alone
  // lands at ~42 (footnote line box + 2x12), so the floor is explicit.
  action: {
    minHeight: glassSize.inline,
    justifyContent: 'center',
    paddingVertical: spacing[3],
    paddingHorizontal: spacing[2],
  },
});
