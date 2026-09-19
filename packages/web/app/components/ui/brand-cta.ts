import type { SxProps, Theme } from '@mui/material/styles';
import { themeTokens } from '@/app/theme/theme-config';

/**
 * The filled violet pill. One definition, because there were four.
 *
 * `marketing-header.tsx`, `site-footer.tsx`, `help-content.tsx` and
 * `home-page-content.tsx` each carried their own near-identical `*_SX` object.
 * They differed only in horizontal padding and, in the hero's case, an amber
 * glow — and they had already drifted: only the hero had the glow, and only the
 * header set `flexShrink`.
 *
 * Colour comes from the scheme-aware CSS vars, not `themeTokens.colors.*`, so
 * the fill and its hover stay in one place: `--color-primary-fill` is the FILLED
 * violet (`#7C3AED`). It is NOT `--color-primary` (`#A78BFA`), which is the
 * foreground violet — white on that is 2.5:1.
 */
export type BrandCtaSize = 'small' | 'medium' | 'large';

export type BrandCtaOptions = {
  /** `small` in dense chrome, `medium` inline, `large` for a page's one hero. */
  size?: BrandCtaSize;
  /**
   * The amber glow. Amber is fill-only in Velvet Send and this is the single
   * place it appears as light — so at most ONE surface per page sets it.
   */
  glow?: boolean;
};

/**
 * ONE ramp, shared by the filled and outlined recipes. That sharing is the point:
 * a filled pill and the outlined pill beside it are a PAIR, and the only reason
 * they ever stopped matching was that each call site wrote its own padding.
 *
 * `medium` pins `minHeight: 44` because MUI's `sizeMedium` is 40px, under the
 * 44px target the rest of the site holds itself to. `small` lives in the header,
 * where `marketing-header.module.css` already floors every control at 44px, and
 * `large` is 48px from MUI — so medium is the only step that needs it said.
 */
const SIZE_SX = {
  small: { px: 2, flexShrink: 0, whiteSpace: 'nowrap' },
  medium: { px: 3, minHeight: 44 },
  large: {
    px: 4,
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
export function brandCtaSx({ size = 'medium', glow = false }: BrandCtaOptions = {}) {
  return {
    borderRadius: `${themeTokens.borderRadius.full}px`,
    textTransform: 'none',
    fontWeight: themeTokens.typography.fontWeight.semibold,
    backgroundColor: 'var(--color-primary-fill)',
    color: 'var(--color-on-primary)',
    ...SIZE_SX[size],
    ...(glow ? { boxShadow: 'var(--shadow-accent-glow)' } : {}),
    '&:hover': {
      backgroundColor: 'var(--color-primary-fill-hover)',
      // The shared StartClimbingButton lifts on hover; the brand pill does not.
      transform: 'none',
      ...(glow ? { boxShadow: 'var(--shadow-accent-glow-hover)' } : {}),
    },
  } satisfies SxProps<Theme>;
}

export type BrandCtaOutlinedOptions = {
  /** Same ramp as `brandCtaSx`, so a filled/outlined pair cannot drift apart. */
  size?: BrandCtaSize;
};

/**
 * The outlined pill that stands beside the filled one. One definition, because
 * there were three near-identical ones: the hero's `HERO_SECONDARY_CTA_SX`,
 * a drifted copy inside `marketing-install-links.tsx` (different `px`, different
 * `fontSize` — which is why the mid-page store pair visibly did not match the
 * hero pair), and a bare `variant="outlined"` in the support block that fell
 * through to MUI's defaults and so matched neither.
 *
 * No `glow` option, deliberately. The amber glow belongs to the filled pill and
 * to one surface per page; an outlined button that glows would be a third thing.
 *
 * The border reads `--control-border`, not `--separator`: this is the visual
 * boundary of a control, and a button whose fill is transparent has nothing else
 * to identify it. See the token split in `index.css`.
 */
export function brandCtaOutlinedSx({ size = 'medium' }: BrandCtaOutlinedOptions = {}) {
  return {
    borderRadius: `${themeTokens.borderRadius.full}px`,
    textTransform: 'none',
    fontWeight: themeTokens.typography.fontWeight.semibold,
    color: 'var(--color-primary)',
    borderColor: 'var(--control-border)',
    ...SIZE_SX[size],
    '&:hover': {
      borderColor: 'var(--color-primary)',
      backgroundColor: 'var(--semantic-selected-light)',
      // Cancels the same global StartClimbingButton lift the filled pill cancels.
      transform: 'none',
    },
  } satisfies SxProps<Theme>;
}
