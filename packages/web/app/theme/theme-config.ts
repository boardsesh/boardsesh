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
// The brand is SCHEME-AWARE: `primary` is the FOREGROUND violet (links, indicators,
// borders, focus); `primaryFill` is the FILLED-surface violet (button bg + white
// text). They are equal in light (#6D28D9) but diverge in dark — foreground lifts to
// #A78BFA for legibility on near-black, fill stays #7C3AED so white text clears AA.

import { brandColors, brandColorsDark, materialSurfaces } from '@boardsesh/velvet-tokens';

const lightSurfaces = materialSurfaces.light;
const darkSurfaces = materialSurfaces.dark;

export const themeTokens = {
  // Brand colors — Velvet Send violet + amber
  colors: {
    primary: brandColors.primary, // #6D28D9 — FOREGROUND violet (text, icons, links, borders, focus)
    primaryHover: '#5B21B6', // violet-800
    primaryActive: '#4C1D95', // violet-900
    primaryFill: brandColors.primaryFill, // #6D28D9 — FILLED bg (white text); diverges in dark
    primaryFillHover: '#5B21B6',
    onPrimary: brandColors.onPrimary, // #FFFFFF — text/icon on a primaryFill surface
    accent: brandColors.accent, // #FF8A3D — warm amber spark, FILL-ONLY, always pair with dark text
    onAccent: lightSurfaces.label, // #16111F — dark text on accent (8.95:1)
    secondary: '#5B5563', // violet-grey for info/secondary
    info: '#5E6491', // Violet-slate — help/guide accent, re-pulled into the violet family
    success: brandColors.success, // #047857
    successHover: '#036B4D',
    successBg: '#E7F4EE',
    warning: '#A04A08', // Nudged up from Velvet #B45309 so warning text clears AA on the tinted bg
    warningBg: '#FBF0E3',
    error: brandColors.error, // #C81E1E
    errorBg: '#FBE9E9',
    errorMuted: 'rgba(200, 30, 30, 0.18)', // Translucent error for non-destructive action buttons
    errorMutedHover: 'rgba(200, 30, 30, 0.28)',
    purple: '#9C27B0', // V11 brand purple — Mirror button + chart palette accent (grade token)
    purpleHover: '#7B1FA2', // V12 — Mirror button hover
    amber: '#FBBF24', // Flash/benchmark badges + star ratings (data yellow, distinct from brand accent)
    pink: '#EC4899', // For finish holds in climb creation
    accentGreen: '#0D9488', // Teal — decorative playlist/OG palette (re-pulled to read with violet+amber)
    accentRose: '#F43F5E', // Modern rose — decorative playlist/OG palette (re-pulled from warm coral)
  },

  // Text colours scoped to brand surfaces (landing hero, splash, OG/social, App Store
  // screenshots, marketing emails). Retuned from the old warm cream to cool Velvet
  // label values so the hero reads as the same product as the violet chrome.
  // `*Light` are the values for light surfaces (violet-black); the unsuffixed pair is
  // for dark brand surfaces (cool near-white). The `--bs-text-brand-*` CSS vars mirror.
  text: {
    brandPrimary: '#f5f2fb',
    brandMuted: '#a9a2b6',
    brandPrimaryLight: '#16111f',
    brandMutedLight: '#5b5563',
  },

  // Neutral palette — violet-tinted greys (low chroma in the mids, decoupled from the
  // surface ladder so dividers/greys read neutral-with-a-whisper, not plum). Anchored
  // on the Velvet label/secondaryLabel/tertiaryLabel values.
  neutral: {
    50: '#F8F6FB',
    100: '#F1EEF7',
    200: '#E5E1EE',
    300: '#CBC5D6',
    400: '#8E8898', // tertiaryLabel — disabled/decorative tier (AA-exempt; body text re-points to 500)
    500: '#5B5563', // secondaryLabel — secondary text (6.3:1 on bg)
    600: '#494551',
    700: '#37333F',
    800: '#26222D', // text.primary
    900: '#16111F', // label — max-contrast text
  },

  // Semantic colors
  semantic: {
    selected: 'rgba(109, 40, 217, 0.14)', // Violet tint for selected state
    selectedHover: 'rgba(109, 40, 217, 0.22)',
    selectedLight: 'rgba(109, 40, 217, 0.08)', // Very subtle violet highlight
    selectedBorder: brandColors.primary, // #6D28D9 — matches foreground primary
    separator: lightSurfaces.separator, // rgba(60,55,75,0.18) — dividers/hairlines (decoupled from neutral-200)
    background: lightSurfaces.background, // #F3EFFA — violet-tinted page base
    surface: lightSurfaces.secondaryBackground, // #FFFFFF — cards/sheets
    surfaceElevated: lightSurfaces.elevatedSurface, // #FFFFFF
    surfaceOverlay: 'rgba(255, 255, 255, 0.95)', // Semi-transparent overlay
    overlayLight: 'rgba(0, 0, 0, 0.3)', // Light dark overlay for hover states
    overlayDark: 'rgba(0, 0, 0, 0.6)', // Dark overlay for text backgrounds
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
    xs: '0 1px 2px 0 rgba(0, 0, 0, 0.05)',
    sm: '0 1px 3px 0 rgba(0, 0, 0, 0.1), 0 1px 2px -1px rgba(0, 0, 0, 0.1)',
    md: '0 4px 6px -1px rgba(0, 0, 0, 0.1), 0 2px 4px -2px rgba(0, 0, 0, 0.1)',
    lg: '0 10px 15px -3px rgba(0, 0, 0, 0.1), 0 4px 6px -4px rgba(0, 0, 0, 0.1)',
    xl: '0 20px 25px -5px rgba(0, 0, 0, 0.1), 0 8px 10px -6px rgba(0, 0, 0, 0.1)',
    inner: 'inset 0 2px 4px 0 rgba(0, 0, 0, 0.05)',
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

  // Badge sizing — applied via sx={{ '& .MuiBadge-badge': themeTokens.badge.small }}
  badge: {
    small: { fontSize: 10, height: 16, minWidth: 16 },
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

// Dark mode overrides. Brand is now SCHEME-AWARE, so darkTokens carries a `colors`
// block (the foreground violet lifts, the fill stays dark, status tones brighten).
// Backgrounds, surfaces, neutrals, selected tints, separator, and status backgrounds
// also change. Everything else inherits from themeTokens.
export const darkTokens = {
  colors: {
    primary: brandColorsDark.primary, // #A78BFA — lifted FOREGROUND
    primaryHover: '#C4B5FD',
    primaryActive: '#8B5CF6',
    primaryFill: brandColorsDark.primaryFill, // #7C3AED — FILL (white text clears 5.70:1)
    primaryFillHover: '#6D28D9', // Darker than the fill so white text stays AA on hover
    secondary: '#A9A2B6',
    info: '#A5ABD6', // lifted violet-slate
    success: brandColorsDark.success, // #34D399
    warning: brandColorsDark.warning, // #FBBF24
    error: brandColorsDark.error, // #F87171
    errorMuted: 'rgba(248, 113, 113, 0.2)', // lighter red wash for non-destructive buttons on dark
    errorMutedHover: 'rgba(248, 113, 113, 0.3)',
    accentGreen: '#2DD4BF',
    accentRose: '#FB7185',
  },

  neutral: {
    50: '#1A1622',
    100: '#241F2C',
    200: '#322C3D',
    300: '#423C4E',
    400: '#6E687C', // tertiaryLabel (disabled/decorative)
    500: '#A9A2B6', // secondaryLabel — secondary text (6.75:1 on surface)
    600: '#C9C3D4',
    700: '#E0DBEA',
    800: '#EEEAF5', // text.primary
    900: '#F5F2FB', // label — max-contrast text
  },

  semantic: {
    selected: 'rgba(199, 184, 232, 0.16)',
    selectedHover: 'rgba(199, 184, 232, 0.24)',
    selectedLight: 'rgba(199, 184, 232, 0.10)',
    selectedBorder: brandColorsDark.primary, // #A78BFA
    separator: darkSurfaces.separator, // rgba(180,168,205,0.18)
    background: darkSurfaces.background, // #15101E
    surface: darkSurfaces.secondaryBackground, // #221A33
    surfaceElevated: darkSurfaces.elevatedSurface, // #2A2142
    inputSurface: '#FFFFFF', // Intentional white inputs in dark mode (contrast) — do not change
    surfaceOverlay: 'rgba(34, 26, 51, 0.95)',
    overlayLight: 'rgba(0, 0, 0, 0.4)',
    overlayDark: 'rgba(0, 0, 0, 0.7)',
  },

  statusBg: {
    success: 'rgba(52, 211, 153, 0.14)',
    error: 'rgba(248, 113, 113, 0.14)',
    warning: 'rgba(251, 191, 36, 0.14)',
  },

  shadows: {
    xs: '0 1px 2px 0 rgba(0, 0, 0, 0.2)',
    sm: '0 1px 3px 0 rgba(0, 0, 0, 0.3), 0 1px 2px -1px rgba(0, 0, 0, 0.3)',
    md: '0 4px 6px -1px rgba(0, 0, 0, 0.3), 0 2px 4px -2px rgba(0, 0, 0, 0.3)',
    lg: '0 10px 15px -3px rgba(0, 0, 0, 0.3), 0 4px 6px -4px rgba(0, 0, 0, 0.3)',
    xl: '0 20px 25px -5px rgba(0, 0, 0, 0.3), 0 8px 10px -6px rgba(0, 0, 0, 0.3)',
    inner: 'inset 0 2px 4px 0 rgba(0, 0, 0, 0.15)',
  },
} as const;

// Type exports for use in components
export type ThemeTokens = typeof themeTokens;
export type ColorTokens = typeof themeTokens.colors;
export type NeutralTokens = typeof themeTokens.neutral;
export type SyntaxTokens = typeof themeTokens.syntax;
export type DarkTokens = typeof darkTokens;
