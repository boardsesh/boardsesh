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

const SIZE_SX: Record<BrandCtaSize, SxProps<Theme>> = {
  small: { px: 2, flexShrink: 0, whiteSpace: 'nowrap' },
  medium: { px: 3 },
  large: {
    px: 4,
    py: 1.5,
    fontSize: themeTokens.typography.fontSize.lg,
  },
};

/**
 * Build the CTA style. Call it at module scope and hoist the result, the way the
 * `*_SX` constants it replaces were hoisted — it is a plain object, so calling
 * it per render would allocate a new one every time for no benefit.
 */
export function brandCtaSx({ size = 'medium', glow = false }: BrandCtaOptions = {}): SxProps<Theme> {
  return {
    borderRadius: `${themeTokens.borderRadius.full}px`,
    textTransform: 'none',
    fontWeight: themeTokens.typography.fontWeight.semibold,
    backgroundColor: 'var(--color-primary-fill)',
    color: 'var(--color-on-primary)',
    ...(SIZE_SX[size] as object),
    ...(glow ? { boxShadow: 'var(--shadow-accent-glow)' } : null),
    '&:hover': {
      backgroundColor: 'var(--color-primary-fill-hover)',
      // The shared StartClimbingButton lifts on hover; the brand pill does not.
      transform: 'none',
      ...(glow ? { boxShadow: 'var(--shadow-accent-glow-hover)' } : null),
    },
  };
}
