import { createTheme, type ThemeOptions, type Components, type Theme } from '@mui/material/styles';
import { themeTokens, darkTokens } from './theme-config';

// Velvet Send adds two brand channels MUI doesn't ship by default:
// - `primaryFill`: the FILLED-surface violet (button bg + white text). Kept separate
//   from `primary` (the FOREGROUND violet that MUI reads via palette.primary.main for
//   links, text/outlined buttons, and selection controls) because in dark mode the
//   two diverge — foreground #A78BFA vs fill #7C3AED.
// - `accent`: the amber spark (#FF8A3D), fill-only with dark text.
declare module '@mui/material/styles' {
  interface Palette {
    primaryFill: Palette['primary'];
    accent: Palette['primary'];
  }
  interface PaletteOptions {
    primaryFill?: PaletteOptions['primary'];
    accent?: PaletteOptions['primary'];
  }
}
declare module '@mui/material/Button' {
  interface ButtonPropsColorOverrides {
    primaryFill: true;
    accent: true;
  }
}
declare module '@mui/material/Chip' {
  interface ChipPropsColorOverrides {
    primaryFill: true;
    accent: true;
  }
}
declare module '@mui/material/Fab' {
  interface FabPropsColorOverrides {
    primaryFill: true;
    accent: true;
  }
}
// Note: `accent` is deliberately NOT exposed on SvgIcon. Accent is a FILL colour with
// dark text (Button/Chip/Fab); as an icon FOREGROUND the amber #FF8A3D is only ~2.2:1
// on the page and invites an inaccessible misuse. Icons must use a foreground role.
declare module '@mui/material/SvgIcon' {
  interface SvgIconPropsColorOverrides {
    primaryFill: true;
  }
}

