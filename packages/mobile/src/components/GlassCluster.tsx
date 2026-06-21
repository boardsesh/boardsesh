import { type ReactNode } from 'react';
import { View, type StyleProp, type ViewProps, type ViewStyle } from 'react-native';
import { GlassContainer } from 'expo-glass-effect';
import { useNativeGlass } from '../hooks/use-native-glass';
import { useTheme } from '../providers/theme-provider';
import { useVariantValue } from '../theme/variants';
import { borderRadius } from '../theme/tokens';

type GlassClusterProps = {
  children?: ReactNode;
  style?: StyleProp<ViewStyle>;
  /**
   * Distance at which sibling glass shapes begin to fuse. Tune per cluster: the
   * row `gap` is a sensible default so neighbours merge exactly as they meet.
   */
  spacing?: number;
  pointerEvents?: ViewProps['pointerEvents'];
};

/**
 * Groups a row of glass controls so iOS 26 Liquid Glass merges them into one
 * fluid lozenge (`GlassContainer`), the native answer to a custom rounded
 * container with hand-drawn dividers. Everywhere else — iOS < 26, Android, and
 * Reduce Transparency — it's a plain `View`, so the children keep their own
 * shapes and nothing regresses.
 *
 * Guardrail (see `glassSize`): only wrap clusters whose members share ONE
 * height. Mismatched heights merge into an uneven silhouette, so the size-offset
 * surfaces (the bottom toolbar's hero FAB + shorter capsule) stay separate
 * bodies instead.
 */
export function GlassCluster({ children, style, spacing, pointerEvents }: GlassClusterProps) {
  const nativeGlass = useNativeGlass();
  const { m3SurfaceContainers } = useTheme();
  // Material groups the row into one M3 `surfaceContainer` lozenge (the M3 answer
  // to the merged-glass look); Liquid Glass without native glass (iOS < 26 /
  // Android) stays a plain pass-through so the members keep their own shapes.
  const materialGroupStyle = useVariantValue<ViewStyle | undefined>({
    material: { backgroundColor: m3SurfaceContainers.base, borderRadius: borderRadius.full },
    liquidGlass: undefined,
  });

  if (nativeGlass) {
    return (
      <GlassContainer spacing={spacing} style={style} pointerEvents={pointerEvents}>
        {children}
      </GlassContainer>
    );
  }

  return (
    <View style={[materialGroupStyle, style]} pointerEvents={pointerEvents}>
      {children}
    </View>
  );
}
