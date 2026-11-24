import { PressableSurface } from '../PressableSurface';
import type { ReactNode } from 'react';
import { StyleSheet, type StyleProp, type ViewStyle } from 'react-native';
import { opacity } from '../../theme/tokens';

type AccessoryPlayLinkProps = {
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
  accessibilityLabel: string;
  testID?: string;
  /** Spoken after the label, e.g. the board connection the platter shows only as a mark. */
  accessibilityValue?: string;
  onOpen: () => void;
};

/**
 * The mini-player's tap target. It opens the player with the same slide as a
 * climb row. The accessory used to zoom into the player, but a tap or swipe
 * during the zoom's close could leave the player frozen half-way (#8126).
 */
export function AccessoryPlayLink({
  children,
  style,
  accessibilityLabel,
  testID,
  accessibilityValue,
  onOpen,
}: AccessoryPlayLinkProps) {
  return (
    <PressableSurface
      testID={testID}
      role="button"
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityValue={accessibilityValue ? { text: accessibilityValue } : undefined}
      android_ripple={{ borderless: false }}
      onPress={onOpen}
      style={({ pressed }) => [StyleSheet.flatten(style), pressed && { opacity: opacity.subtle }]}
    >
      {children}
    </PressableSurface>
  );
}
