// Design tokens for Boardsesh — the "Velvet Send" design system (web).
//
// www sits on the app's "Graphite" palette: the same neutral page → card → elevated
// ladder, labels and outline the React Native app's Material variant uses, imported
// from @boardsesh/velvet-tokens so the two cannot drift. Violet is spent on action
// and state only: links and text actions (`primary`), the filled CTA (`primaryFill`),
// focus, and the opaque tonal container for a selected or current item. Web-only
// derived values (hover washes, `primaryHover`, overlays, status washes, neutral[300],
// the disabled text tier) live here.
//
// IMPORTANT: this file and `app/components/index.css` are two HAND-SYNCED sources —
// theme-config feeds MUI + direct `themeTokens.*` imports; index.css feeds CSS
// custom properties read by ~150 `.module.css` files. Every shared colour must be
// edited in BOTH. The parity test in `__tests__/` guards this.
//
// There is ONE scheme: dark. www is a marketing surface and the light/dark switch
// came out with the climbing UI (#4467), so these values ARE the dark values —
// `darkTokens` no longer exists and nothing branches on scheme.
//
// `primary` is the FOREGROUND violet (links, indicators, borders, focus) at
// #9784FF; `primaryFill` is the FILLED-surface violet (button bg + white text) at
// #7855FF. The two are NOT interchangeable and must never be collapsed into one:
// white on #9784FF is 2.97:1. The parity test fences this. The fill keeps a 3:1 edge
// on #262626 (3.27:1) but not on containers.highest #2E2E2E (2.94:1), so a filled
// CTA never sits above the elevated surface.

import { HOLD_STATE_MAP } from '@boardsesh/board-constants/hold-states';
import {
  blendOpaque,
  brandColorsDark,
  materialOutline,
  materialSurfaceContainers,
  materialSurfaces,
  materialTonalContainers,
  withAlpha,
} from '@boardsesh/velvet-tokens';

const graphite = materialSurfaces.dark;

// The Kilter Original role codes (12 start, 13 hand, 14 finish, 15 foot). The hand
// role is drawn in Boardsesh's own cyan, not the LED wire colour.
const kilterRoles = HOLD_STATE_MAP.kilter;
const graphiteContainers = materialSurfaceContainers.dark;
const graphiteTonal = materialTonalContainers.dark;

