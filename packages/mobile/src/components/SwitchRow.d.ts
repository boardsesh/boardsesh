// Ambient type for the platform-split SwitchRow so `tsc` resolves the
// extensionless `./SwitchRow` import to this declaration, while Metro picks the
// matching SwitchRow.ios.tsx / SwitchRow.android.tsx at bundle time. Both
// implementations are still compiled and type-checked on their own. Mirrors the
// CapsuleRow.d.ts mechanism.

import type { FC } from 'react';
import type { SwitchRowProps } from './SwitchRow.types';

export declare const SwitchRow: FC<SwitchRowProps>;
