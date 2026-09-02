/**
 * @boardsesh/velvet-tokens — the canonical "Velvet Send" brand palette, surface
 * anchors, and colour-math helpers, shared by the web app (MUI + CSS vars) and the
 * React Native app (theme provider). This is the single source of truth that keeps
 * the violet identity in sync across platforms.
 *
 * Pure TS: no react-native, no MUI, no DOM. Platform-specific resolution
 * (iOS PlatformColor, M3 tonal containers, Android fallbacks, Liquid-Glass tint)
 * stays in each app and computes on top of these anchors.
 */

// Dev-only warning gate. `process.env.NODE_ENV` is inlined by Next at build and is
// populated by Metro/React Native at runtime, so this works on both platforms
// without depending on the RN-only `__DEV__` global.
const isDev = process.env.NODE_ENV !== 'production';

/**
 * Brand colors — "Velvet Send" system, anchored on the logo's V11–V16 purples.
 *
 * `brandColors` holds the LIGHT-scheme values (and the scheme-agnostic anchors);
 * `brandColorsDark` overrides the few roles that need a different value in dark
 * mode so they stay legible. Consumers resolve the right set per scheme.
 *
 * Role split:
 * - `primary`/`tint`: brand colour for FOREGROUND use (text, icons, links, borders).
 * - `primaryFill`: brand colour for a FILLED surface/button background.
 * - `onPrimary`: text/icon colour sitting on `primaryFill`.
 * - `accent`: warm amber spark for highlights — FILL-ONLY, always pair with dark text.
 * - `onAccent`: the ink that pairs with `accent`. Same value in both schemes because
 *   `accent` itself doesn't change per scheme — a filled amber chip reads identically
 *   in light and dark, so its text must too.
 * - `live`: the "this climb is physically lit / now on the wall" status hue. A
 *   dedicated role (not `warning`) so a future warning retune can't silently shift
 *   the board-presence affordance. Resolves to the warm amber per scheme.
 * - `historyFill`: the FILLED slate bar behind the wall kiosk's "viewing history"
 *   state — a positive, distinct-from-amber signal, not an absence-of-amber wash.
 *   White text clears AA on both schemes.
 *
 * Contrast (WCAG, light): white-on-primary #6D28D9 = 7.10:1; black-on-accent = 8.95:1.
 */
export const brandColors = {
  tint: '#6D28D9',
  primary: '#6D28D9',
  primaryFill: '#6D28D9',
  onPrimary: '#FFFFFF',
  accent: '#FF8A3D',
  onAccent: '#16111F',
  success: '#047857',
  warning: '#B45309',
  error: '#C81E1E',
  live: '#B45309',
  historyFill: '#475569',
} as const;

/**
 * Dark-scheme brand overrides. The dark violet primary is too low-contrast as a
 * foreground on near-black, so the tint lifts to #A78BFA; filled buttons use a
 * brighter #7C3AED so white text still clears AA (5.70:1). Semantic tones brighten
 * for legibility on dark surfaces. Same keys as `brandColors`.
 *
 * Contrast (WCAG, dark): #A78BFA tint ≥5.5:1 on dark surfaces up through elevated;
 * white-on-#7C3AED = 5.70:1.
 */
export const brandColorsDark = {
  tint: '#A78BFA',
  primary: '#A78BFA',
  primaryFill: '#7C3AED',
  onPrimary: '#FFFFFF',
  accent: '#FF8A3D',
  onAccent: '#16111F',
  success: '#34D399',
  warning: '#FBBF24',
  error: '#F87171',
  live: '#FBBF24',
  historyFill: '#64748B',
} as const;

/**
 * Material 3 tonal surfaces for the Material UI variant (the React Native app), keyed
 * by color scheme. Neutrals are tinted toward the violet brand (#6D28D9) so every
 * surface reads as the same product rather than a generic theme. Labels use opaque
 * values so text contrast clears WCAG AA.
 *
 * Web shares only the BRAND colours from this package (`brandColors`/`brandColorsDark`
 * — see `theme-config.ts`). The web SURFACE ladder is intentionally NOT these anchors:
 * web hand-tunes a richer, more-violet page → card → elevated ladder in
 * `packages/web/app/theme/theme-config.ts` (light #E8DDF6 / #FAF6FE / #FFFFFF, dark
 * #110A20 / #251B3A / #2F234A) so the velvet permeates cards and greys rather than
 * reading as white + neutral grey. That divergence is deliberate and guarded by
 * `velvet-tokens-parity.test.ts`; changing either side is a conscious design decision.
 */
