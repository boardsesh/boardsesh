// Design tokens for Boardsesh — the "Velvet Send" design system (web).
//
// Brand/surface anchors are imported from @boardsesh/velvet-tokens so web and the
// React Native app share one source of truth for the violet identity. Web-specific
// derived values (the neutral ramp, hover/active tones, status backgrounds, selected
// tints) live here.
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
// #A78BFA; `primaryFill` is the FILLED-surface violet (button bg + white text) at
// #7C3AED. The two are NOT interchangeable and must never be collapsed into one:
// white on #A78BFA is 2.5:1. The parity test fences this.
//
// The handful of values web still needs for a LIGHT surface — the Satori OG cards
// that render on white — live in `printSurfaceTokens` at the bottom of this file.

import { brandColorsDark } from '@boardsesh/velvet-tokens';

// Only the BRAND palette is shared with mobile. Web tunes its own surface + neutral
// ramp — richer/more violet than the shared Material surfaces, so the velvet permeates
// the cards and greys instead of reading as white + neutral grey. These are literals
// below; the parity test keeps them in sync with index.css.

export const themeTokens = {
  // Brand colors — Velvet Send violet + amber
  colors: {
    primary: brandColorsDark.primary, // #A78BFA — FOREGROUND violet (text, icons, links, borders, focus)
    primaryHover: '#C4B5FD',
    primaryActive: '#8B5CF6',
    primaryFill: brandColorsDark.primaryFill, // #7C3AED — FILLED bg; white text clears 5.70:1
    primaryFillHover: '#6D28D9', // Darker than the fill so white text stays AA on hover
    onPrimary: brandColorsDark.onPrimary, // #FFFFFF — text/icon on a primaryFill surface
    accent: brandColorsDark.accent, // #FF8A3D — warm amber spark, FILL-ONLY, always pair with dark text
    onAccent: brandColorsDark.onAccent, // #16111F — dark text on accent (8.95:1)
    live: brandColorsDark.live, // #FBBF24 — "now on the wall / physically lit" status hue (own role, not warning)
    secondary: '#A9A2B6', // violet-grey for info/secondary
    info: '#A5ABD6', // Lifted violet-slate — help/guide accent
    infoTint: 'rgba(94, 100, 145, 0.12)', // 12%-alpha `info` — shared low-key icon-chip bg (OnboardingCard 'help', homepage gym card)
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
  // screenshots, marketing emails). Retuned from the old warm cream to cool Velvet
  // label values so the hero reads as the same product as the violet chrome.
  // The `--bs-text-brand-*` CSS vars mirror these. The `*Light` counterparts went
  // with the light scheme — no brand surface on www is light any more.
  text: {
    brandPrimary: '#f5f2fb',
    brandMuted: '#a9a2b6',
  },

  // Neutral palette — violet-tinted greys, and READ IT DARKEST-FIRST: on a dark
  // scheme the ramp is inverted, so 50 is the darkest step and 900 the lightest.
  // 50–300 are surfaces (backgrounds/chips/borders/skeletons); 400–900 bear text.
  //
  // The numeric keys are kept on purpose. Renaming them to semantic names
  // (surface1 / text3) is the right end state, but it is 107 call sites of churn
  // and would bury the value change this file just made. Follow-up, not this PR.
  neutral: {
    50: '#1E1434',
    100: '#291C43',
    200: '#37294B',
    300: '#483B5C',
    400: '#6F6882', // disabled/decorative tier (AA-exempt; body text re-points to 500)
    500: '#ACA5BD', // secondary text (6.8:1 on card)
    600: '#C3BCD3',
    700: '#D7D1E3',
    800: '#E7E2F0', // text.primary
    900: '#F3EFFA', // label — max-contrast text
  },

  // Semantic colors — the surface ladder. Depth on near-black is a LIGHTER violet,
  // not a shadow: background → surface → surfaceElevated each step up in lightness.
  semantic: {
    selected: 'rgba(199, 184, 232, 0.16)', // Violet tint for selected state
    selectedHover: 'rgba(199, 184, 232, 0.24)',
    selectedLight: 'rgba(199, 184, 232, 0.10)', // Very subtle violet highlight
    selectedBorder: brandColorsDark.primary, // #A78BFA — matches foreground primary
    separator: 'rgba(185, 170, 215, 0.2)', // dividers/hairlines (decoupled from neutral-200)
    background: '#110A20', // deeper violet near-black (richer than a generic dark theme)
    surface: '#251B3A', // cards/sheets — richer violet
    surfaceElevated: '#2F234A', // elevated layers pop one step brighter than the card
    inputSurface: '#2F234A', // input fields ride the elevated dark surface (violet focus ring, not white)
    surfaceOverlay: 'rgba(37, 27, 58, 0.95)', // Semi-transparent overlay (matches surface)
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

// The only LIGHT-surface values web still ships.
//
// Three OG cards — profile, setter, playlist — are Satori-rendered onto a white
// ground (`background: '#FFFFFF'`), because a social unfurl sits in whatever
// chrome X, Discord or iMessage gives it. They are not part of the app's theme
// and they never were: they just happened to read `themeTokens` back when
// `themeTokens` was the light set.
//
// Naming them separately is what lets `themeTokens` be repointed at the dark
// values without turning every shared profile link into near-white text on a
// white card. Nothing catches that: all three route tests mock this module.
//
// NOT a light theme. Do not import this into a product component — if you want
// a colour on an app surface, you want `themeTokens`.
export const printSurfaceTokens = {
  neutral: {
    50: '#EBE2F9',
    100: '#DED2F3',
    200: '#CBBCEA',
    300: '#AD9ECC',
    400: '#7B7591',
    500: '#595464',
    600: '#48415A',
    700: '#373042',
    800: '#262030',
    900: '#181221',
  },

  // The foreground violet that reads on white (7.10:1). The dark-surface
  // foreground (#A78BFA) does not — it is 1.9:1 on white.
  primary: '#6D28D9',
} as const;

// Type exports for use in components
export type ThemeTokens = typeof themeTokens;
export type ColorTokens = typeof themeTokens.colors;
export type NeutralTokens = typeof themeTokens.neutral;
export type SyntaxTokens = typeof themeTokens.syntax;
export type PrintSurfaceTokens = typeof printSurfaceTokens;
