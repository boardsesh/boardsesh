// Design tokens for Boardsesh
// This file defines the design system used throughout the application

export const themeTokens = {
  // Brand colors - Neutral grey with subtle warm red accent
  colors: {
    primary: '#8C4A52', // Muted dusty rose - warm grey-red
    primaryHover: '#7A3F47', // Darker rose
    primaryActive: '#6B353D', // Deep dark rose
    secondary: '#6B7280', // Neutral grey for info/secondary
    success: '#6B9080', // Muted sage green
    successHover: '#5A7A6C', // Darker sage green
    successBg: '#EFF5F2',
    warning: '#C4943C', // Muted amber
    warningBg: '#FAF5EC',
    error: '#B8524C', // Muted brick red
    errorBg: '#F9EFEE',
    errorMuted: 'rgba(184, 82, 76, 0.18)', // Translucent error for non-destructive action buttons
    errorMutedHover: 'rgba(184, 82, 76, 0.28)',
    purple: '#9C27B0', // V11 brand purple — Mirror button + chart palette accent
    purpleHover: '#7B1FA2', // V12 — Mirror button hover
    amber: '#FBBF24', // For flash/benchmark badges
    pink: '#EC4899', // For finish holds in climb creation
    logoGreen: '#5fb27a', // Palette accent — used in OG/playlist/chart palettes (legacy name kept; not the route mark)
    logoRose: '#d65a4f', // Palette accent — used in OG/playlist/chart palettes (legacy name kept; not the brand coral)
  },

  // Warm text colours scoped to brand surfaces (landing hero, splash,
  // OG/social, App Store screenshots, marketing emails). Standard product
  // UI keeps the cool neutral scale — do not blanket-replace neutrals.
  text: {
    brandPrimary: '#f4f1ea',
    brandMuted: '#8a8780',
  },

  // Neutral palette
  neutral: {
    50: '#F9FAFB',
    100: '#F3F4F6',
    200: '#E5E7EB',
    300: '#D1D5DB',
    400: '#9CA3AF',
    500: '#6B7280',
    600: '#4B5563',
    700: '#374151',
    800: '#1F2937',
    900: '#111827',
  },

  // Semantic colors
  semantic: {
    selected: 'rgba(175, 45, 60, 0.28)', // Visible rose tint for selected state
    selectedHover: '#E8C8CC', // Darker rose tint for hover feedback
    selectedLight: 'rgba(175, 45, 60, 0.10)', // Very subtle rose highlight
    selectedBorder: '#8C4A52', // Matches primary
    background: '#F9FAFB',
    surface: '#FFFFFF',
    surfaceElevated: '#FFFFFF',
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

  // Border radius
  borderRadius: {
    none: 0,
    sm: 4,
    md: 8,
    lg: 12,
    xl: 16,
    full: 9999,
  },

  // Transitions
  transitions: {
    fast: '150ms ease',
    normal: '200ms ease',
    slow: '300ms ease',
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
    /** CSS height value for a spacer that prevents the bottom nav bar from covering content on mobile Safari.
     *  Accounts for nav height (~72px), iOS Safari 2dvh offset, and safe area inset. */
    bottomNavSpacer: 'calc(80px + var(--safe-area-inset-bottom))',
    /** Safe-area bottom inset. Resolves through --safe-area-inset-bottom defined on :root in index.css. */
    safeAreaBottom: 'var(--safe-area-inset-bottom)',
    /** Safe-area top inset. Resolves through --safe-area-inset-top defined on :root in index.css. */
    safeAreaTop: 'var(--safe-area-inset-top)',
  },
} as const;

// Dark mode overrides — only backgrounds, surfaces, text, neutrals, and status tints change.
// Brand colors (primary, success, error, warning, purple, amber, pink) stay the same.
export const darkTokens = {
  neutral: {
    50: '#121212',
    100: '#222222',
    200: '#333333',
    300: '#3A3A3A',
    400: '#6B7280',
    500: '#B3B3B3',
    600: '#D1D5DB',
    700: '#E5E7EB',
    800: '#F3F4F6',
    900: '#F9FAFB',
  },

  semantic: {
    selected: 'rgba(175, 45, 60, 0.22)',
    selectedHover: 'rgba(175, 45, 60, 0.30)',
    selectedLight: 'rgba(175, 45, 60, 0.12)',
    selectedBorder: '#8C4A52',
    background: '#0e0e10',
    surface: '#1A1A1A',
    surfaceElevated: '#282828',
    inputSurface: '#FFFFFF',
    surfaceOverlay: 'rgba(26, 26, 26, 0.95)',
    overlayLight: 'rgba(0, 0, 0, 0.4)',
    overlayDark: 'rgba(0, 0, 0, 0.7)',
  },

  statusBg: {
    success: 'rgba(107, 144, 128, 0.12)',
    error: 'rgba(184, 82, 76, 0.12)',
    warning: 'rgba(196, 148, 60, 0.12)',
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
