// Android placeholder for the persistent filter-chip row. The native row is
// SwiftUI-only (FilterChipRow.ios.tsx); the Material counterpart will be built
// on @expo/ui jetpack-compose (Chip + DropdownMenu + Switch) in a follow-up.
// Until then the chip row is a no-op on Android — the caller only mounts it on
// Liquid Glass (showFilterChips), so this never renders, but it keeps
// @expo/ui/swift-ui (which resolves native views at module load) off the Android
// bundle.

import type { FilterChipRowProps } from './FilterChipRow.types';

export function FilterChipRow(_props: FilterChipRowProps): null {
  return null;
}
