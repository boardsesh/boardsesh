// Ambient type for the platform-split FeatureFlagsForm so `tsc` resolves the
// extensionless `./FeatureFlagsForm` import to this declaration, while Metro picks
// the matching FeatureFlagsForm.ios.tsx / FeatureFlagsForm.android.tsx at bundle
// time. Both implementations are still compiled and type-checked on their own.
// Mirrors the SwitchRow.d.ts mechanism.

import type { FC } from 'react';
import type { FeatureFlagsFormProps } from './FeatureFlagsForm.types';

export declare const FeatureFlagsForm: FC<FeatureFlagsFormProps>;
