// Platform-split so @expo/ui/swift-ui (resolves native views at module load)
// never reaches the Android bundle; Android keeps the sheet's sort control.

import type { LogbookSortPreset } from '@boardsesh/logbook';

export type LogbookSortChipRowProps = {
  /** Which preset to highlight (Latest = 'recent'); null lights no chip — a
   *  non-preset sort is active. */
  preset: LogbookSortPreset | null;
  /** Live-commit a preset when its chip is tapped (persists via setPreset). */
  onSelectPreset: (preset: LogbookSortPreset) => void;
};
