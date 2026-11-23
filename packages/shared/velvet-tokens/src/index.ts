/**
 * @boardsesh/velvet-tokens — the canonical "Velvet Send" brand palette, surface
 * anchors, and colour-math helpers, shared by the web app (MUI + CSS vars) and the
 * React Native app (theme provider). This is the single source of truth that keeps
 * the violet identity in sync across platforms.
 *
 * Pure TS: no react-native, no MUI, no DOM. Platform-specific resolution
 * (iOS PlatformColor, Android fallbacks, Liquid-Glass tint) stays in each app and
 * computes on top of these anchors.
 */

// Dev-only warning gate. `process.env.NODE_ENV` is inlined by Next at build and is
// populated by Metro/React Native at runtime, so this works on both platforms
// without depending on the RN-only `__DEV__` global.
const isDev = process.env.NODE_ENV !== 'production';

/**
 * Brand colors — "Velvet Send" system. The violet is "Ultraviolet": OKLCH hue
 * ~287. Stock Tailwind violet, the one it replaced, read bland; Ultraviolet sits
 * clear of the V13–V16 grade purples and the blue hand-hold LEDs on the board.
 *
 * Accent system rules:
 * 1. Tint and fill share one hue (~287) and differ only in lightness.
 * 2. A selection wash mixes from the FILL, never the tint: fill at 0.13 in light,
 *    fill at 0.20 in dark (`SELECTION_WASH_ALPHA` in the mobile app).
 * 3. Every dark violet sits on the sRGB gamut edge (blue channel at FF): the most
 *    chroma the screen has at its lightness, so dark mode lifts the violet and
 *    never greys it. (This replaced "dark fill chroma ≥ light fill chroma", which
 *    no fill light enough for a 3:1 edge on #2C2C2E can meet: sRGB tops out at
 *    C 0.239 there, against the light fill's 0.271.)
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
 *   player's wall button: `primaryFill` at 20%). One step deeper than `primary`
 *   in light and one step lighter in dark, same hue, so the label clears 4.5:1
 *   on the wash over every sheet.
 * - `onPrimary`: text/icon colour sitting on `primaryFill`.
 * - `accent`: the mint spark for highlights — FILL or STROKE only (outlines, dots,
 *   a fill under `onAccent` ink), never text: the light mint is 3.32:1 on white. It
 *   differs per scheme (#0F9F86 light, #3EE6C1 dark). Mint replaced the amber
 *   spark, which sat between the V2/V3 grade oranges; mint (OKLCH hue ~175) sits
 *   about 33° from the green start-hold LED and 25° from the cyan hand-hold LED,
 *   and pairs with Ultraviolet.
 * - `onAccent`: the ink that pairs with `accent`. The same #16111F in both schemes:
 *   5.58:1 on the light mint, 11.72:1 on the dark one.
 * - `live`: the "this climb is physically lit / now on the wall" status hue. A
 *   dedicated role (not `warning`) so a future warning retune can't silently shift
 *   the board-presence affordance. Resolves to the warm amber per scheme. It is not
 *   the spark: "lit" stays amber whatever the spark is.
 * - `onLive`: text/icon on a `live` fill: white on the light amber (5.02:1), the
 *   dark ink on the dark amber (11.09:1). The lit wall button, the bar bulb and the
 *   Material wall pill all draw it.
 * - `historyFill`: the FILLED slate bar behind the wall kiosk's "viewing history"
 *   state — a positive, distinct-from-amber signal, not an absence-of-amber wash.
 *   White text clears AA on both schemes.
 *
 * Contrast (WCAG, light): #5B22F2 is 7.10:1 on #FFFFFF and 6.37:1 on #F2F2F7, and
 * white on it is 7.10:1. `primaryStrong` #4A16CF is 5.81:1 on the 20% fill wash
 * over #F2F2F7 (6.43:1 over white). `onAccent` on the mint `accent` = 5.58:1.
 */