// Shared component overrides used by both light and dark themes. Anything that reads
// the brand colour uses a `({ theme }) =>` callback so it picks up the scheme-aware
// palette (foreground in light vs dark); raw `themeTokens.*` is only for values that
// are intentionally scheme-invariant.
const sharedComponents: Components<Theme> = {
  // Keyboard focus ring for every ButtonBase-derived control (Button, IconButton, Tab,
  // MenuItem, ListItemButton, …). MUI ships `outline: 0` on ButtonBase root and the
  // branch's bare `:focus-visible` CSS rule in index.css loses the cascade to emotion
  // (and disableElevation strips the focus shadow), so keyboard users would get no
  // visible focus indicator — a WCAG 2.4.7 failure. Emit the outline at the component
  // layer so emotion carries it. index.css keeps the bare rule for non-MUI elements.
  MuiButtonBase: {
    styleOverrides: {
      root: {
        '&:focus-visible, &.Mui-focusVisible': {
          outline: '2px solid var(--color-primary)',
          outlineOffset: '2px',
        },
      },
    },
  },
  MuiButton: {
    styleOverrides: {
      root: {
        borderRadius: themeTokens.borderRadius.button,
        fontWeight: themeTokens.typography.fontWeight.medium,
        textTransform: 'none' as const,
        // Velvet hover is a background TINT, never a lift. Contained variants carry
        // their own fill-hover (see containedPrimary); text/outlined get the violet
        // selected wash. No transform/shadow here — nothing to gate behind a hover
        // media query on this element.
        '&:not(:disabled):not(.MuiButton-contained):hover': {
          backgroundColor: 'var(--semantic-selected-hover)',
        },
      },
      // Contained PRIMARY buttons render the FILL violet (white text), not the
      // foreground that palette.primary.main now carries. Set the v7 variant vars
      // plus a direct fallback so both code paths resolve to the fill.
      containedPrimary: ({ theme }) => ({
        '--variant-containedBg': theme.palette.primaryFill.main,
        '--variant-containedColor': theme.palette.primaryFill.contrastText,
        '--variant-containedHoverBg': theme.palette.primaryFill.dark,
        backgroundColor: theme.palette.primaryFill.main,
        color: theme.palette.primaryFill.contrastText,
        '&:hover': {
          backgroundColor: theme.palette.primaryFill.dark,
        },
      }),
      sizeMedium: {
        height: 40,
        padding: `0 ${themeTokens.spacing[4]}px`,
      },
      sizeSmall: {
        height: 32,
      },
      sizeLarge: {
        height: 48,
      },
    },
    defaultProps: {
      disableElevation: true,
    },
  },
  MuiFab: {
    styleOverrides: {
      primary: ({ theme }) => ({
        backgroundColor: theme.palette.primaryFill.main,
        color: theme.palette.primaryFill.contrastText,
        '&:hover': {
          backgroundColor: theme.palette.primaryFill.dark,
        },
      }),
    },
  },
  MuiCard: {
    styleOverrides: {
      root: {
        borderRadius: themeTokens.borderRadius.lg,
        boxShadow: 'var(--shadow-sm)',
        transition:
          'box-shadow var(--motion-normal) var(--ease-standard), transform var(--motion-normal) var(--ease-standard)',
        userSelect: 'none' as const,
        // Only deepen the shadow on real hover-capable pointers, so touch devices don't
        // strand the elevated shadow after a tap.
        '@media (hover: hover) and (pointer: fine)': {
          '&:hover': {
            boxShadow: 'var(--shadow-md)',
          },
        },
      },
    },
  },
  MuiTextField: {
    styleOverrides: {
      root: {
        '& .MuiOutlinedInput-root': {
          borderRadius: themeTokens.borderRadius.button,
        },
      },
    },
    defaultProps: {
      variant: 'outlined' as const,
      size: 'small',
    },
  },
  // Every MUI input renders at 16px so iOS Safari never zooms the viewport on focus.
  // Replaces the old max-width:768px `!important` media guard in index.css (which missed
  // iPads and any wider input). Applies to all input variants via the shared base.
  MuiInputBase: {
    styleOverrides: {
      input: ({ theme }) => ({
        fontSize: 16,
        // Single source of truth for field text — the same var the autofill guard uses,
        // so palette drift can't desync typed vs autofilled text.
        color: 'var(--input-text)',
        // A direct rule on the input beats colour inherited from the disabled wrapper,
        // so the disabled tier must be restated here (WebKit needs text-fill-color too).
        '&.Mui-disabled': {
          color: theme.palette.text.disabled,
          WebkitTextFillColor: theme.palette.text.disabled,
        },
        '&::placeholder': {
          color: 'var(--input-placeholder)',
          opacity: 1,
        },
      }),
    },
  },
  // Input surface + borders ride the scheme-aware `--input-*` CSS vars (light: white field,
  // #7B7591 border; dark: elevated violet #2F234A, translucent border). The focused outline
  // uses the FOREGROUND violet `palette.primary.main` (#6D28D9 light, #A78BFA dark) at 2px;
  // the field surface itself never changes on hover/focus — hover is carried by the border.
  MuiOutlinedInput: {
    styleOverrides: {
      root: ({ theme }) => ({
        borderRadius: themeTokens.borderRadius.button,
        backgroundColor: 'var(--input-bg)',
        '& .MuiOutlinedInput-notchedOutline': {
          borderColor: 'var(--input-border)',
        },
        '&:hover .MuiOutlinedInput-notchedOutline': {
          borderColor: 'var(--input-border-hover)',
        },
        '&.Mui-focused .MuiOutlinedInput-notchedOutline': {
          borderColor: theme.palette.primary.main,
          borderWidth: 2,
        },
        '&.Mui-disabled': {
          // Field surface dimmed + the disabled text tier (#7B7591 light, #6F6882 dark),
          // never a light-scale grey stranded on the dark field. The hover surface is the
          // opaque fallback for browsers without color-mix() (Safari < 16.2).
          backgroundColor: 'var(--input-bg-hover)',
          '@supports (background-color: color-mix(in srgb, red 50%, transparent))': {
            backgroundColor: 'color-mix(in srgb, var(--input-bg) 50%, transparent)',
          },
          color: theme.palette.text.disabled,
        },
      }),
    },
  },
  // Legacy floating labels (unmigrated forms, until the FormField waves land): the
  // resting label sits INSIDE the field, the shrunk label floats over the page/card —
  // text.secondary clears AA on both in both schemes (guard-tested). Focus keeps the
  // label quiet; the 2px violet outline carries focus.
  MuiInputLabel: {
    styleOverrides: {
      root: ({ theme }) => ({
        color: theme.palette.text.secondary,
        '&.Mui-focused': {
          color: theme.palette.text.secondary,
        },
        '&.Mui-error': {
          color: theme.palette.error.main,
        },
      }),
    },
  },
  // Filled-variant inputs (climbs list, bulk import, snackbar) ride the same field
  // surface family as outlined ones.
  MuiFilledInput: {
    styleOverrides: {
      root: {
        backgroundColor: 'var(--input-bg)',
        '&:hover': {
          backgroundColor: 'var(--input-bg-hover)',
        },
        '&.Mui-focused': {
          backgroundColor: 'var(--input-bg-focused)',
        },
        '&.Mui-disabled': {
          backgroundColor: 'var(--input-bg-hover)',
          '@supports (background-color: color-mix(in srgb, red 50%, transparent))': {
            backgroundColor: 'color-mix(in srgb, var(--input-bg) 50%, transparent)',
          },
        },
      },
    },
  },
  MuiSelect: {
    styleOverrides: {
      root: {
        borderRadius: themeTokens.borderRadius.button,
      },
      icon: ({ theme }) => ({
        color: theme.palette.text.secondary,
      }),
    },
  },
  MuiDrawer: {
    styleOverrides: {
      paper: {
        borderRadius: themeTokens.borderRadius.lg,
      },
      paperAnchorBottom: {
        borderRadius: `${themeTokens.borderRadius.lg}px ${themeTokens.borderRadius.lg}px 0 0`,
        paddingBottom: themeTokens.layout.safeAreaBottom,
      },
      paperAnchorLeft: {
        borderRadius: `0 ${themeTokens.borderRadius.lg}px ${themeTokens.borderRadius.lg}px 0`,
        paddingTop: themeTokens.layout.safeAreaTop,
        paddingBottom: themeTokens.layout.safeAreaBottom,
      },
      paperAnchorRight: {
        borderRadius: `${themeTokens.borderRadius.lg}px 0 0 ${themeTokens.borderRadius.lg}px`,
        paddingTop: themeTokens.layout.safeAreaTop,
        paddingBottom: themeTokens.layout.safeAreaBottom,
      },
      paperAnchorTop: {
        borderRadius: `0 0 ${themeTokens.borderRadius.lg}px ${themeTokens.borderRadius.lg}px`,
        paddingTop: themeTokens.layout.safeAreaTop,
      },
    },
  },
  MuiDialog: {
    styleOverrides: {
      paper: {
        borderRadius: themeTokens.borderRadius.lg,
      },
    },
  },
  MuiAccordion: {
    styleOverrides: {
      root: {
        borderRadius: themeTokens.borderRadius.md,
        '&:before': {
          display: 'none',
        },
      },
    },
  },
  MuiAccordionSummary: {
    styleOverrides: {
      root: {
        fontWeight: themeTokens.typography.fontWeight.medium,
        backgroundColor: 'var(--neutral-50)',
      },
    },
  },
  MuiTabs: {
    styleOverrides: {
      indicator: ({ theme }) => ({
        backgroundColor: theme.palette.primary.main,
      }),
    },
  },
  MuiTab: {
    styleOverrides: {
      root: ({ theme }) => ({
        textTransform: 'none' as const,
        fontWeight: themeTokens.typography.fontWeight.medium,
        '&.Mui-selected': {
          color: theme.palette.primary.main,
        },
      }),
    },
  },
  MuiChip: {
    styleOverrides: {
      root: {
        borderRadius: themeTokens.borderRadius.full,
        fontWeight: themeTokens.typography.fontWeight.medium,
      },
    },
  },
  MuiRating: {
    styleOverrides: {
      iconFilled: {
        color: themeTokens.colors.amber,
      },
      icon: {
        transition: 'transform 150ms cubic-bezier(0.2, 0, 0, 1)',
        '&:hover': {
          transform: 'scale(1.1)',
        },
      },
    },
  },
  MuiCssBaseline: {
    styleOverrides: {
      html: {
        touchAction: 'manipulation',
        scrollbarWidth: 'thin',
        scrollbarColor: 'var(--neutral-300) var(--neutral-100)',
      },
    },
  },
  MuiMenu: {
    styleOverrides: {
      paper: {
        borderRadius: themeTokens.borderRadius.md,
      },
    },
  },
  MuiPopover: {
    styleOverrides: {
      paper: {
        borderRadius: themeTokens.borderRadius.md,
      },
    },
  },
  MuiBottomNavigationAction: {
    styleOverrides: {
      label: {
        fontSize: '10px',
        marginTop: '2px',
        lineHeight: 1,
        '&.Mui-selected': {
          fontSize: '10px',
        },
      },
    },
  },
  MuiSkeleton: {
    styleOverrides: {
      root: {
        backgroundColor: 'var(--neutral-100)',
      },
    },
  },
  // Form kit label: 14/500, primary text colour (labels read as content, not muted
  // captions). The required asterisk carries the error hue; focus is signalled by the
  // input's ring, so the label deliberately does NOT flash violet on focus.
  MuiFormLabel: {
    styleOverrides: {
      root: ({ theme }) => ({
        fontSize: 14,
        fontWeight: themeTokens.typography.fontWeight.medium,
        lineHeight: 20 / 14,
        color: theme.palette.text.primary,
        '& .MuiFormLabel-asterisk': {
          color: theme.palette.error.main,
        },
        '&.Mui-focused': {
          color: 'inherit',
        },
      }),
    },
  },
  // Helper text sits flush-left under the field with a 4px gap; 12px caption size.
  MuiFormHelperText: {
    styleOverrides: {
      root: {
        marginLeft: 0,
        marginTop: '4px',
        fontSize: 12,
      },
    },
  },
};

