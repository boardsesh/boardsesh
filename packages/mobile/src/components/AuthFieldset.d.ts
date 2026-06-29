// Ambient type for the platform-split AuthFieldset so `tsc` resolves the
// extensionless `./AuthFieldset` import to this declaration, while Metro picks the
// matching AuthFieldset.ios.tsx / AuthFieldset.android.tsx at bundle time. Both
// implementations are still compiled and type-checked on their own. Mirrors the
// SwitchRow.d.ts mechanism.

import type { FC } from 'react';
import type { AuthFieldsetProps } from './AuthFieldset.types';

export declare const AuthFieldset: FC<AuthFieldsetProps>;
