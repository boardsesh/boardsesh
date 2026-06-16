import type { UiVariant } from '../resolve-ui-variant';

/**
 * Per-variant FEATURE / content-layout flags — distinct from styling tokens. A
 * `false` here means "intentionally not shown, or laid out differently, in this
 * design language", NOT "can't render". Each flag is a product/layout decision;
 * change it here in one place rather than scattering `variant === 'material' ? …`
 * gates across screens. Resolved once in the provider and exposed as `theme.features`.
 */
export type VariantFeatures = {
  /** Large in-body screen title. Off on Material — the M3 app bar owns the title, so
   *  an in-body large title would double it. (Consumed by `ScreenTitle`.) */
  inBodyLargeTitle: boolean;
  /** Filters live in the top toolbar (with a condensed filter-summary chip) instead
   *  of a floating bottom FAB. Material uses the toolbar; Liquid Glass floats the FAB.
   *  (Consumed by the climbs screen.) */
  filtersInTopChrome: boolean;
  /** The condensed filter summary omits the grade filter (grade has its own control
   *  in the Material top chrome); Liquid Glass summarises all filter tokens. The other
   *  side of the `filtersInTopChrome` layout decision — kept in the registry so it's
   *  not a bare `selectByVariant` split from the rest. (Consumed by the climbs screen.) */
  summaryExcludesGradeFilter: boolean;
};

export const variantFeatures = {
  liquidGlass: { inBodyLargeTitle: true, filtersInTopChrome: false, summaryExcludesGradeFilter: false },
  material: { inBodyLargeTitle: false, filtersInTopChrome: true, summaryExcludesGradeFilter: true },
} as const satisfies Record<UiVariant, VariantFeatures>;