// Velvet motion: Glass-leaning. M3 'standard' easing on utility transitions; MUI's
// `sharp` slot (used by enter/exit of large surfaces) gets the 'emphasized' curve.
const standardEasing = themeTokens.motion.easing.standard;
const emphasizedEasing = themeTokens.motion.easing.emphasized;

// Shared options for both themes (typography, shape, transitions)
const sharedOptions: Partial<ThemeOptions> = {
  typography: {
    fontFamily: themeTokens.typography.fontFamily,
    fontSize: themeTokens.typography.fontSize.base,
    h1: { fontWeight: themeTokens.typography.fontWeight.bold },
    h2: { fontWeight: themeTokens.typography.fontWeight.bold },
    // Pin the heading ramp in px. MUI derives unpinned variants from a 16/14 coefficient
    // (htmlFontSize / fontSize), which inflates them — an unpinned h6 renders 22.86px
    // instead of the intended 16. Pinning fontSize side-steps the coefficient.
    h3: {
      fontSize: themeTokens.typography.fontSize['2xl'],
      fontWeight: themeTokens.typography.fontWeight.bold,
      lineHeight: 32 / 24,
    },
    h4: { fontSize: themeTokens.typography.fontSize.xl, fontWeight: themeTokens.typography.fontWeight.semibold },
    h5: { fontSize: themeTokens.typography.fontSize.lg, fontWeight: themeTokens.typography.fontWeight.semibold },
    h6: { fontSize: themeTokens.typography.fontSize.base, fontWeight: themeTokens.typography.fontWeight.semibold },
    // Section-heading variant (FormSection titles and friends): 14/600/20.
    subtitle2: {
      fontSize: themeTokens.typography.fontSize.sm,
      fontWeight: themeTokens.typography.fontWeight.semibold,
      lineHeight: 20 / 14,
    },
    body1: {
      fontSize: themeTokens.typography.fontSize.base,
      lineHeight: themeTokens.typography.lineHeight.normal,
    },
    body2: {
      fontSize: themeTokens.typography.fontSize.sm,
      lineHeight: themeTokens.typography.lineHeight.normal,
    },
    button: {
      fontSize: themeTokens.typography.fontSize.base,
      fontWeight: themeTokens.typography.fontWeight.medium,
      textTransform: 'none' as const,
    },
    caption: {
      fontSize: themeTokens.typography.fontSize.xs,
      fontWeight: themeTokens.typography.fontWeight.normal,
      lineHeight: 16 / 12,
    },
  },
  shape: {
    borderRadius: themeTokens.borderRadius.button,
  },
  transitions: {
    duration: {
      shortest: 150,
      shorter: 150,
      short: 250,
      standard: 250,
      complex: 350,
      enteringScreen: 250,
      leavingScreen: 250,
    },
    easing: {
      easeInOut: standardEasing,
      easeOut: standardEasing,
      easeIn: 'cubic-bezier(0.4, 0, 1, 1)',
      sharp: emphasizedEasing,
    },
  },
};

