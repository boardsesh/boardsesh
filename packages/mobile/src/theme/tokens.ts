/**
 * Cross-platform design tokens.
 *
 * Color tokens have moved to ./colors.ts
 * Typography tokens have moved to ./typography.ts
 * Animation tokens have moved to ./animations.ts
 */

import { iosSystemColors } from './ios-colors';
import { withAlpha } from './colors';

export const spacing = {
  0: 0,
  1: 4,
  2: 8,
  3: 12,
  4: 16,
  5: 20,
  6: 24,
  8: 32,
  10: 40,
  12: 48,
  16: 64,
} as const;

export const borderRadius = {
  none: 0,
  sm: 4,
  md: 8,
  lg: 12,
  xl: 16,
  full: 9999,
} as const;

export const shadowColor = '#000' as const;

export const shadows = {
  xs: {
    shadowColor,
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.05,
    shadowRadius: 1,
    elevation: 1,
  },
  sm: {
    shadowColor,
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.1,
    shadowRadius: 2,
    elevation: 2,
  },
  md: {
    shadowColor,
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.1,
    shadowRadius: 4,
    elevation: 4,
  },
  lg: {
    shadowColor,
    shadowOffset: { width: 0, height: 10 },
    shadowOpacity: 0.1,
    shadowRadius: 8,
    elevation: 8,
  },
  xl: {
    shadowColor,
    shadowOffset: { width: 0, height: 20 },
    shadowOpacity: 0.1,
    shadowRadius: 12,
    elevation: 12,
  },
} as const;

/**
 * Material 3 elevation as a full ViewStyle per level — iOS `shadow*` props AND
 * Android `elevation` in one object, because iOS ignores `elevation` (a bare
 * number renders flat on Material-on-iOS) and Android ignores `shadow*`. Pair
 * with the tonal `m3SurfaceContainers` ramp: depth on Material is tone-FIRST,
 * with these casts layered on the components M3 actually shadows (sheet L1, nav/
 * menu L2, dialog/FAB L3+). Level 0 is flat (app-bar-at-rest, filled card). Apply
 * on the SAME view as the background + radius (never under `overflow:'hidden'`,
 * which clips the cast) — see `GlassSurface`'s material branch.
 */
export const materialElevationByLevel = {
  level0: { shadowColor, shadowOffset: { width: 0, height: 0 }, shadowOpacity: 0, shadowRadius: 0, elevation: 0 },
  level1: { shadowColor, shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.1, shadowRadius: 2, elevation: 1 },
  level2: { shadowColor, shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.12, shadowRadius: 3, elevation: 2 },
  level3: { shadowColor, shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.14, shadowRadius: 5, elevation: 3 },
  level4: { shadowColor, shadowOffset: { width: 0, height: 3 }, shadowOpacity: 0.15, shadowRadius: 6, elevation: 4 },
  level5: { shadowColor, shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.16, shadowRadius: 8, elevation: 5 },
} as const;

export type MaterialElevationLevel = keyof typeof materialElevationByLevel;

export const opacity = {
  subtle: 0.7,
  peek: 0.62,
  disabled: 0.5,
} as const;

/**
 * Floating-overlay tokens. Intentionally fixed across light/dark — these are
 * for chips/buttons that overlay arbitrary content (board images, photos) and
 * need stable contrast regardless of the user's color scheme.
 */
export const overlays = {
  scrim: 'rgba(0, 0, 0, 0.6)',
  onScrim: '#FFFFFF',
} as const;

/** Shared bottom-sheet handle and background styles used by QueueSheet, AngleSelectorSheet, and PlayDrawer. */
export const sheetStyles = {
  indicator: {
    backgroundColor: `${iosSystemColors.systemGray}4D`,
    width: 36,
    height: 5,
    borderRadius: 3,
  },
  background: {
    borderTopLeftRadius: borderRadius.xl,
    borderTopRightRadius: borderRadius.xl,
  },
} as const;