export const brandColors = {
  tint: '#5B22F2',
  primary: '#5B22F2',
  primaryFill: '#5B22F2',
  primaryStrong: '#4A16CF',
  onPrimary: '#FFFFFF',
  accent: '#0F9F86',
  onAccent: '#16111F',
  success: '#047857',
  warning: '#B45309',
  error: '#C81E1E',
  live: '#B45309',
  onLive: '#FFFFFF',
  historyFill: '#475569',
} as const;

/**
 * Dark-scheme brand overrides. The light violet is too low-contrast as a
 * foreground on near-black, so the tint lifts to #9784FF; filled buttons use a
 * brighter #7855FF, light enough that the fill's own edge clears 3:1 on every dark
 * card (3.76:1 on #1A1A1A, 3.68:1 on #1C1C1E, 3.01:1 on #2C2C2E) and dark enough
 * that white text still clears AA (4.62:1). Semantic tones brighten for legibility
 * on dark surfaces. Same keys as `brandColors`.
 *
 * Contrast (WCAG, dark): #9784FF tint 7.06:1 on #000000, 5.72:1 on #1C1C1E and
 * 4.69:1 on the iOS elevated grouped card (#2C2C2E) — legible for text and
 * controls drawn on a card. #7855FF is a FILL only: at 3.01:1 on #2C2C2E it is
 * under the 4.5:1 text needs, so never use it as a control tint or text on a dark
 * card. `primaryStrong` #A294FF is the tint's hue lifted until it clears 4.5:1 on
 * the 20% fill wash over #2C2C2E (4.52:1; 5.45:1 over #1C1C1E).
 */
export const brandColorsDark = {
  tint: '#9784FF',
  primary: '#9784FF',
  primaryFill: '#7855FF',
  primaryStrong: '#A294FF',
  onPrimary: '#FFFFFF',
  // Lifted for dark grounds: 10.77:1 on #1C1C1E, and `onAccent` on it 11.72:1.
  accent: '#3EE6C1',
  onAccent: '#16111F',
  success: '#34D399',
  warning: '#FBBF24',
  error: '#F87171',
  live: '#FBBF24',
  onLive: '#16111F',
  historyFill: '#64748B',
} as const;

/**
 * The brand swatches the app itself offered for a saved colour (the mobile playlist
 * form's first two swatches) before a retune, mapped to the token that replaced each.
 * Keyed by uppercase `#RRGGBB`. Readers map a saved colour through `currentBrandColor`
 * so an old playlist shows today's brand instead of a colour the app no longer uses.
 *
 * Only values the app offered as swatches belong here. Other retired brand hexes
 * (#7C3AED, #A78BFA, #5B21B6) were never swatches; they are stock Tailwind values a
 * climber or Aurora could have picked on purpose, so they stay as saved.
 */
export const RETIRED_BRAND_COLORS: Readonly<Record<string, string>> = {
  // The Velvet violet swatch, before Ultraviolet.
  '#6D28D9': brandColors.primaryFill,
  // The amber spark swatch, before mint.
  '#FF8A3D': brandColors.accent,
};

/**
 * The current brand colour for a saved colour: a retired brand hex maps to the token
 * that replaced it (case-insensitive); any other colour comes back unchanged.
 */
export function currentBrandColor(color: string): string {
  return RETIRED_BRAND_COLORS[color.toUpperCase()] ?? color;
}

