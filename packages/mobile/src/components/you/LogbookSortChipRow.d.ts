// Ambient type so `tsc` resolves the extensionless `./LogbookSortChipRow` import
// while Metro picks the .ios/.android implementation at bundle time.

import type { FC } from 'react';
import type { LogbookSortChipRowProps } from './LogbookSortChipRow.types';

export declare const LogbookSortChipRow: FC<LogbookSortChipRowProps>;