/**
 * Material 3 building blocks used ONLY on the Android branches of the three
 * Material-ized surfaces (bottom navigation, bottom sheets, buttons). Kept
 * deliberately small — this is a hybrid skin over the existing components, not a
 * parallel Material design system.
 */
export const material = {
  /** M3 pressed state-layer opacity, used to tint ripples (and the iOS-on-Material
   *  pressed overlay, where there is no `android_ripple`). */
  pressedStateLayer: 0.12,
  /** M3 disabled opacities: content (text/icon) at 38%, container fill at 12% —
   *  replaces the single Liquid-Glass `opacity.disabled` (0.5) on Material. */
  disabledContentOpacity: 0.38,
  disabledContainerOpacity: 0.12,
  navBar: {
    /** Tonal pill behind the focused tab's icon (M3 spec: 64×32). */
    activeIndicatorWidth: 64,
    activeIndicatorHeight: 32,
    activeIndicatorRadius: 16,
    /** Resting elevation of the solid Android nav surface (M3 nav bar = level 2). */
    surfaceElevation: 2,
  },
  sheet: {
    /** M3 bottom-sheet top corner radius (iOS keeps borderRadius.xl = 16). */
    cornerRadius: 28,
    handleWidth: 32,
    handleHeight: 4,
    /** M3 scrim opacity (iOS keeps 0.4). */
    scrimOpacity: 0.32,
  },
  button: {
    /** M3 filled/tonal/outlined/text corner radius (iOS keeps 10). */
    radius: 20,
  },
} as const;

/**
 * Builds a Pressable `android_ripple` config from a base colour at the M3
 * pressed state-layer opacity. `borderless` suits circular targets (tab items,
 * icon buttons); bounded ripple suits filled/outlined surfaces. Android-only —
 * iOS uses the reanimated scale/opacity path in PressableSurface.
 */
export function androidRipple(color: string, borderless = false): { color: string; borderless: boolean } {
  return { color: withAlpha(color, material.pressedStateLayer), borderless };
}

/**
 * Corner radii that genuinely differ between the two variants, resolved via
 * `theme.radii`. Pills/capsules stay fully rounded and cards stay `lg` in BOTH
 * variants (the variants differ in surface/elevation, not those silhouettes), so
 * they're not here — only the button corner varies (soft 10dp on Liquid Glass,
 * M3 20dp on Material). Sheet corners live in `sheetChromeByVariant` below.
 */
export const radiiByVariant = {
  liquidGlass: {
    button: 10,
  },
  material: {
    button: material.button.radius,
  },
} as const;

/**
 * Bottom-sheet chrome resolved per UI variant (supersedes the old
 * `Platform.OS`-keyed `sheetAndroid` so an iOS-26 user on Material gets M3 sheet
 * metrics too). Liquid Glass keeps the softer existing look; Material uses the
 * M3 metrics (28dp corners, slimmer handle, lighter scrim). Consumed by Sheet,
 * ModalSheet and PlayDrawer via `theme.sheet` so the three never drift.
 */
export const sheetChromeByVariant = {
  liquidGlass: {
    scrimOpacity: 0.4,
    handleStyle: sheetStyles.indicator,
    corners: null as { borderTopLeftRadius: number; borderTopRightRadius: number } | null,
  },
  material: {
    scrimOpacity: material.sheet.scrimOpacity,
    handleStyle: { ...sheetStyles.indicator, width: material.sheet.handleWidth, height: material.sheet.handleHeight },
    corners: {
      borderTopLeftRadius: material.sheet.cornerRadius,
      borderTopRightRadius: material.sheet.cornerRadius,
    } as { borderTopLeftRadius: number; borderTopRightRadius: number } | null,
  },
} as const;

export type Spacing = typeof spacing;
export type BorderRadius = typeof borderRadius;
export type Shadows = typeof shadows;
export type Opacity = typeof opacity;
export type Material = typeof material;
export type Radii = (typeof radiiByVariant)[keyof typeof radiiByVariant];
export type SheetChrome = (typeof sheetChromeByVariant)[keyof typeof sheetChromeByVariant];
