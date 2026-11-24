import {
  createTheme,
  type ThemeOptions,
  type Components,
  type Theme,
  type TypographyStyle,
} from '@mui/material/styles';
import { themeTokens } from './theme-config';

// Velvet Send adds two brand channels MUI doesn't ship by default:
// - `primaryFill`: the FILLED-surface violet (button bg + white text). Kept separate
//   from `primary` (the FOREGROUND violet that MUI reads via palette.primary.main for
//   links, text/outlined buttons, and selection controls) because in dark mode the
//   two diverge — foreground #9784FF vs fill #7855FF.
// - `accent`: the mint spark (#3EE6C1 on www), fill-only with dark text.
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
// The marketing type layer (www comparison, home and gym marketing pages only):
// a section heading bigger than the site h2, the lead paragraph under it, and the
// small sentence-case label above it. Sentence case on purpose: locale-blind
// uppercase is banned, and German and Italian need the room.
declare module '@mui/material/styles' {
  interface TypographyVariants {
    marketingH2: TypographyStyle;
    lead: TypographyStyle;
    eyebrow: TypographyStyle;
  }
  interface TypographyVariantsOptions {
    marketingH2?: TypographyStyle;
    lead?: TypographyStyle;
    eyebrow?: TypographyStyle;
  }
}
declare module '@mui/material/Typography' {
  interface TypographyPropsVariantOverrides {
    marketingH2: true;
    lead: true;
    eyebrow: true;
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
// dark text (Button/Chip/Fab). The mint reads as a foreground on the dark page, but the spark is
// spent once per page as a fill, and its light value is 3.32:1 on white. Icons use a foreground role.
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
  // The marketing variants render as the element their role implies when a caller
  // forgets `component`; unmapped variants keep MUI's own defaults.
  MuiTypography: {
    defaultProps: {
      variantMapping: { marketingH2: 'h2', lead: 'p', eyebrow: 'p' },
    },
  },
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
        // A rounded rectangle, the same 10px as inputs and the segmented toggle.
        // Every button was a full pill until 2026-11: beside 12px cards and 10px
        // inputs, a 44-48px control with round ends and a hairline outline read
        // as a capsule rather than a button. Chips keep `full` (MuiChip below):
        // they are tags and filters, and the round end is what says so.
        borderRadius: themeTokens.borderRadius.button,
        fontWeight: themeTokens.typography.fontWeight.medium,
        textTransform: 'none' as const,
        // Velvet hover is a background TINT, never a lift. Contained variants carry
        // their own fill-hover (see containedPrimary); text/outlined get the button
        // hover wash, which is a hover, not a selected state. No transform/shadow
        // here — nothing to gate behind a hover media query on this element. Only a
        // primary TEXT button (a text action) lifts its violet label on hover; the
        // outlined secondary keeps its grey ink.
        '&:not(:disabled):not(.MuiButton-contained):hover': {
          backgroundColor: 'var(--semantic-button-hover)',
          '&.MuiButton-textPrimary': {
            color: 'var(--color-primary-hover)',
          },
        },
      },
      // Outlined PRIMARY is the grey secondary action: the label ink (#EDEDED, 4.5:1
      // or more on every surface step) on a transparent button with the opaque
      // `--control-border` edge, which stays put on hover (the wash carries hover).
      // A page spends its violet on the one filled action, links and text actions.
      // MUI's default outlined edge is the foreground violet at 50% alpha, which
      // drifted from `brandCtaOutlinedSx` (the consent banner's Allow / No thanks
      // and the gym search button wore one edge, the brand buttons another), so
      // the edge is pinned here too. Set the v7 variant vars plus a direct
      // fallback, like containedPrimary. Keep ONE `outlinedPrimary` key: a second
      // one later in this object silently replaces this whole block.
      outlinedPrimary: {
        '--variant-outlinedColor': 'var(--neutral-900)',
        '--variant-outlinedBorder': 'var(--control-border)',
        color: 'var(--neutral-900)',
        borderColor: 'var(--control-border)',
        '@media (hover: hover)': {
          '&:hover': {
            '--variant-outlinedBorder': 'var(--control-border)',
          },
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
  // Inline links are the foreground violet and always underlined: the underline,
  // not the hue, is what tells a link from body copy (#9784FF vs #EDEDED is 2.54:1,
  // under WCAG 1.4.1's 3:1). Nav, footer and breadcrumb links opt out with their
  // own grey recipe.
  MuiLink: {
    defaultProps: {
      underline: 'always',
    },
    styleOverrides: {
      root: {
        textUnderlineOffset: '3px',
      },
    },
  },
  // Selected toggles and segments are the tonal container with its own ink, the same
  // selected state as a filter chip. Rest is a grey control: transparent, the label
  // ink, the opaque `--control-border` edge. A selected toggle that needs a
  // non-colour cue renders `SelectedCheck` (the gyms radius control does).
  MuiToggleButton: {
    styleOverrides: {
      root: {
        textTransform: 'none' as const,
        color: 'var(--neutral-900)',
        borderColor: 'var(--control-border)',
        // Pointer devices only, like MUI's own: on touch a tap would leave the
        // wash stuck on the button it landed on.
        '@media (hover: hover)': {
          '&:hover': {
            backgroundColor: 'var(--semantic-hover)',
          },
        },
        '&.Mui-selected': {
          color: 'var(--semantic-on-selected)',
          backgroundColor: 'var(--semantic-selected)',
          '&:hover': {
            backgroundColor: 'var(--semantic-selected-hover)',
          },
        },
      },
    },
  },
  // The current item in a menu (the header menu's current page, the language
  // menu's current locale) is a current state, so it takes the tonal container
  // rather than MUI's translucent primary wash.
  MuiMenuItem: {
    styleOverrides: {
      root: {
        '&.Mui-selected, &.Mui-selected.Mui-focusVisible': {
          color: 'var(--semantic-on-selected)',
          backgroundColor: 'var(--semantic-selected)',
        },
        '&.Mui-selected:hover': {
          backgroundColor: 'var(--semantic-selected-hover)',
        },
      },
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
  // Input surface + borders ride the `--input-*` CSS vars: the raised Graphite field
  // #262626 with the opaque #8A8A8A outline. The focused outline uses the FOREGROUND
  // violet `palette.primary.main` (#9784FF, 5.09:1 on the field) at 2px; the field
  // surface itself never changes on hover/focus — hover is carried by the border.
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
          // Field surface dimmed + the disabled text tier (text.disabled, #636363),
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
        backgroundColor: 'var(--semantic-fill-subtle)',
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
        backgroundColor: 'var(--semantic-fill)',
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
    marketingH2: {
      fontFamily: 'var(--font-display), sans-serif',
      fontSize: 40,
      fontWeight: themeTokens.typography.fontWeight.bold,
      lineHeight: 1.1,
      letterSpacing: '-0.02em',
      textWrap: 'balance',
      '@media (max-width: 600px)': { fontSize: 28 },
    },
    lead: {
      fontSize: themeTokens.typography.fontSize.xl,
      lineHeight: themeTokens.typography.lineHeight.normal,
      color: themeTokens.neutral[500],
      '@media (max-width: 600px)': { fontSize: themeTokens.typography.fontSize.lg },
    },
    eyebrow: {
      fontSize: themeTokens.typography.fontSize.sm,
      fontWeight: themeTokens.typography.fontWeight.semibold,
      lineHeight: 1.4,
      color: themeTokens.neutral[500],
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

// Two things a dark palette needs from MUI that the shared overrides don't cover:
// (1) MUI v7 composites a white elevation overlay onto every Paper in dark mode via
//     `backgroundImage`. Kill it, or dialog paper drifts lighter than the ladder and
//     stops matching the app's surfaces.
// (2) Pin the floating surfaces (dialog/drawer/menu/popover) to the elevated surface
//     (#262626) with a hairline separator border, so they read as one deliberate
//     layer instead of an elevation-tinted grey.
const elevatedPaper = {
  backgroundColor: themeTokens.semantic.surfaceElevated,
  border: '1px solid var(--separator)',
} as const;

/** The standard-variant Alert severities whose palette `.light` is a translucent tint. */
export const STANDARD_ALERT_SEVERITIES = ['error', 'warning', 'success'] as const;
const STANDARD_ALERT_TINTS: Record<(typeof STANDARD_ALERT_SEVERITIES)[number], string> = {
  error: themeTokens.colors.errorBg,
  warning: themeTokens.colors.warningBg,
  success: themeTokens.colors.successBg,
};

const components: Components<Theme> = {
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
        ...elevatedPaper,
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
        ...elevatedPaper,
      },
    },
  },
  MuiMenu: {
    styleOverrides: {
      paper: {
        borderRadius: themeTokens.borderRadius.md,
        ...elevatedPaper,
      },
    },
  },
  MuiPopover: {
    styleOverrides: {
      paper: {
        borderRadius: themeTokens.borderRadius.md,
        ...elevatedPaper,
      },
    },
  },
  // Autocomplete popups render through a Popper (not Menu/Popover), so the elevated
  // paper needs its own pin.
  MuiAutocomplete: {
    styleOverrides: {
      paper: {
        borderRadius: themeTokens.borderRadius.md,
        ...elevatedPaper,
      },
    },
  },
  // `palette.<status>.light` is the translucent status tint (`errorBg` and its
  // siblings). MUI's standard Alert lightens `.light` into its TEXT colour, which
  // keeps the 14% alpha, so every standard error, warning and success message
  // rendered as near-invisible text (form errors on /auth/login among them).
  // Pin the standard variants: the tint as background, max-contrast ink as text,
  // and the status hue left on the icon, where MUI already puts `.main`.
  MuiAlert: {
    styleOverrides: {
      root: {
        variants: STANDARD_ALERT_SEVERITIES.map((severity) => ({
          props: { variant: 'standard', severity },
          style: { backgroundColor: STANDARD_ALERT_TINTS[severity], color: themeTokens.neutral[900] },
        })),
      },
    },
  },
};

const shadows = [
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

function buildTheme(): Theme {
  const brand = themeTokens.colors;
  const { neutral, semantic } = themeTokens;
  const statusLight = {
    success: brand.successBg,
    error: brand.errorBg,
    warning: brand.warningBg,
  };

  const base = createTheme({
    ...sharedOptions,
    palette: {
      // Stays hardcoded. MUI derives getContrastText, its alpha overlays, and the
      // Skeleton / Backdrop / Rating defaults from palette.mode — dropping it is a
      // silent restyle, not a simplification.
      mode: 'dark',
      // primary.main is the FOREGROUND violet (links, text/outlined buttons, selection
      // controls, tab indicator all read palette.primary.main). FILL goes to the
      // augmented `primaryFill` channel below. contrastText is the INK on the lifted
      // foreground violet, and that ink is dark: white on #9784FF is 2.97:1. Set
      // explicitly so MUI's getContrastText never warns.
      // `dark` is pinned to `main`: there is no darker foreground step, and MUI's
      // auto-derived one would be a violet nothing else on the page uses.
      primary: {
        main: brand.primary,
        dark: brand.primary,
        contrastText: brand.onAccent,
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
        // The label at 38% over the page (3.21:1). Disabled text is exempt from AA;
        // neutral[400] is now the readable tertiary label, so it cannot double as this.
        disabled: themeTokens.text.disabled,
      },
      divider: semantic.separator,
      action: {
        hover: semantic.hover,
        selected: semantic.selectedRow,
      },
    },
    shadows,
    components,
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
          // Pin the hover step instead of MUI's auto-derived one, so the dark-text brand
          // rule (accent is fill-only, dark text) is a known number: the mint's own hue,
          // one lightness step down, with #16111F on it at 9.18:1.
          dark: '#02CEAA',
          contrastText: themeTokens.colors.onAccent,
        },
        name: 'accent',
      }),
    },
  });
}

// The one theme. Named for what it is rather than a bare `theme`, which would
// collide with the `({ theme }) => …` callback parameter in every `sx` block.
export const darkTheme = buildTheme();