export const materialSurfaces = {
  light: {
    // M3 base surface — violet-tinted so cards/elevation read against it.
    background: '#F3EFFA',
    // Cards and sheets sit a step up from the base (surface container low).
    secondaryBackground: '#FFFFFF',
    tertiaryBackground: '#FFFFFF',
    groupedBackground: '#F3EFFA',
    // Raised tile (selected segmented pill, elevated bar) — surface + elevation.
    elevatedSurface: '#FFFFFF',
    label: '#16111F',
    secondaryLabel: '#5B5563',
    tertiaryLabel: '#8E8898',
    // M3 outline-variant.
    separator: 'rgba(60, 55, 75, 0.18)',
    // Faint violet track for segmented controls / fills (bumped to 0.14 so selected
    // pills read on white).
    fill: 'rgba(109, 40, 217, 0.14)',
    // Interactive-accent foreground — brand violet, lifted in dark.
    accent: '#6D28D9',
  },
  dark: {
    background: '#15101E',
    secondaryBackground: '#221A33',
    tertiaryBackground: '#2A2142',
    groupedBackground: '#15101E',
    elevatedSurface: '#2A2142',
    label: '#F5F2FB',
    secondaryLabel: '#A9A2B6',
    // Lifted from #6E687C, which measured 2.82:1 against `elevatedSurface`
    // (#2A2142) — under the 3:1 AA bar for large/de-emphasised text on the most
    // raised dark surface. #746E82 clears it on every dark ground (3.08–3.82)
    // while staying far below `secondaryLabel` (6.12:1), so the hierarchy holds.
    // Enforced by theme/__tests__/palette-contrast.test.ts.
    tertiaryLabel: '#746E82',
    separator: 'rgba(180, 168, 205, 0.18)',
    fill: 'rgba(199, 184, 232, 0.14)',
    accent: '#A78BFA',
  },
} as const;

/**
 * Normalise a `#RGB`/`#RRGGBB` hex string to a 6-digit hex (no `#`), or return
 * `null` for any other format (already-`rgba()`, named colour, PlatformColor).
 * Shared by `withAlpha` and `parseHex` so the expansion/validation rule can't drift.
 */
function expandHex(color: string): string | null {
  const hex = color.replace('#', '');
  const full = hex.length === 3 ? hex.replace(/(.)/g, '$1$1') : hex;
  return full.length === 6 && !/[^0-9a-fA-F]/.test(full) ? full : null;
}

/**
 * Apply an alpha (0–1) to a colour. Handles `#RGB` and `#RRGGBB` hex by emitting an
 * `rgba()` string; any other format (already-`rgba()`, named colour, PlatformColor)
 * is returned unchanged so this never produces an invalid colour value.
 */
export function withAlpha(color: string, alpha: number): string {
  const full = expandHex(color);
  if (!full) {
    if (isDev) {
      // eslint-disable-next-line no-console
      console.warn(`[withAlpha] expected a hex colour, got "${color}" — returning it unchanged (alpha not applied)`);
    }
    return color;
  }
  const r = parseInt(full.slice(0, 2), 16);
  const g = parseInt(full.slice(2, 4), 16);
  const b = parseInt(full.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${clampAlpha(alpha)})`;
}

/** Clamp an alpha to [0, 1] so out-of-range input can't emit an invalid colour. */
function clampAlpha(alpha: number): number {
  return Math.min(1, Math.max(0, alpha));
}

function parseHex(color: string): [number, number, number] | null {
  const full = expandHex(color);
  if (!full) return null;
  return [parseInt(full.slice(0, 2), 16), parseInt(full.slice(2, 4), 16), parseInt(full.slice(4, 6), 16)];
}

function toHexByte(value: number): string {
  return Math.round(value).toString(16).padStart(2, '0');
}

/**
 * Alpha-composite `foreground` over `background` at `alpha` (0–1) and return an
 * opaque `#RRGGBB`. Unlike `withAlpha` (which yields a translucent `rgba()`), this is
 * for surfaces that float over arbitrary content and must stay opaque. Both inputs
 * must be `#RGB`/`#RRGGBB` hex; any other format returns `background` unchanged.
 */
export function blendOpaque(foreground: string, background: string, alpha: number): string {
  const fg = parseHex(foreground);
  const bg = parseHex(background);
  if (!fg || !bg) {
    if (isDev) {
      // eslint-disable-next-line no-console
      console.warn(
        `[blendOpaque] expected hex colours, got foreground "${foreground}" / background "${background}" — returning background unchanged`,
      );
    }
    return background;
  }
  const a = clampAlpha(alpha);
  const mix = (channel: 0 | 1 | 2) => fg[channel] * a + bg[channel] * (1 - a);
  return `#${toHexByte(mix(0))}${toHexByte(mix(1))}${toHexByte(mix(2))}`;
}

/**
 * WCAG 2.1 relative luminance of an opaque `#RGB`/`#RRGGBB` colour, or `null` for
 * any other format (`rgba()`, a named colour, a PlatformColor). Exported mainly so
 * `contrastRatio` can be tested directly.
 */
export function relativeLuminance(color: string): number | null {
  const rgb = parseHex(color);
  if (!rgb) return null;
  const channel = (value: number) => {
    const srgb = value / 255;
    return srgb <= 0.03928 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(rgb[0]) + 0.7152 * channel(rgb[1]) + 0.0722 * channel(rgb[2]);
}

/**
 * WCAG 2.1 contrast ratio between two opaque hex colours (1–21), or `null` if
 * either is not opaque hex. AA body text needs >= 4.5, AA large text >= 3.
 *
 * The palettes document their ratios in prose; this is what lets a test assert
 * them, so a "small tweak" to a surface can't quietly push a label under AA.
 */
export function contrastRatio(foreground: string, background: string): number | null {
  const foregroundLuminance = relativeLuminance(foreground);
  const backgroundLuminance = relativeLuminance(background);
  if (foregroundLuminance === null || backgroundLuminance === null) return null;
  const lighter = Math.max(foregroundLuminance, backgroundLuminance);
  const darker = Math.min(foregroundLuminance, backgroundLuminance);
  return (lighter + 0.05) / (darker + 0.05);
}

export type BrandColors = typeof brandColors;
export type MaterialSurfaces = typeof materialSurfaces;
export type MaterialSurfaceKey = keyof typeof materialSurfaces.light;
