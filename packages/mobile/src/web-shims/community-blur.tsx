import type { ReactNode } from 'react';
import { StyleSheet, View, type ColorValue, type StyleProp, type ViewStyle } from 'react-native';

type BlurViewProps = {
  children?: ReactNode;
  style?: StyleProp<ViewStyle>;
  reducedTransparencyFallbackColor?: ColorValue;
};

// Browsers expose backdrop-filter through RNW styling inconsistently. Phase 0
// uses an opaque fallback so chrome remains readable on every target browser.
export function BlurView({ children, style, reducedTransparencyFallbackColor }: BlurViewProps) {
  return (
    <View
      style={[
        StyleSheet.absoluteFill,
        { backgroundColor: reducedTransparencyFallbackColor ?? 'rgba(255,255,255,0.92)' },
        style,
      ]}
    >
      {children}
    </View>
  );
}

export const VibrancyView = BlurView;
