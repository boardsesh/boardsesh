// Ambient type for the platform-split RadioGroup so `tsc` resolves the
// extensionless `./RadioGroup` import to this declaration, while Metro picks the
// matching RadioGroup.ios.tsx / RadioGroup.android.tsx at bundle time. Both
// implementations are still compiled and type-checked on their own. Declared as a
// generic function so the `<T extends string>` option-value type flows through at
// every call site (mirrors SegmentedControl.d.ts). Re-exports `RadioOption` so the
// `index.ts` `export { RadioGroup, type RadioOption } from './RadioGroup'` resolves.

import type { JSX } from 'react';
import type { RadioGroupProps } from './RadioGroup.types';

export declare function RadioGroup<T extends string>(props: RadioGroupProps<T>): JSX.Element;
export type { RadioOption } from './RadioGroup.types';