export const themeTokens = {
  // Brand colors — Velvet Send violet + mint spark
  colors: {
    primary: brandColorsDark.primary, // #9784FF — FOREGROUND violet (text, icons, links, borders, focus)
    primaryHover: '#B6AFFF', // Lighter step, 9.71:1 on the page
    primaryFill: brandColorsDark.primaryFill, // #7855FF — FILLED bg; white text clears 4.62:1
    primaryFillHover: '#5B22F2', // Darker than the fill so white text stays AA on hover (7.10:1)
    onPrimary: brandColorsDark.onPrimary, // #FFFFFF — text/icon on a primaryFill surface
    accent: brandColorsDark.accent, // #3EE6C1 — mint spark, FILL-ONLY, always pair with dark text
    onAccent: brandColorsDark.onAccent, // #16111F — dark text on accent (11.72:1)
    live: brandColorsDark.live, // #FBBF24 — "now on the wall / physically lit" status hue (own role, not warning)
    secondary: graphite.secondaryLabel, // #B0B0B0 — MUI palette.secondary
    info: graphite.secondaryLabel, // #B0B0B0 — help/guide accent (callout edge, help icon chips)
    infoTint: graphite.fill, // rgba(255,255,255,0.10) — low-key icon-chip bg (OnboardingCard 'help', homepage gym card)
    success: brandColorsDark.success, // #34D399
    // Kept from the light ramp deliberately: it feeds palette.success.dark, where a
    // hover DARKER than #34D399 is still the right direction. Retune with a designer,
    // not as a side effect of the scheme collapse.
    successHover: '#036B4D',
    successBg: 'rgba(52, 211, 153, 0.14)',
    warning: brandColorsDark.warning, // #FBBF24
    warningBg: 'rgba(251, 191, 36, 0.14)',
    error: brandColorsDark.error, // #F87171
    errorBg: 'rgba(248, 113, 113, 0.14)',
    errorMuted: 'rgba(248, 113, 113, 0.2)', // Translucent error for non-destructive action buttons
    errorMutedHover: 'rgba(248, 113, 113, 0.3)',
    purple: '#9C27B0', // V11 brand purple — Mirror button + chart palette accent (grade token)
    purpleHover: '#7B1FA2', // V12 — Mirror button hover
    amber: '#FBBF24', // Flash/benchmark badges + star ratings (data yellow, distinct from brand accent)
    pink: '#EC4899', // For finish holds in climb creation
    accentGreen: '#2DD4BF', // Teal — decorative playlist/OG palette (re-pulled to read with violet+amber)
    accentRose: '#FB7185', // Modern rose — decorative playlist/OG palette (re-pulled from warm coral)
  },

  // Text colours scoped to brand surfaces (landing hero, splash, OG/social, App Store
  // screenshots, marketing emails): the Graphite label and secondary label, so the hero
  // reads as the same product as the app. The `--bs-text-brand-*` CSS vars mirror
  // these. The `*Light` counterparts went with the light scheme — no brand surface on
  // www is light any more.
  //
  // `disabled` is MUI's text.disabled: the label at M3's 38% over the page (3.21:1,
  // exempt from AA as disabled text). Web-owned; the app has no disabled text tier.
  text: {
    brandPrimary: graphite.label,
    brandMuted: graphite.secondaryLabel,
    disabled: blendOpaque(graphite.label, graphite.background, 0.38), // #636363
  },

  // Neutral palette — Graphite greys, and READ IT DARKEST-FIRST: on a dark scheme
  // the ramp is inverted, so 50 is the darkest step and 900 the lightest.
  // 50–300 are surfaces (backgrounds/chips/borders/skeletons); 400–900 bear text.
  // The text steps collapse onto the app's three label tiers: 400 tertiary, 500–600
  // secondary, 700–900 label. White vs #EDEDED is 1.17:1, not a usable step.
  //
  // The numeric keys are kept on purpose. Renaming them to semantic names
  // (surface1 / text3) is the right end state, but it is 107 call sites of churn
  // and would bury the value change this file just made. Follow-up, not this PR.
  neutral: {
    50: graphiteContainers.base, // #1A1A1A
    100: graphiteContainers.high, // #262626
    200: graphiteContainers.highest, // #2E2E2E
    // Web-owned: white at 20% over the page. Decorative only (1.80:1 on the page).
    300: blendOpaque('#FFFFFF', graphite.background, 0.2), // #3E3E3E
    // Tertiary label: 4.68:1 on #262626. Not on 200 / containers.highest (4.20:1).
    400: graphite.tertiaryLabel, // #8F8F8F
    500: graphite.secondaryLabel, // #B0B0B0 — secondary text (6.26:1 on #2E2E2E, the worst case)
    600: graphite.secondaryLabel,
    700: graphite.label,
    800: graphite.label, // text.primary
    900: graphite.label, // label — max-contrast text (#EDEDED, 11.60:1 on #2E2E2E)
  },

  // Semantic colors — the surface ladder, the app's Graphite ladder. Depth on near-black
  // is a lighter grey, not a shadow: background → surface → surfaceElevated each step up
  // in lightness (card 1.16:1 on the page, elevated 1.10:1 on the card).
  semantic: {
    // The selected family is for a GENUINELY selected or current item only: the opaque
    // M3 tonal container, with `onSelected` ink on it (9.89:1). The foreground violet is
    // banned on it (4.28:1). Its edge is 1.52:1 on the page and 1.31:1 on the card, so a
    // selected toggle also carries a non-colour cue (a check). Hover washes, badge grounds
    // and decorative fills have their own roles below.
    selected: graphiteTonal.secondaryContainer, // #34276B
    // The ink at 8% over the container: M3's hover state layer, kept opaque (ink 8.05:1).
    selectedHover: blendOpaque(graphiteTonal.ink, graphiteTonal.secondaryContainer, 0.08), // #423677
    // The help jump chip's `aria-current`: a true current state, so the same container.
    selectedLight: graphiteTonal.secondaryContainer,
    selectedBorder: brandColorsDark.primary, // #9784FF — matches foreground primary
    // Ink on a selected or current item: the tonal container's ink (12.95:1 on the card).
    onSelected: graphiteTonal.ink, // #E1E0FF
    // MUI `action.selected`. Not a selection colour on www: MUI paints it under every
    // default filled <Chip>, a selected PaginationItem and the highlighted Autocomplete
    // option, so it stays a neutral fill (the same as `fill`), never violet.
    selectedRow: graphite.fill,
    // Hover wash on rows, chips and list links (MUI `action.hover`): the label at 8%,
    // M3's hover state layer. Not a selected state.
    hover: withAlpha(graphite.label, 0.08),
    // Hover wash on MUI text and outlined buttons: the same state layer as `hover`.
    // Its own name so a button retune cannot move every row hover.
    buttonHover: withAlpha(graphite.label, 0.08),
    // Decorative low-alpha grounds: badge and status-pill grounds, the build-plans dot
    // grid, diagram cells. Never a selected state. `fill` is the app's neutral fill.
    fillSubtle: withAlpha('#FFFFFF', 0.06),
    fill: graphite.fill, // rgba(255,255,255,0.10); the label on it over the card is 10.48:1
    fillStrong: withAlpha('#FFFFFF', 0.14),
    separator: graphite.separator, // rgba(255,255,255,0.12) — dividers/hairlines, 1.36–1.46:1
    // The 1px edge of an app capture or the hero video: a shade brighter than the
    // separator so an iOS capture's black screen never reads as a hole in the card.
    // Decorative, like the separator.
    captureFrame: withAlpha('#FFFFFF', 0.14),
    // The visual boundary of an INTERACTIVE thing (outlined buttons, chips, toggles,
    // pagination pills, floating surfaces): the M3 outline. Opaque on purpose so WCAG
    // 1.4.11's 3:1 floor is one fact rather than a per-backdrop guess: 5.59:1 on the page,
    // 4.83:1 on the card, 4.38:1 on surfaceElevated and 3.93:1 on neutral[200]
    // (containers.highest, the worst case). `separator` composites to ~1.4:1 and stays
    // decorative-only.
    controlBorder: materialOutline.dark, // #8A8A8A
    background: graphite.background, // #0E0E0E — the app's page; no seam into /app
    surface: graphite.secondaryBackground, // #1E1E1E — cards/sheets, the app card
    surfaceElevated: graphite.elevatedSurface, // #262626 — popups, menus, one step above the card
    inputSurface: graphite.elevatedSurface, // #262626 — fields sit one step above their card
    surfaceOverlay: withAlpha(graphite.secondaryBackground, 0.95), // Semi-transparent overlay (matches surface)
    overlayLight: 'rgba(0, 0, 0, 0.4)', // Light dark overlay for hover states
    overlayDark: 'rgba(0, 0, 0, 0.7)', // Dark overlay for text backgrounds
  },

  // Syntax highlighting colors (VS Code dark theme inspired)
  syntax: {
    keyword: '#569cd6',
    type: '#4ec9b0',
    string: '#ce9178',
    comment: '#6a9955',
    parameter: '#9cdcfe',
    default: '#d4d4d4',
  },

  // Shadows
  shadows: {
    xs: '0 1px 2px 0 rgba(0, 0, 0, 0.2)',
    sm: '0 1px 3px 0 rgba(0, 0, 0, 0.3), 0 1px 2px -1px rgba(0, 0, 0, 0.3)',
    md: '0 4px 6px -1px rgba(0, 0, 0, 0.3), 0 2px 4px -2px rgba(0, 0, 0, 0.3)',
    lg: '0 10px 15px -3px rgba(0, 0, 0, 0.3), 0 4px 6px -4px rgba(0, 0, 0, 0.3)',
    xl: '0 20px 25px -5px rgba(0, 0, 0, 0.3), 0 8px 10px -6px rgba(0, 0, 0, 0.3)',
    inner: 'inset 0 2px 4px 0 rgba(0, 0, 0, 0.15)',
  },

  // Typography
  typography: {
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
    fontSize: {
      xxs: 8,
      xs: 12,
      sm: 14,
      base: 16,
      lg: 18,
      xl: 20,
      '2xl': 24,
      '3xl': 30,
    },
    fontWeight: {
      normal: 400,
      medium: 500,
      semibold: 600,
      bold: 700,
      extrabold: 800,
    },
    lineHeight: {
      tight: 1.25,
      normal: 1.5,
      relaxed: 1.75,
    },
  },

  // Spacing scale
  spacing: {
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
  },

  // Border radius — Velvet (Liquid-Glass-leaning): `button` 10dp soft, `pill` for
  // capsules (chips/segmented/hero CTA), `lg` cards/sheets/dialogs.
  borderRadius: {
    none: 0,
    sm: 4,
    md: 8,
    button: 10,
    lg: 12,
    xl: 16,
    full: 9999,
  },

  // Transitions — Velvet motion: Glass durations with M3 'standard' easing for utility
  // transitions; 'emphasized' reserved for large-surface enter/exit (drawer/dialog).
  transitions: {
    fast: '150ms cubic-bezier(0.2, 0, 0, 1)',
    normal: '250ms cubic-bezier(0.2, 0, 0, 1)',
    slow: '350ms cubic-bezier(0.05, 0.7, 0.1, 1)',
  },

  // Motion primitives (raw values for sx/keyframes that need the curve or duration).
  motion: {
    duration: { fast: 150, normal: 250, slow: 350 },
    easing: {
      standard: 'cubic-bezier(0.2, 0, 0, 1)',
      emphasized: 'cubic-bezier(0.05, 0.7, 0.1, 1)',
    },
  },

  // Z-index scale
  /**
   * The small marketing layer that only www marketing pages read (board app
   * comparisons, home, gym marketing). Nothing in the app UI or the violet rules
   * changes. Mirrored as `--lit-*` and `--radius-tray` in index.css.
   */
  marketing: {
    /** Lit hold rings. Decorative glyphs only; see the `--lit-*` note in index.css. */
    lit: {
      start: kilterRoles[12].color,
      hand: kilterRoles[13].boardseshDisplayColor ?? kilterRoles[13].color,
      finish: kilterRoles[14].color,
      foot: kilterRoles[15].color,
    },
    radiusTray: 24,
  },

  zIndex: {
    dropdown: 1000,
    sticky: 1020,
    fixed: 1030,
    modal: 1040,
    popover: 1050,
    tooltip: 1060,
    animation: 1500,
  },

  // Opacity
  opacity: {
    subtle: 0.7, // De-emphasized but still interactive elements
    disabled: 0.5, // Disabled/unsupported state
  },

  // Layout constants
  layout: {
    /** CSS height value for a spacer that prevents the bottom nav bar from covering content on mobile Safari. */
    bottomNavSpacer: 'calc(80px + var(--safe-area-inset-bottom))',
    /** Safe-area bottom inset. Resolves through --safe-area-inset-bottom defined on :root in index.css. */
    safeAreaBottom: 'var(--safe-area-inset-bottom)',
    /** Safe-area top inset. Resolves through --safe-area-inset-top defined on :root in index.css. */
    safeAreaTop: 'var(--safe-area-inset-top)',
  },
} as const;

// Type exports for use in components
export type ThemeTokens = typeof themeTokens;
export type ColorTokens = typeof themeTokens.colors;
export type NeutralTokens = typeof themeTokens.neutral;
export type SyntaxTokens = typeof themeTokens.syntax;
