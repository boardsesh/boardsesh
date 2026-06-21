import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Appearance, Platform, useColorScheme, type OpaqueColorValue } from 'react-native';
import {
  THEME_OVERRIDE_KEY,
  isThemeOverride,
  type ThemeOverride,
  UI_VARIANT_KEY,
  isUiVariantPreference,
  type UiVariantPreference,
} from '@boardsesh/key-value-storage';
import {
  iosSystemColors,
  brandColors,
  brandColorsDark,
  androidFallbackColors,
  materialSurfaces,
  materialSurfaceContainers,
  type MaterialSurfaceContainers,
} from '../theme/colors';
import { textStylesByVariant, type TextVariant, type TypeStyle } from '../theme/typography';
import { buildPaperTheme } from '../theme/paper-theme';
import type { MD3Theme } from 'react-native-paper';
import {
  spacing,
  borderRadius,
  shadows,
  opacity,
  radiiByVariant,
  sheetChromeByVariant,
  materialElevationByLevel,
  type Radii,
  type SheetChrome,
} from '../theme/tokens';
import { springs, timing, motionByVariant, type Motion } from '../theme/animations';
import { resolveUiVariant, type UiVariant } from '../theme/resolve-ui-variant';
import {
  resolveActionColors,
  resolveChartColors,
  sectionCaptionByVariant,
  type ActionColors,
  type ChartColors,
  type SectionCaption,
} from '../theme/variants/variant-tokens';
import { variantFeatures, type VariantFeatures } from '../theme/variants/variant-features';
import { secureStorePreferences } from '../lib/preferences/secure-store-adapter';
import { assertNever } from '../lib/assert-never';
import { SCREENSHOT_THEME_OVERRIDE, SCREENSHOT_VARIANT_PREFERENCE } from '../lib/screenshot-mode';

type ColorScheme = 'light' | 'dark';

/**
 * Resolved brand colours for the current colour scheme. `brandColors` (light) and
 * `brandColorsDark` share the same keys, so either set satisfies this shape.
 */
type ResolvedBrandColors = typeof brandColors | typeof brandColorsDark;

/**
 * Resolved system colors for the current color scheme.
 * On iOS these are PlatformColor (OpaqueColorValue); on Android they are
 * hex/rgba strings. The union matches Icon's `color` prop directly so callers
 * never need `as string` casts when passing these to style props or components.
 */
type ResolvedSystemColors = {
  background: string | OpaqueColorValue;
  secondaryBackground: string | OpaqueColorValue;
  tertiaryBackground: string | OpaqueColorValue;
  groupedBackground: string | OpaqueColorValue;
  elevatedSurface: string | OpaqueColorValue;
  label: string | OpaqueColorValue;
  secondaryLabel: string | OpaqueColorValue;
  tertiaryLabel: string | OpaqueColorValue;
  separator: string | OpaqueColorValue;
  fill: string | OpaqueColorValue;
  /**
   * Interactive-accent foreground (links, active tab, edit·copy·open). iOS uses
   * Apple's link blue; Android/Material use the brand violet, lifted to #A78BFA
   * in dark so it clears AA on near-black. Replaces the static
   * `iosSystemColors.systemBlue` for foreground use.
   */
  accent: string | OpaqueColorValue;
};