const lightShadows = [
  'none',
  themeTokens.shadows.xs,
  themeTokens.shadows.sm,
  themeTokens.shadows.sm,
  themeTokens.shadows.md,
  themeTokens.shadows.md,
  themeTokens.shadows.lg,
  themeTokens.shadows.lg,
  themeTokens.shadows.xl,
  ...Array(16).fill(themeTokens.shadows.xl),
] as unknown as typeof createTheme extends (o: { shadows?: infer S }) => unknown ? S : never;

// Dark mode component overrides. Input fields now ride the shared `--input-*` CSS vars
// (elevated violet #2F234A, violet focus ring) — no dark-only input block remains. Two
// dark-only concerns stay:
// (1) MUI v7 composites a white elevation overlay onto every Paper in dark mode via
//     `backgroundImage`. Kill it, or dialog paper drifts to ~#49415B where secondary
//     text fails AA.
// (2) Pin the floating surfaces (dialog/drawer/menu/popover) to the elevated dark
//     surface (#2F234A) with a hairline separator border, so they read as one
//     deliberate Velvet layer instead of an elevation-tinted grey.
const darkElevatedPaper = {
  backgroundColor: darkTokens.semantic.surfaceElevated,
  border: '1px solid var(--separator)',
} as const;

const darkComponents: Components<Theme> = {
  ...sharedComponents,
  MuiPaper: {
    styleOverrides: {
      root: {
        backgroundImage: 'none',
      },
    },
  },
  MuiDialog: {
    styleOverrides: {
      paper: {
        borderRadius: themeTokens.borderRadius.lg,
        ...darkElevatedPaper,
      },
    },
  },
  MuiDrawer: {
    styleOverrides: {
      // Preserve the shared anchor-specific radius/padding slots; only the base `paper`
      // slot gains the elevated surface + border.
      ...sharedComponents.MuiDrawer?.styleOverrides,
      paper: {
        borderRadius: themeTokens.borderRadius.lg,
        ...darkElevatedPaper,
      },
    },
  },
  MuiMenu: {
    styleOverrides: {
      paper: {
        borderRadius: themeTokens.borderRadius.md,
        ...darkElevatedPaper,
      },
    },
  },
  MuiPopover: {
    styleOverrides: {
      paper: {
        borderRadius: themeTokens.borderRadius.md,
        ...darkElevatedPaper,
      },
    },
  },
  // Autocomplete popups render through a Popper (not Menu/Popover), so the elevated
  // paper needs its own pin.
  MuiAutocomplete: {
    styleOverrides: {
      paper: {
        borderRadius: themeTokens.borderRadius.md,
        ...darkElevatedPaper,
      },
    },
  },
};

