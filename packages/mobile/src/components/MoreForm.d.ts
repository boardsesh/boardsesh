// Ambient type for the platform-split MoreForm so `tsc` resolves the extensionless
// `./MoreForm` import to this declaration, while Metro picks the matching
// MoreForm.ios.tsx / MoreForm.android.tsx at bundle time. Both implementations are
// still compiled and type-checked on their own. Mirrors FeatureFlagsForm.d.ts.

import type { FC } from 'react';
import type { MoreFormProps } from './MoreForm.types';

export declare const MoreForm: FC<MoreFormProps>;
