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
declare module '@mui/material/SvgIcon' {
  interface SvgIconPropsColorOverrides {
    primaryFill: true;
    accent: true;
  }
}

// Shared component overrides used by both light and dark themes. Anything that reads
// the brand colour uses a `({ theme }) =>` callback so it picks up the scheme-aware
// palette (foreground in light vs dark); raw `themeTokens.*` is only for values that
// are intentionally scheme-invariant.
const sharedComponents: Components<Theme> = {
  MuiButton: {
    styleOverrides: {
      root: {
        borderRadius: themeTokens.borderRadius.button,
        fontWeight: themeTokens.typography.fontWeight.medium,
        textTransform: 'none' as const,
        '&:not(:disabled):not(.MuiButton-text):hover': {
          transform: 'translateY(-1px)',
          boxShadow: 'var(--shadow-sm)',
        },
        '&:not(:disabled):active': {
          transform: 'translateY(0)',
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
        transition: 'box-shadow 250ms cubic-bezier(0.2, 0, 0, 1), transform 250ms cubic-bezier(0.2, 0, 0, 1)',
        userSelect: 'none' as const,
        '&:hover': {
          boxShadow: 'var(--shadow-md)',
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
  MuiOutlinedInput: {
    styleOverrides: {
      root: {
        borderRadius: themeTokens.borderRadius.button,
      },
    },
  },
  MuiSelect: {
    styleOverrides: {
      root: {
        borderRadius: themeTokens.borderRadius.button,
      },
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
  MuiBadge: {
    styleOverrides: {
      badge: {
        fontWeight: themeTokens.typography.fontWeight.semibold,
        boxShadow: '0 0 0 2px var(--semantic-surface)',
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
    h3: { fontWeight: themeTokens.typography.fontWeight.semibold },
    h4: { fontWeight: themeTokens.typography.fontWeight.semibold },
    h5: { fontWeight: themeTokens.typography.fontWeight.semibold },
    h6: { fontWeight: themeTokens.typography.fontWeight.medium },
    body1: {
      fontSize: themeTokens.typography.fontSize.base,
      lineHeight: themeTokens.typography.lineHeight.normal,
    },
    body2: {
      fontSize: themeTokens.typography.fontSize.sm,
      lineHeight: themeTokens.typography.lineHeight.normal,
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

// Dark mode component overrides — extends shared overrides with white input fields.
const darkComponents: Components<Theme> = {
  ...sharedComponents,
  MuiInputBase: {
    styleOverrides: {
      root: {
        backgroundColor: darkTokens.semantic.inputSurface,
        color: themeTokens.neutral[800],
        '&.Mui-disabled': {
          backgroundColor: themeTokens.neutral[200],
        },
      },
      input: {
        '&::placeholder': {
          // Inputs are white in dark mode, so the placeholder must be a dark grey
          // that clears AA on white — the LIGHT neutral scale, not the inverted one.
          color: themeTokens.neutral[500],
          opacity: 1,
        },
      },
    },
  },
  MuiOutlinedInput: {
    ...sharedComponents.MuiOutlinedInput,
    styleOverrides: {
      root: ({ theme }) => ({
        borderRadius: themeTokens.borderRadius.button,
        backgroundColor: darkTokens.semantic.inputSurface,
        color: themeTokens.neutral[800],
        '& .MuiOutlinedInput-notchedOutline': {
          borderColor: themeTokens.neutral[300],
        },
        '&:hover .MuiOutlinedInput-notchedOutline': {
          borderColor: themeTokens.neutral[400],
        },
        // Focus border uses the FILL violet (#7C3AED, 5.70:1 on the white input), not
        // the lifted foreground #A78BFA (2.72:1 on white — fails).
        '&.Mui-focused .MuiOutlinedInput-notchedOutline': {
          borderColor: theme.palette.primaryFill.main,
        },
        '&.Mui-disabled': {
          backgroundColor: themeTokens.neutral[200],
        },
      }),
    },
  },
  MuiFilledInput: {
    styleOverrides: {
      root: {
        backgroundColor: darkTokens.semantic.inputSurface,
        color: themeTokens.neutral[800],
        '&:hover': {
          backgroundColor: themeTokens.neutral[100],
        },
        '&.Mui-focused': {
          backgroundColor: darkTokens.semantic.inputSurface,
        },
        '&.Mui-disabled': {
          backgroundColor: themeTokens.neutral[200],
        },
      },
    },
  },
  MuiSelect: {
    ...sharedComponents.MuiSelect,
    styleOverrides: {
      root: {
        borderRadius: themeTokens.borderRadius.button,
        backgroundColor: darkTokens.semantic.inputSurface,
        color: themeTokens.neutral[800],
      },
      icon: {
        color: themeTokens.neutral[500],
      },
    },
  },
  MuiAutocomplete: {
    styleOverrides: {
      inputRoot: {
        backgroundColor: darkTokens.semantic.inputSurface,
        color: themeTokens.neutral[800],
      },
    },
  },
  MuiInputLabel: {
    styleOverrides: {
      root: ({ theme }) => ({
        // Resting label sits inside the white input — needs dark text.
        color: themeTokens.neutral[700],
        // Shrunk label floats over the dark page bg — needs light text.
        '&.MuiInputLabel-shrink': {
          color: darkTokens.neutral[700],
        },
        '&.Mui-focused': {
          color: theme.palette.primary.main,
        },
      }),
    },
  },
  MuiTextField: {
    ...sharedComponents.MuiTextField,
    styleOverrides: {
      root: ({ theme }) => ({
        '& .MuiOutlinedInput-root': {
          borderRadius: themeTokens.borderRadius.button,
          backgroundColor: darkTokens.semantic.inputSurface,
          color: themeTokens.neutral[800],
        },
        '& .MuiInputLabel-root': {
          color: themeTokens.neutral[700],
        },
        '& .MuiInputLabel-root.MuiInputLabel-shrink': {
          color: darkTokens.neutral[700],
        },
        '& .MuiInputLabel-root.Mui-focused': {
          color: theme.palette.primary.main,
        },
      }),
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
