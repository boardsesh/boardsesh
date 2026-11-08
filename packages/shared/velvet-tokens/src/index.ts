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
 * DO NOT delete `brandColors` as dead code because nothing in `packages/web`
 * imports it. www collapsed to one dark scheme, so web reads only the dark half —
 * but MOBILE still renders light and resolves both. Its guard is the test beside
 * this file.
 *
 * Role split:
 * - `primary`/`tint`: brand colour for FOREGROUND use (text, icons, links, borders).
 * - `primaryFill`: brand colour for a FILLED surface/button background.
 * - `primaryStrong`: brand foreground for text on a TONAL violet wash (the
 *   player's wall button): one step deeper than `primary` in light, so the label
 *   keeps 4.6:1 on the 20% wash over every sheet; the same lifted violet in dark.
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
  primaryStrong: '#5B21B6',
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
 * Contrast (WCAG, dark): #A78BFA tint 6.25:1 on #1C1C1E and 5.12:1 on the iOS
 * elevated grouped card (#2C2C2E) — legible for text and controls drawn on a card.
 * #7C3AED is a FILL only: white-on-#7C3AED = 5.70:1, but #7C3AED itself is 2.45:1
 * on #2C2C2E, so never use it as a control tint or text on a dark card.
 */
export const brandColorsDark = {
  tint: '#A78BFA',
  primary: '#A78BFA',
  primaryFill: '#7C3AED',
  primaryStrong: '#A78BFA',
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
 * Material 3 surfaces for the Material UI variant of the React Native app (Android,
 * the Expo browser app, and a legacy saved choice on iOS), keyed by colour scheme.
 *
 * "Graphite": every neutral here is pure grey (R = G = B, chroma 0). Violet is kept
 * for action and state only: `accent`, the brand fills, and the opaque M3 tonal
 * containers the app builds on top of these anchors. Labels are opaque so text
 * contrast clears WCAG AA; `material-theme-contrast.test.ts` in the mobile app pins
 * every pairing.
 *
 * Contrast (WCAG): dark label #EDEDED 16.5:1 on the #0E0E0E page and 14.2:1 on the
 * #1E1E1E card; secondary #B0B0B0 6.2:1 or more on every container step; tertiary
 * #8F8F8F 5.15:1 on the card, so it stays off the two highest container steps.
 * Light label #1A1A1A 12.3:1 or more; secondary #5A5A5A 4.89:1 or more; tertiary
 * #686868 4.98:1 on the #F2F2F2 page, so it stays on page, card, lowest and low.
 *
 * Web shares only the BRAND colours from this package (`brandColors`/`brandColorsDark`
 * — see `theme-config.ts`). The web SURFACE ladder is deliberately NOT these anchors:
 * www keeps its own hand-tuned violet page → card → elevated ladder in
 * `packages/web/app/theme/theme-config.ts` (dark #110A20 / #251B3A / #2F234A), so the
 * marketing site stays velvet while the app goes neutral. That divergence is guarded
 * by `velvet-tokens-parity.test.ts`; changing either side is a conscious decision.
 */
export const materialSurfaces = {
  light: {
    // Page ground: the lowest neutral, so white cards read against it.
    background: '#F2F2F2',
    // Cards and sheets sit a step up from the page.
    secondaryBackground: '#FFFFFF',
    tertiaryBackground: '#FFFFFF',
    groupedBackground: '#F2F2F2',
    // Raised tile (selected segmented pill, elevated bar).
    elevatedSurface: '#FFFFFF',
    label: '#1A1A1A',
    // #5A5A5A, not #5C5C5C: it keeps 6:1 on the #F2F2F2 page and the iOS #F2F2F7
    // sheet, the margin the play drawer's status lines are held to.
    secondaryLabel: '#5A5A5A',
    // 4.98:1 on the page, 4.63:1 on containers.low. Not on base or above.
    tertiaryLabel: '#686868',
    // M3 outline-variant.
    separator: 'rgba(0, 0, 0, 0.12)',
    // Neutral track for segmented controls and small fills.
    fill: 'rgba(0, 0, 0, 0.08)',
    // Interactive-accent foreground: brand violet, lifted in dark.
    accent: '#6D28D9',
  },
  dark: {
    background: '#0E0E0E',
    secondaryBackground: '#1E1E1E',
    tertiaryBackground: '#262626',
    groupedBackground: '#0E0E0E',
    elevatedSurface: '#262626',
    label: '#EDEDED',
    secondaryLabel: '#B0B0B0',
    // 5.15:1 on the card, 4.68:1 on containers.high. Not on level4 or highest.
    tertiaryLabel: '#8F8F8F',
    separator: 'rgba(255, 255, 255, 0.12)',
    fill: 'rgba(255, 255, 255, 0.10)',
    accent: '#A78BFA',
  },
} as const;

/**
 * The violet-tinted Material surfaces the app shipped before "Graphite", frozen for
 * the marketing renders (showcase, instructional and spray videos) so already-cut
 * footage and the frames drawn around it keep matching. Do not use in the app, and
 * do not retune: re-shoot the videos and move them to `materialSurfaces` instead.
 */
export const marketingSurfaces = {
  light: {
    background: '#F3EFFA',
    secondaryBackground: '#FFFFFF',
    tertiaryBackground: '#FFFFFF',
    groupedBackground: '#F3EFFA',
    elevatedSurface: '#FFFFFF',
    label: '#16111F',
    secondaryLabel: '#5B5563',
    tertiaryLabel: '#8E8898',
    separator: 'rgba(60, 55, 75, 0.18)',
    fill: 'rgba(109, 40, 217, 0.14)',
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

export type BrandColors = typeof brandColors;
export type MaterialSurfaces = typeof materialSurfaces;
export type MarketingSurfaces = typeof marketingSurfaces;
export type MaterialSurfaceKey = keyof typeof materialSurfaces.light;
