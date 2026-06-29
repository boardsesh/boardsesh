// Ambient type for the platform-split Button so `tsc` resolves the extensionless
// `./Button` import to this declaration, while Metro picks the matching
// Button.ios.tsx / Button.android.tsx at bundle time. Both implementations are
// still compiled and type-checked on their own. Mirrors SwitchRow.d.ts.

import type { FC } from 'react';
import type { ButtonProps } from './Button.types';

export declare const Button: FC<ButtonProps>;
