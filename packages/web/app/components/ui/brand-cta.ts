import type { SxProps, Theme } from '@mui/material/styles';
import { themeTokens } from '@/app/theme/theme-config';

/**
 * The filled violet button. One definition, because there were four.
 *
 * `marketing-header.tsx`, `site-footer.tsx`, `help-content.tsx` and
 * `home-page-content.tsx` each carried their own near-identical `*_SX` object.
 * They differed only in horizontal padding — and they had already drifted: only
 * the header set `flexShrink`. The button casts no glow: on the Graphite page the
 * one filled violet is enough to mark the page's primary action.
 *
 * Colour comes from the scheme-aware CSS vars, not `themeTokens.colors.*`, so
 * the fill and its hover stay in one place: `--color-primary-fill` is the FILLED
 * violet (`#7855FF`). It is NOT `--color-primary` (`#9784FF`), which is the
 * foreground violet — white on that is 2.97:1.
 */
export type BrandCtaSize = 'small' | 'medium' | 'large';

export type BrandCtaOptions = {
  /** `small` in dense chrome, `medium` inline, `large` for a page's one hero. */
  size?: BrandCtaSize;
};

/**
 * ONE ramp, shared by the filled and outlined recipes. That sharing is the point:
 * a filled button and the outlined one beside it are a PAIR, and the only reason
 * they ever stopped matching was that each call site wrote its own padding.
 *
 * `medium` pins `minHeight: 44` because MUI's `sizeMedium` is 40px, under the
 * 44px target the rest of the site holds itself to. `small` lives in the header,
 * where `marketing-header.module.css` already floors every control at 44px, and
 * `large` explicitly floors the target at 48px because callers may leave MUI's
 * size at its 40px medium default.
 */
const SIZE_SX = {
  small: { px: 2, flexShrink: 0, whiteSpace: 'nowrap' },
  medium: { px: 2.5, minHeight: 44 },
  large: {
    minHeight: 48,
    // 24px from 600px up, 16px on a phone. The old 32px made a 48px-tall button
    // four times as wide as it is tall, which is most of what read as a capsule.
    px: { xs: 2, sm: 3 },
    py: 1.5,
    fontSize: themeTokens.typography.fontSize.lg,
  },
} satisfies Record<BrandCtaSize, SxProps<Theme>>;

/**
 * Build the CTA style. Call it at module scope and hoist the result, the way the
 * `*_SX` constants it replaces were hoisted — it is a plain object, so calling
 * it per render would allocate a new one every time for no benefit.
 *
 * The return type is inferred rather than annotated `SxProps<Theme>`: that type
 * is a union which also admits an array and a callback, so annotating it would
 * make the result unspreadable and force a cast at every call site that merges
 * into it. `satisfies` keeps the key checking without widening.
 */
export function brandCtaSx({ size = 'medium' }: BrandCtaOptions = {}) {
  return {
    borderRadius: `${themeTokens.borderRadius.button}px`,
    textTransform: 'none',
    fontWeight: themeTokens.typography.fontWeight.semibold,
    backgroundColor: 'var(--color-primary-fill)',
    color: 'var(--color-on-primary)',
    ...SIZE_SX[size],
    '&:hover': {
      backgroundColor: 'var(--color-primary-fill-hover)',
      // The shared StartClimbingButton lifts on hover; the brand button does not.
      transform: 'none',
    },
  } satisfies SxProps<Theme>;
}

export type BrandCtaOutlinedOptions = {
  /** Same ramp as `brandCtaSx`, so a filled/outlined pair cannot drift apart. */
  size?: BrandCtaSize;
};

/**
 * The outlined button that stands beside the filled one: the grey secondary
 * action. One definition, because there were three near-identical ones: the
 * hero's `HERO_SECONDARY_CTA_SX`, a drifted copy inside
 * `marketing-install-links.tsx` (different `px`, different `fontSize` — which is
 * why the mid-page store pair visibly did not match the hero pair), and a bare
 * `variant="outlined"` in the support block that fell through to MUI's defaults
 * and so matched neither.
 *
 * Grey, not violet: a page spends its violet on the one filled action, inline
 * links and text actions. The label is the label ink (`--neutral-900`, #EDEDED),
 * which clears 4.5:1 on every surface step up to `--neutral-200` (11.60:1 there).
 * Hover is the button state layer, never a violet edge; focus is the 2px
 * foreground-violet ring every control shares.
 *
 * The border reads `--control-border`, not `--separator`: this is the visual
 * boundary of a control, and a button whose fill is transparent has nothing else
 * to identify it. See the token split in `index.css`.
 */
export function brandCtaOutlinedSx({ size = 'medium' }: BrandCtaOutlinedOptions = {}) {
  return {
    borderRadius: `${themeTokens.borderRadius.button}px`,
    textTransform: 'none',
    fontWeight: themeTokens.typography.fontWeight.semibold,
    color: 'var(--neutral-900)',
    backgroundColor: 'transparent',
    borderColor: 'var(--control-border)',
    ...SIZE_SX[size],
    '&:hover': {
      color: 'var(--neutral-900)',
      borderColor: 'var(--control-border)',
      backgroundColor: 'var(--semantic-button-hover)',
      // Cancels the same global StartClimbingButton lift the filled button cancels.
      transform: 'none',
    },
    '&:focus-visible, &.Mui-focusVisible': {
      outline: '2px solid var(--color-primary)',
      outlineOffset: '2px',
    },
  } satisfies SxProps<Theme>;
}
