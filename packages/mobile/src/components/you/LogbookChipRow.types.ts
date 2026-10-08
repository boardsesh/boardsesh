// Platform-split so @expo/ui/swift-ui (resolves native views at module load)
// never reaches the Android bundle; Android keeps the sheet's filter/sort.

import type { Grade } from '@boardsesh/shared-schema';
import type { LogbookFilterState, LogbookSortPreset } from '@boardsesh/logbook';
import type { LogbookFacetKey } from './LogbookChipRow.logic';

export type LogbookChipRowProps = {
  /** Which preset to highlight (Latest = 'recent'); null lights no chip — a
   *  non-preset sort is active. */
  sortPreset: LogbookSortPreset | null;
  /** Live-commit a preset when its chip is tapped (persists via setPreset). */
  onSelectPreset: (preset: LogbookSortPreset) => void;
  /** Committed filters → every facet chip's label + active flag. */
  filters: LogbookFilterState;
  /** Grade scale (difficultyId → name) for the grade chip's V/font label. Same
   *  source the filter sheet's GradeRangeRail uses so the wording never diverges. */
  grades: readonly Grade[];
  /** Toggle a facet's rail open/close (one at a time) — the chip's tap handler.
   *  The open-state itself is owned by the parent (it renders the rail below the
   *  Host), so it is NOT passed down — keeping it off the props lets the chip row
   *  stay memoised across rail toggles. */
  onToggleFacet: (facet: LogbookFacetKey) => void;
  /** Live-commit a partial filter patch (the Show menu's toggles). */
  onUpdateFilters: (partial: Partial<LogbookFilterState>) => void;
};
