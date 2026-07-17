import type { ReactNode } from 'react';
import { StyleSheet, View, type ColorValue, type StyleProp, type ViewProps, type ViewStyle } from 'react-native';
import type { GlassStyle } from 'expo-glass-effect';
import { useTheme } from '../providers/theme-provider';
import type { MaterialSurfaceContainers } from '../theme/colors';
import { shadows, type MaterialElevationLevel } from '../theme/tokens';

type GlassSurfaceProps = {
  children?: ReactNode;
  style?: StyleProp<ViewStyle>;
  glassEffectStyle?: GlassStyle;
  tintColor?: string;
  fallbackColor?: ColorValue;
  borderRadius?: number;
  blurAmount?: number;
  isInteractive?: boolean;
  pointerEvents?: ViewProps['pointerEvents'];
  role?: keyof MaterialSurfaceContainers;
  level?: MaterialElevationLevel;
};

export function GlassSurface({
  children,
  style,
  tintColor,
  fallbackColor,
  borderRadius,
  pointerEvents,
  role,
  level,
}: GlassSurfaceProps) {
  const { systemColors, m3SurfaceContainers, materialElevation } = useTheme();
  const radius = borderRadius == null ? null : { borderRadius };
  const backgroundColor = role ? m3SurfaceContainers[role] : systemColors.secondaryBackground;
  const elevationStyle = level ? materialElevation[level] : shadows.sm;

  return (
    <View style={[style, radius, elevationStyle, { backgroundColor }]} pointerEvents={pointerEvents}>
      {!role && fallbackColor ? (
        <View pointerEvents="none" style={[StyleSheet.absoluteFill, radius, { backgroundColor: fallbackColor }]} />
      ) : null}
      {tintColor ? (
        <View pointerEvents="none" style={[StyleSheet.absoluteFill, radius, { backgroundColor: tintColor }]} />
      ) : null}
      {children}
    </View>
  );
}
