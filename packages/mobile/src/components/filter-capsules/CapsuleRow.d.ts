// Ambient type for the platform-split CapsuleRow so `tsc` resolves the
// extensionless `./CapsuleRow` import to this declaration, while Metro picks
// CapsuleRow.ios.tsx / CapsuleRow.android.tsx / CapsuleRow.web.tsx at bundle
// time. Each implementation is still compiled and type-checked on its own.

import type { FC } from 'react';
import type { CapsuleRowProps } from './CapsuleRow.types';

export declare const CapsuleRow: FC<CapsuleRowProps>;