type Theme = {
  colorScheme: ColorScheme;
  systemColors: ResolvedSystemColors;
  brandColors: ResolvedBrandColors;
  /**
   * Type scale resolved for the current UI variant (Apple HIG on Liquid Glass, M3
   * on Material). Same keys/shape in both variants — only the sizes/weights
   * differ — so it's typed structurally rather than to one variant's literals.
   */
  textStyles: Record<TextVariant, TypeStyle>;
  spacing: typeof spacing;
  borderRadius: typeof borderRadius;
  shadows: typeof shadows;
  opacity: typeof opacity;
  springs: typeof springs;
  timing: typeof timing;
  /**
   * Variant-aware `withTiming` motion (`standard` / `emphasized`): M3 easing curves +
   * standard durations on Material, the prior durations (default ease) on Liquid
   * Glass. Pure data — build the reanimated config with `timingFor` (theme/motion-config).
   */
  motion: Motion;
  themeOverride: ThemeOverride;
  setThemeOverride: (next: ThemeOverride) => Promise<void>;
  /** Resolved visual variant the app renders in ('auto' already resolved). */
  variant: UiVariant;
  /** The user's raw stored preference, including 'auto'. Drives the settings UI. */
  uiVariantPreference: UiVariantPreference;
  setUiVariant: (next: UiVariantPreference) => Promise<void>;
  /** Semantic corner radii for the current variant (control/card/sheet). */
  radii: Radii;
  /** Bottom-sheet chrome (scrim/handle/corners) for the current variant. */
  sheet: SheetChrome;
  /**
   * MD3 colour roles (the full Paper palette: primaryContainer, secondaryContainer,
   * tertiaryContainer, onSurfaceVariant, outlineVariant, and the `elevation`
   * level0–5 surface-tint ladder) for the current colour scheme. Only meaningful
   * on the Material variant — Material-branch app components read these so they
   * match the Paper components without re-deriving roles; Liquid Glass never reads
   * it. Note: react-native-paper 5.15 predates MD3's `surfaceContainer*` tone
   * roles, so use the `elevation.levelN` ladder for surface-container surfaces.
   */
  m3: MD3Theme['colors'];
  /**
   * M3 tonal surface-container ramp ({lowest,low,base,high,highest}) for the
   * current colour scheme. Material surfaces read a role here to express depth by
   * TONE (the canonical M3 mechanism); pair with `materialElevation` for the cast.
   * Only meaningful on Material — Liquid Glass never reads it.
   */
  m3SurfaceContainers: MaterialSurfaceContainers;
  /**
   * M3 elevation casts keyed by level (`level0`–`level5`), each a full ViewStyle
   * (iOS `shadow*` + Android `elevation`). Scheme-independent. Apply on the same
   * view as the tonal background — never under `overflow:'hidden'`.
   */
  materialElevation: typeof materialElevationByLevel;
  /**
   * Semantic foregrounds for action rows / action FABs, resolved per variant:
   * monochrome (`systemColors.label`) on Liquid Glass, tinted by role on Material.
   */
  actionColors: ActionColors;
  /**
   * Plain-string colour palette for chart libraries (gifted-charts) that reject
   * PlatformColor. Mirrors `systemColors` but is always hex/rgba.
   */
  chartColors: ChartColors;
  /** Section-caption treatment (uppercase / opacity / letter-spacing), per variant. */
  sectionCaption: SectionCaption;
  /** Per-variant feature / content-layout flags (what shows, and where), resolved once. */
  features: VariantFeatures;
};

const ThemeContext = createContext<Theme | null>(null);

/**
 * Resolve system colors for the current platform and color scheme.
 *
 * On iOS, PlatformColor handles dark mode automatically, so we just
 * pass through the PlatformColor values unchanged.
 *
 * On Android, PlatformColor is not used — we pick from the
 * androidFallbackColors light/dark map.
 */
function resolveSystemColors(colorScheme: ColorScheme, variant: UiVariant): ResolvedSystemColors {
  switch (variant) {
    // Material variant: M3 tonal surfaces on every platform — including iOS 26
    // hardware when the user explicitly chose Material. Drawn opaque (no glass),
    // so we don't use PlatformColor here.
    case 'material':
      return { ...materialSurfaces[colorScheme] };
    case 'liquidGlass': {
      if (Platform.OS === 'ios' && iosSystemColors) {
        // PlatformColor values adapt automatically on iOS — return as-is.
        return iosSystemColors as ResolvedSystemColors;
      }
      // Android: resolve from the single source of truth for fallback colors.
      const fallback = colorScheme === 'dark' ? androidFallbackColors.dark : androidFallbackColors.light;
      return {
        background: fallback.background,
        secondaryBackground: fallback.secondaryBackground,
        tertiaryBackground: fallback.tertiaryBackground,
        groupedBackground: fallback.groupedBackground,
        elevatedSurface: fallback.elevatedSurface,
        label: fallback.label,
        secondaryLabel: fallback.secondaryLabel,
        tertiaryLabel: fallback.tertiaryLabel,
        separator: fallback.separator,
        fill: fallback.fill,
        accent: fallback.accent,
      };
    }
    // A new UiVariant must declare how its system colours resolve.
    default:
      return assertNever(variant);
  }
}

