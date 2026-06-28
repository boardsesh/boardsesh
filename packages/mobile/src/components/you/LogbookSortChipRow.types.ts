// Shared props for the logbook sort-chip row. The implementation is
// platform-split: LogbookSortChipRow.ios.tsx renders native @expo/ui SwiftUI
// glass chips, LogbookSortChipRow.android.tsx is a placeholder (Android keeps
// the sheet's sort control). The split keeps @expo/ui/swift-ui — whose
// components resolve native views at module load — off the Android bundle path.

import type { LogbookSortPreset } from '@boardsesh/logbook';

export type LogbookSortChipRowProps = {
  /** The committed sort preset: Latest = 'recent', Hardest = 'hardest'. */
  preset: LogbookSortPreset;
  /** Live-commit a preset when its chip is tapped (persists via setPreset). */
  onSelectPreset: (preset: LogbookSortPreset) => void;
};
