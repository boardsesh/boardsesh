import { themeTokens } from '@/app/theme/theme-config';

/**
 * Headings on the public board pages (climb, board list, spray wall) set in the
 * display face.
 *
 * Naming the font here is load-bearing: a MUI Typography variant (`h3`, `h5`,
 * `h1`...) sets its own `font-family`, and that class beats the global
 * `h1, h2 { font-family: var(--font-display) }` rule in `index.css`, so a
 * heading that only relies on the global rule renders in the body font.
 */
const DISPLAY_FONT_FAMILY = 'var(--font-display), sans-serif';

/** The page's one `<h1>`. */
export const frontDoorTitleSx = {
  fontFamily: DISPLAY_FONT_FAMILY,
  fontWeight: themeTokens.typography.fontWeight.bold,
  letterSpacing: '-0.025em',
  textWrap: 'balance' as const,
};

/** The `<h2>` that opens each band below the title. */
export const frontDoorSectionHeadingSx = {
  fontFamily: DISPLAY_FONT_FAMILY,
  fontWeight: themeTokens.typography.fontWeight.semibold,
  letterSpacing: '-0.02em',
  mb: 1.5,
};
