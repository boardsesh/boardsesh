import type { SxProps, Theme } from '@mui/material/styles';

/**
 * The grey link for wayfinding chrome: breadcrumb crumbs, the same treatment the
 * header nav and the footer columns use. The secondary label (#B0B0B0, 8.90:1 on
 * the page) at rest; the label ink with an underline on hover or keyboard focus.
 *
 * Violet on www is for inline links, text actions and the page's one filled
 * action. A breadcrumb is none of those: a trail of violet crumbs above every
 * heading was the violet overload this recipe removes.
 *
 * A plain object, so server components can pass it straight to `sx`.
 */
export const quietLinkSx = {
  color: 'var(--neutral-500)',
  textDecoration: 'none',
  '&:hover, &:focus-visible': {
    color: 'var(--neutral-900)',
    textDecoration: 'underline',
  },
} satisfies SxProps<Theme>;
