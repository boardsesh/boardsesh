// Android placeholder for the logbook sort-chip row. The native row is
// SwiftUI-only (LogbookSortChipRow.ios.tsx); Android keeps the sort control
// inside LogbookFilterSheet, so the chip row is a no-op here. The caller only
// mounts it on Liquid Glass (iOS), so this never renders — but it keeps
// @expo/ui/swift-ui (which resolves native views at module load) off the
// Android bundle.

import type { LogbookSortChipRowProps } from './LogbookSortChipRow.types';

export function LogbookSortChipRow(_props: LogbookSortChipRowProps): null {
  return null;
}