/**
 * Pick the brand colour set for the current scheme. The dark set lifts the violet
 * tint and brightens semantic tones so brand foregrounds stay legible on near-black.
 */
function resolveBrandColors(colorScheme: ColorScheme): ResolvedBrandColors {
  return colorScheme === 'dark' ? brandColorsDark : brandColors;
}

type ThemeProviderProps = {
  children: ReactNode;
};

export function ThemeProvider({ children }: ThemeProviderProps) {
  const deviceColorScheme = useColorScheme();
  // `'system'` until SecureStore hydrates — same value as a brand-new user, so
  // the first paint matches the OS preference. Once hydration completes the
  // resolved scheme switches to the saved override (if any) without a visible
  // flash when the OS already matches the override. In screenshot mode the
  // theme is locked to a fixed value (light by default) so captures can't flip
  // mid-run when the keychain read resolves.
  const [themeOverride, setThemeOverrideState] = useState<ThemeOverride>(
    process.env.EXPO_PUBLIC_SCREENSHOT_MODE === '1' ? SCREENSHOT_THEME_OVERRIDE : 'system',
  );
  // `'auto'` until SecureStore hydrates — same value as a brand-new user, so the
  // first paint resolves to the platform default (Liquid Glass on iOS 26,
  // Material elsewhere) via the synchronous capability check, no flash. Locked
  // in screenshot mode for the same reason as the theme override.
  const [uiVariantPreference, setUiVariantPreferenceState] = useState<UiVariantPreference>(
    process.env.EXPO_PUBLIC_SCREENSHOT_MODE === '1' ? SCREENSHOT_VARIANT_PREFERENCE : 'auto',
  );
  // Guards the hydration effect against stomping a user choice that lands
  // before the SecureStore read resolves (a tap on a settings toggle can
  // beat the keychain read on a cold launch).
  const hasUserChosenRef = useRef(false);
  const hasUserChosenVariantRef = useRef(false);

  useEffect(() => {
    // Screenshot mode pins the theme + variant to fixed values, so skip the
    // SecureStore reads entirely — otherwise a saved override could flip the
    // look between the first paint and the capture.
    if (process.env.EXPO_PUBLIC_SCREENSHOT_MODE === '1') return;
    let cancelled = false;
    secureStorePreferences
      .get<ThemeOverride>(THEME_OVERRIDE_KEY)
      .then((value) => {
        if (cancelled || hasUserChosenRef.current) return;
        if (isThemeOverride(value)) setThemeOverrideState(value);
      })
      .catch(() => {
        // Storage read can fail if SecureStore is unavailable (rare). Stay on
        // the 'system' default rather than crashing — the user's override is
        // lost for this session but the app remains usable.
      });
    secureStorePreferences
      .get<UiVariantPreference>(UI_VARIANT_KEY)
      .then((value) => {
        if (cancelled || hasUserChosenVariantRef.current) return;
        if (isUiVariantPreference(value)) setUiVariantPreferenceState(value);
      })
      .catch(() => {
        // Same rationale as the theme override read — stay on 'auto'.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Drive the native Appearance so the override actually flips iOS
  // `PlatformColor` (which follows the native trait collection, not our JS
  // `colorScheme`). 'unspecified' = follow the OS. Without this, a non-system
  // choice would leave iOS system colours on the OS scheme. Keep
  // `userInterfaceStyle: 'automatic'` in app.config.ts so this can take effect.
  useEffect(() => {
    Appearance.setColorScheme(themeOverride === 'system' ? 'unspecified' : themeOverride);
  }, [themeOverride]);

  const colorScheme: ColorScheme = useMemo(() => {
    if (themeOverride === 'light') return 'light';
    if (themeOverride === 'dark') return 'dark';
    return deviceColorScheme === 'dark' ? 'dark' : 'light';
  }, [themeOverride, deviceColorScheme]);

  const setThemeOverride = useCallback(async (next: ThemeOverride) => {
    hasUserChosenRef.current = true;
    setThemeOverrideState(next);
    try {
      await secureStorePreferences.set(THEME_OVERRIDE_KEY, next);
    } catch (error) {
      // Storage write failed (rare); leave the in-memory state on the user's
      // pick so the session reflects it, and log so we notice if this happens
      // consistently. Reverting on write failure would be worse — the toggle
      // would visibly snap back, which the user reads as a broken UI.
      // eslint-disable-next-line no-console
      console.warn('[theme-provider] Failed to persist theme override', error);
    }
  }, []);

  const setUiVariant = useCallback(async (next: UiVariantPreference) => {
    hasUserChosenVariantRef.current = true;
    setUiVariantPreferenceState(next);
    try {
      await secureStorePreferences.set(UI_VARIANT_KEY, next);
    } catch (error) {
      // See setThemeOverride — keep the in-memory pick on write failure.
      // eslint-disable-next-line no-console
      console.warn('[theme-provider] Failed to persist UI variant', error);
    }
  }, []);

  // 'auto' follows the platform aesthetic: Liquid Glass on every iPhone (the blur
  // fallback covers iOS < 26), Material on Android. Read Platform.OS inside the memo
  // — it's a process constant, so listing it as a dep would read as reactive when it
  // never changes. The synchronous check lets the first paint resolve 'auto' without
  // waiting on the async SecureStore read. Whether real iOS 26 glass chrome renders
  // is a separate, downstream concern (useGlassCapability / useEffectiveSurfaceMode).
  const variant = useMemo<UiVariant>(
    () => resolveUiVariant(uiVariantPreference, Platform.OS === 'ios'),
    [uiVariantPreference],
  );

  // MD3 colour roles for the current scheme, memoized so the Paper theme is built
  // once per light/dark flip — not on every render — and shared with the rest of
  // the Material chrome. `MaterialThemeProvider` builds the full MD3Theme from the
  // same `buildPaperTheme(colorScheme)`; here we keep just the `.colors` palette
  // for app components that aren't Paper consumers.
  const m3Colors = useMemo<MD3Theme['colors']>(() => buildPaperTheme(colorScheme).colors, [colorScheme]);

  const theme = useMemo<Theme>(() => {
    const resolvedSystemColors = resolveSystemColors(colorScheme, variant);
    const resolvedBrandColors = resolveBrandColors(colorScheme);

    return {
      colorScheme,
      systemColors: resolvedSystemColors,
      brandColors: resolvedBrandColors,
      textStyles: textStylesByVariant[variant],
      spacing,
      borderRadius,
      shadows,
      opacity,
      springs,
      timing,
      motion: motionByVariant[variant],
      themeOverride,
      setThemeOverride,
      variant,
      uiVariantPreference,
      setUiVariant,
      radii: radiiByVariant[variant],
      sheet: sheetChromeByVariant[variant],
      m3: m3Colors,
      m3SurfaceContainers: materialSurfaceContainers[colorScheme],
      materialElevation: materialElevationByLevel,
      actionColors: resolveActionColors(variant, {
        label: resolvedSystemColors.label,
        accent: resolvedSystemColors.accent,
        brandSuccess: resolvedBrandColors.success,
        brandPrimary: resolvedBrandColors.primary,
      }),
      chartColors: resolveChartColors(variant, colorScheme),
      sectionCaption: sectionCaptionByVariant[variant],
      features: variantFeatures[variant],
    };
  }, [colorScheme, variant, themeOverride, setThemeOverride, uiVariantPreference, setUiVariant, m3Colors]);

  // React 19 context provider syntax (Expo SDK 53+ / React 19)
  return <ThemeContext value={theme}>{children}</ThemeContext>;
}

/**
 * Access the current theme. Must be called inside a ThemeProvider.
 */
export function useTheme(): Theme {
  const theme = useContext(ThemeContext);
  if (theme === null) {
    throw new Error('useTheme must be used within a ThemeProvider');
  }
  return theme;
}

/**
 * Access the theme without throwing when no provider is mounted. Returns null
 * outside a ThemeProvider — used by low-level primitives (e.g. Text) that may
 * render before providers mount, such as the root error boundary.
 */
export function useOptionalTheme(): Theme | null {
  return useContext(ThemeContext);
}

export type { Theme, ColorScheme, ResolvedSystemColors, TextVariant, UiVariant };
