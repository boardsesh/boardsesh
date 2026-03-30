import {
  createTheme,
  type ThemeOptions,
  type Components,
  type Theme,
} from '@mui/material/styles'
import { themeTokens, darkTokens } from './theme-config'

// Shared component overrides used by both light and dark themes
const sharedComponents: Components<Theme> = {
  MuiButton: {
    styleOverrides: {
      root: {
        borderRadius: themeTokens.borderRadius.md,
        fontWeight: themeTokens.typography.fontWeight.medium,
        textTransform: 'none' as const,
      },
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
  MuiCard: {
    styleOverrides: {
      root: {
        borderRadius: themeTokens.borderRadius.lg,
      },
    },
  },
  MuiTextField: {
    styleOverrides: {
      root: {
        '& .MuiOutlinedInput-root': {
          borderRadius: themeTokens.borderRadius.md,
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
        borderRadius: themeTokens.borderRadius.md,
      },
    },
  },
  MuiChip: {
    styleOverrides: {
      root: {
        borderRadius: themeTokens.borderRadius.sm,
        fontWeight: themeTokens.typography.fontWeight.medium,
      },
    },
  },
}

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
    borderRadius: themeTokens.borderRadius.md,
  },
  transitions: {
    duration: {
      shortest: 150,
      shorter: 150,
      short: 200,
      standard: 200,
      complex: 300,
      enteringScreen: 200,
      leavingScreen: 200,
    },
  },
}

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
] as unknown as typeof createTheme extends (o: { shadows?: infer S }) => unknown
  ? S
  : never

export const darkTheme = createTheme({
  ...sharedOptions,
  palette: {
    mode: 'dark',
    primary: {
      main: themeTokens.colors.primary,
      dark: themeTokens.colors.primaryActive,
    },
    secondary: {
      main: themeTokens.colors.secondary,
    },
    success: {
      main: themeTokens.colors.success,
      dark: themeTokens.colors.successHover,
      light: darkTokens.statusBg.success,
    },
    warning: {
      main: themeTokens.colors.warning,
      light: darkTokens.statusBg.warning,
    },
    error: {
      main: themeTokens.colors.error,
      light: darkTokens.statusBg.error,
    },
    info: {
      main: darkTokens.neutral[500],
    },
    background: {
      default: darkTokens.semantic.surface,
      paper: darkTokens.semantic.surfaceElevated,
    },
    text: {
      primary: darkTokens.neutral[800],
      secondary: darkTokens.neutral[500],
      disabled: darkTokens.neutral[400],
    },
    divider: darkTokens.neutral[200],
    action: {
      hover: darkTokens.semantic.selectedLight,
      selected: darkTokens.semantic.selected,
    },
  },
  shadows: darkShadows,
  components: sharedComponents,
})
