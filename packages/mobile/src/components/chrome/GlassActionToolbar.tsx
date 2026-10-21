import { createContext, useContext, type ReactNode } from 'react';
import { NativeHeaderActionContext, NativeHeaderOwnBackgroundContext } from './native-header-action-context';
import type { AccessibilityActionEvent, AccessibilityActionInfo } from 'react-native';
import { StyleSheet, View } from 'react-native';
import { useTheme } from '../../providers/theme-provider';
import { useNativeGlass } from '../../hooks/use-native-glass';
import { shadows } from '../../theme/tokens';
import { glassSize } from '../../theme/layout';
import { GlassSurface } from '../GlassSurface';
import { PressableSurface } from '../PressableSurface';

/** Edge length of one floating toolbar action target. */
export const TOP_ACTION_SIZE = glassSize.standard;
/** Edge length of one action slot in UIKit's native navigation bar. */
export const NATIVE_ACTION_SIZE = glassSize.bar;
/** The slot toolbar glyph sizes are drawn for; `toolbarGlyphSize` scales from it. */
const GLYPH_REFERENCE_SLOT = glassSize.inline;
const ToolbarActionSizeContext = createContext<number | undefined>(undefined);
const ToolbarActionCountContext = createContext(1);

/** A toolbar's children share its slot size, including custom controls. */
export function useToolbarActionSize(): number {
  const toolbarSize = useContext(ToolbarActionSizeContext);
  const nativeHeader = useContext(NativeHeaderActionContext);
  return toolbarSize ?? (nativeHeader ? NATIVE_ACTION_SIZE : TOP_ACTION_SIZE);
}

/**
 * A toolbar glyph's size in a slot of `actionSize`. Glyphs are drawn for a 44pt
 * slot or larger and keep their size there; a narrower native bar slot scales
 * them down with it, so a 24pt plus becomes 21pt in a 38pt slot.
 */
export function toolbarGlyphSize(baseSize: number, actionSize: number): number {
  return Math.round(baseSize * Math.min(1, actionSize / GLYPH_REFERENCE_SLOT));
}

export function useToolbarActionCount(): number {
  return useContext(ToolbarActionCountContext);
}

/**
 * A floating glass "island" that hosts one or more toolbar actions, sized to a
 * whole number of `TOP_ACTION_SIZE` slots. Lifted out of ClimbTopChrome so the
 * Climbs and Discover chromes render the same island vocabulary. The glass /
 * blur / solid material plus the shadow + hairline fallback (when there is no
 * native glass) live here; callers supply only the actions and the count.
 */
export function GlassActionToolbar({
  actionCount,
  actionSize,
  children,
  testID,
}: {
  actionCount: number;
  actionSize?: number;
  children: ReactNode;
  testID?: string;
}) {
  const { systemColors } = useTheme();
  const nativeGlass = useNativeGlass();
  const nativeHeader = useContext(NativeHeaderActionContext);
  const ownsNativeBackground = useContext(NativeHeaderOwnBackgroundContext);
  const resolvedActionSize = actionSize ?? (nativeHeader ? NATIVE_ACTION_SIZE : TOP_ACTION_SIZE);
  const showsBackground = !nativeHeader || ownsNativeBackground;
  return (
    <ToolbarActionSizeContext.Provider value={resolvedActionSize}>
      <ToolbarActionCountContext.Provider value={actionCount}>
        <View
          testID={testID}
          style={[
            styles.toolbar,
            {
              width: resolvedActionSize * actionCount,
              height: resolvedActionSize,
              borderRadius: resolvedActionSize / 2,
              overflow: nativeHeader ? 'visible' : 'hidden',
            },
            showsBackground && !nativeGlass && shadows.sm,
            showsBackground &&
              !nativeGlass && { borderWidth: StyleSheet.hairlineWidth, borderColor: systemColors.separator },
          ]}
        >
          {showsBackground ? (
            <GlassSurface
              // Regular glass keeps toolbar glyphs legible over ordinary app content.
              // Clear glass is reserved for controls over visually rich media.
              glassEffectStyle="regular"
              role="base"
              fallbackColor={systemColors.elevatedSurface}
              borderRadius={resolvedActionSize / 2}
              style={StyleSheet.absoluteFill}
              pointerEvents="none"
            />
          ) : null}
          {children}
        </View>
      </ToolbarActionCountContext.Provider>
    </ToolbarActionSizeContext.Provider>
  );
}

/** One action target inside a `GlassActionToolbar` (create +, angle, light). */
export function GlassToolbarAction({
  onPress,
  onLongPress,
  accessibilityLabel,
  accessibilityHint,
  accessibilityActions,
  onAccessibilityAction,
  children,
}: {
  onPress: () => void;
  onLongPress?: () => void;
  accessibilityLabel: string;
  accessibilityHint?: string;
  /** Screen-reader route to what `onLongPress` does (HIG Gestures: a simple alternative). */
  accessibilityActions?: ReadonlyArray<AccessibilityActionInfo>;
  onAccessibilityAction?: (event: AccessibilityActionEvent) => void;
  children: ReactNode;
}) {
  const actionSize = useToolbarActionSize();
  return (
    <PressableSurface
      onPress={onPress}
      onLongPress={onLongPress}
      feedback="opacity"
      hitSlop={4}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityHint={accessibilityHint}
      accessibilityActions={accessibilityActions}
      onAccessibilityAction={onAccessibilityAction}
      style={[styles.action, { width: actionSize, height: actionSize }]}
    >
      {children}
    </PressableSurface>
  );
}

const styles = StyleSheet.create({
  toolbar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-end',
    overflow: 'hidden',
  },
  action: {
    alignItems: 'center',
    justifyContent: 'center',
  },
});
