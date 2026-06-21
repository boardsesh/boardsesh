import { type ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';
import { useTheme } from '../../providers/theme-provider';
import { useNativeGlass } from '../../hooks/use-native-glass';
import { shadows } from '../../theme/tokens';
import { glassSize } from '../../theme/layout';
import { GlassSurface } from '../GlassSurface';
import { PressableSurface } from '../PressableSurface';

/** Edge length of one floating toolbar action target. */
export const TOP_ACTION_SIZE = glassSize.standard;
const TOP_TOOLBAR_RADIUS = TOP_ACTION_SIZE / 2;

/**
 * A floating glass "island" that hosts one or more toolbar actions, sized to a
 * whole number of `TOP_ACTION_SIZE` slots. Lifted out of ClimbTopChrome so the
 * Climbs and Discover chromes render the same island vocabulary. The glass /
 * blur / solid material plus the shadow + hairline fallback (when there is no
 * native glass) live here; callers supply only the actions and the count.
 */
export function GlassActionToolbar({ actionCount, children }: { actionCount: number; children: ReactNode }) {
  const { systemColors } = useTheme();
  const nativeGlass = useNativeGlass();
  return (
    <View
      style={[
        styles.toolbar,
        { width: TOP_ACTION_SIZE * actionCount },
        !nativeGlass && shadows.sm,
        !nativeGlass && { borderWidth: StyleSheet.hairlineWidth, borderColor: systemColors.separator },
      ]}
    >
      <GlassSurface
        // `clear` (lighter, content-forward) for the floating islands — more
        // transparent than `regular`, the right variant for floating bars.
        glassEffectStyle="clear"
        // Floating toolbar island = M3 surfaceContainer tone on Material.
        role="base"
        fallbackColor={systemColors.elevatedSurface}
        borderRadius={TOP_TOOLBAR_RADIUS}
        style={StyleSheet.absoluteFill}
        pointerEvents="none"
      />
      {children}
    </View>
  );
}

/** One action target inside a `GlassActionToolbar` (create +, angle, light). */
export function GlassToolbarAction({
  onPress,
  accessibilityLabel,
  accessibilityHint,
  children,
}: {
  onPress: () => void;
  accessibilityLabel: string;
  accessibilityHint?: string;
  children: ReactNode;
}) {
  return (
    <PressableSurface
      onPress={onPress}
      feedback="opacity"
      hitSlop={4}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityHint={accessibilityHint}
      style={styles.action}
    >
      {children}
    </PressableSurface>
  );
}

const styles = StyleSheet.create({
  toolbar: {
    height: TOP_ACTION_SIZE,
    borderRadius: TOP_TOOLBAR_RADIUS,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-end',
    overflow: 'hidden',
  },
  action: {
    width: TOP_ACTION_SIZE,
    height: TOP_ACTION_SIZE,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
