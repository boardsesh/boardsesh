// Ambient type for the platform-split FilterChipRow so `tsc` resolves the
// extensionless `./FilterChipRow` import to this declaration, while Metro picks
// the matching FilterChipRow.ios.tsx / FilterChipRow.android.tsx at bundle time.
// Both implementations are still compiled and type-checked on their own.

import type { FC } from 'react';
import type { FilterChipRowProps } from './FilterChipRow.types';

export declare const FilterChipRow: FC<FilterChipRowProps>;