/**
 * Material 3 surfaces for the Material UI variant of the React Native app (Android,
 * the Expo browser app, and a legacy saved choice on iOS), keyed by colour scheme.
 *
 * "Graphite": every neutral here is pure grey (R = G = B, chroma 0). Violet is kept
 * for action and state only: `accent`, the brand fills, and the opaque M3 tonal
 * containers (`materialTonalContainers`, below). The container ladder
 * (`materialSurfaceContainers`) and the control outline (`materialOutline`) sit
 * below too. Labels are opaque so text contrast clears WCAG AA;
 * `material-theme-contrast.test.ts` in the mobile app pins every pairing.
 *
 * Contrast (WCAG): dark label #EDEDED 16.5:1 on the #0E0E0E page and 14.2:1 on the
 * #1E1E1E card; secondary #B0B0B0 6.2:1 or more on every container step; tertiary
 * #8F8F8F 5.15:1 on the card, so it stays off the two highest container steps.
 * Light label #1A1A1A 12.3:1 or more; secondary #5A5A5A 4.89:1 or more; tertiary
 * #686868 4.98:1 on the #F2F2F2 page, so it stays on page, card, lowest and low.
 *
 * www reads the dark half too: `packages/web/app/theme/theme-config.ts` takes its page →
 * card → elevated ladder, labels, separator, fill and the selected container from here
 * (with `materialSurfaceContainers`, `materialTonalContainers` and `materialOutline`), so
 * www and the Expo browser app at /app sit on one Graphite ground.
 * `velvet-tokens-parity.test.ts` in the web app asserts the web ladder IS these anchors;
 * a retune here moves both apps.
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
    accent: '#5B22F2',
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
    accent: '#9784FF',
  },
} as const;

/**
 * M3 surface-container tones for the Material variant, hand-set per scheme.
 *
 * "Graphite": pure greys (R = G = B), so depth reads by tone with no violet cast.
 * Dark rises from the #0E0E0E page in steps of about 1.5 to 4 L*; the #1E1E1E card
 * (`secondaryBackground`) sits between `base` and `high`. Light falls from the
 * #F2F2F2 page, below the white card. Each step is one Paper elevation level:
 * `low`↔level1, `base`↔level2, `high`↔level3, `level4`↔level4, `highest`↔level5.
 *
 * `base` is the MiniPlayer ground. It stays at #1A1A1A in dark so the filled
 * #7855FF play button keeps a 3:1 edge on it (3.76:1); a lighter base erodes it.
 * `material-theme-contrast.test.ts` in the mobile app pins every label, outline and
 * accent pairing.
 */
export const materialSurfaceContainers = {
  light: {
    lowest: '#EEEEEE',
    low: '#EAEAEA',
    base: '#E4E4E4',
    high: '#DFDFDF',
    level4: '#DCDCDC',
    highest: '#D9D9D9',
  },
  dark: {
    lowest: '#121212',
    low: '#161616',
    base: '#1A1A1A',
    high: '#262626',
    level4: '#2A2A2A',
    highest: '#2E2E2E',
  },
} as const;

/**
 * Opaque M3 tonal containers, the one place Material keeps a violet surface: the
 * selected or current state (nav pill, selected chip, Stepper, tonal button,
 * connected MiniPlayer). Opaque so they read the same over any ground; a
 * translucent wash took the colour of whatever sat under it.
 *
 * On the brand's Ultraviolet hue: each is M3's baseline container moved to OKLCH
 * hue 287 at the same lightness and chroma (sRGB caps the lightest at C 0.042).
 * The baseline sat at 293–304, a pinker violet than the tint beside it.
 *
 * Contrast (WCAG): ink #21005D on #E1E0FF 13.3:1 and on #DEDDFC 13.0:1; ink #E1E0FF
 * on #483A8E 7.18:1 and on #34276B 9.89:1.
 */
export const materialTonalContainers = {
  light: { primaryContainer: '#E1E0FF', secondaryContainer: '#DEDDFC', ink: '#21005D' },
  dark: { primaryContainer: '#483A8E', secondaryContainer: '#34276B', ink: '#E1E0FF' },
} as const;

/**
 * The M3 `outline` role: the opaque control-boundary grey (text fields, outlined
 * buttons). A fixed mid grey that clears 3:1 on every Graphite container step.
 *
 * Contrast (WCAG): dark #8A8A8A 5.59:1 on #0E0E0E, 4.83:1 on #1E1E1E, 4.38:1 on
 * #262626 and 3.93:1 on #2E2E2E (the highest step); light #7A7A7A 3.04:1 on #D9D9D9
 * (the highest step).
 */
export const materialOutline = { light: '#7A7A7A', dark: '#8A8A8A' } as const;

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
/** One scheme's container table, widened to plain strings so a fixture can supply its own. */
export type MaterialSurfaceContainers = Record<keyof typeof materialSurfaceContainers.light, string>;
