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
 *
 * Contrast (WCAG, light): white-on-primary #6D28D9 = 7.10:1; black-on-accent = 8.95:1.
 */
export const brandColors = {
  tint: '#6D28D9',
  primary: '#6D28D9',
  primaryFill: '#6D28D9',
  onPrimary: '#FFFFFF',
  accent: '#FF8A3D',
  success: '#047857',
  warning: '#B45309',
  error: '#C81E1E',
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
  success: '#34D399',
  warning: '#FBBF24',
  error: '#F87171',
} as const;

/**
 * Material 3 tonal surfaces for the Material UI variant, keyed by color scheme.
 * These are also the shared *surface anchors* the web app reads (background, card,
 * label, separator, fill) — neutrals are tinted toward the violet brand (#6D28D9)
 * so every surface reads as the same product rather than a generic theme. Labels
 * use opaque values so text contrast clears WCAG AA.
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
    tertiaryLabel: '#6E687C',
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
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
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
  const mix = (channel: 0 | 1 | 2) => fg[channel] * alpha + bg[channel] * (1 - alpha);
  return `#${toHexByte(mix(0))}${toHexByte(mix(1))}${toHexByte(mix(2))}`;
}

export type BrandColors = typeof brandColors;
export type MaterialSurfaces = typeof materialSurfaces;
export type MaterialSurfaceKey = keyof typeof materialSurfaces.light;
