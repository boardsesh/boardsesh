// Ambient type for the platform-split LogbookSortChipRow so `tsc` resolves the
// extensionless `./LogbookSortChipRow` import to this declaration, while Metro
// picks the matching LogbookSortChipRow.ios.tsx / LogbookSortChipRow.android.tsx
// at bundle time. Both implementations are still compiled and type-checked on
// their own.

import type { FC } from 'react';
import type { LogbookSortChipRowProps } from './LogbookSortChipRow.types';

export declare const LogbookSortChipRow: FC<LogbookSortChipRowProps>;