const darkShadows = [
  'none',
  darkTokens.shadows.xs,
  darkTokens.shadows.sm,
  darkTokens.shadows.sm,
  darkTokens.shadows.md,
  darkTokens.shadows.md,
  darkTokens.shadows.lg,
  darkTokens.shadows.lg,
  darkTokens.shadows.xl,
  ...Array(16).fill(darkTokens.shadows.xl),
] as unknown as typeof createTheme extends (o: { shadows?: infer S }) => unknown ? S : never;

function buildTheme(mode: 'light' | 'dark'): Theme {
  const isDark = mode === 'dark';
  const brand = isDark ? darkTokens.colors : themeTokens.colors;
  const neutral = isDark ? darkTokens.neutral : themeTokens.neutral;
  const semantic = isDark ? darkTokens.semantic : themeTokens.semantic;
  const statusLight = isDark
    ? darkTokens.statusBg
    : {
        success: themeTokens.colors.successBg,
        error: themeTokens.colors.errorBg,
        warning: themeTokens.colors.warningBg,
      };

  const base = createTheme({
    ...sharedOptions,
    palette: {
      mode,
      // primary.main is the FOREGROUND violet (links, text/outlined buttons, selection
      // controls, tab indicator all read palette.primary.main). FILL goes to the
      // augmented `primaryFill` channel below. contrastText is the text colour when
      // primary is ever used as a background: white on the light #6D28D9, dark on the
      // lifted dark #A78BFA — set explicitly so MUI's getContrastText never warns.
      primary: {
        main: brand.primary,
        dark: brand.primaryActive,
        contrastText: isDark ? themeTokens.colors.onAccent : themeTokens.colors.onPrimary,
      },
      secondary: {
        main: brand.secondary,
      },
      success: {
        main: brand.success,
        dark: themeTokens.colors.successHover,
        light: statusLight.success,
      },
      warning: {
        main: brand.warning,
        light: statusLight.warning,
      },
      error: {
        main: brand.error,
        light: statusLight.error,
      },
      info: {
        main: brand.info,
      },
      background: {
        default: semantic.background,
        paper: semantic.surface,
      },
      text: {
        primary: neutral[800],
        secondary: neutral[500],
        disabled: neutral[400],
      },
      divider: semantic.separator,
      action: {
        hover: semantic.selectedLight,
        selected: semantic.selected,
      },
    },
    shadows: isDark ? darkShadows : lightShadows,
    components: isDark ? darkComponents : sharedComponents,
  });

  // Augment the custom brand channels into full PaletteColors (fills in `light`, keeps
  // our explicit main/dark/contrastText).
  return createTheme(base, {
    palette: {
      primaryFill: base.palette.augmentColor({
        color: {
          main: brand.primaryFill,
          dark: brand.primaryFillHover,
          contrastText: themeTokens.colors.onPrimary,
        },
        name: 'primaryFill',
      }),
      accent: base.palette.augmentColor({
        color: {
          main: themeTokens.colors.accent,
          // MUI would auto-derive accent.dark ≈ #B36127, where the dark-text brand rule
          // (accent is fill-only, dark text) fails AA (4.11:1). Pin a compliant orange.
          dark: '#F97316',
          contrastText: themeTokens.colors.onAccent,
        },
        name: 'accent',
      }),
    },
  });
}

export const lightTheme = buildTheme('light');
export const darkTheme = buildTheme('dark');

// Backward compat — existing imports of `muiTheme` continue to work
export const muiTheme = lightTheme;
