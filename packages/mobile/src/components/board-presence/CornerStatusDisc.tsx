import type { ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';
import { useTheme } from '../../providers/theme-provider';

type CornerStatusDiscProps = {
  /** Disc height (and minimum width). */
  size: number;
  /** Horizontal padding, for a short text label that is wider than the disc. */
  paddingHorizontal?: number;
  children: ReactNode;
};

/**
 * The small status disc tucked into the top-trailing corner of an image: the
 * board driver's Bluetooth / idle mark on an avatar, and the connection mark on
 * the accessory platter's climb thumbnail. A neutral disc with a background-tone
 * hairline keeps the glyph legible over a photo or busy board art in both
 * schemes (white-on-amber fails the dark `warning` tint), so the glyph alone
 * carries the colour.
 *
 * Decorative: hidden from assistive tech and never hit-tested. The owner states
 * the status in its own accessibility label or value. Position the parent
 * `relative`.
 */
export function CornerStatusDisc({ size, paddingHorizontal = 0, children }: CornerStatusDiscProps) {
  const { systemColors } = useTheme();
  return (
    <View
      pointerEvents="none"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={[
        styles.disc,
        {
          height: size,
          minWidth: size,
          borderRadius: size / 2,
          paddingHorizontal,
          backgroundColor: systemColors.secondaryBackground,
          borderColor: systemColors.background,
        },
      ]}
    >
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  disc: {
    position: 'absolute',
    top: -2,
    right: -2,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: StyleSheet.hairlineWidth,
  },
});
