// Ambient type for the platform-split AuthTextInput so `tsc` resolves the
// extensionless `./AuthTextInput` import to this declaration, while Metro picks
// the matching AuthTextInput.ios.tsx / AuthTextInput.android.tsx at bundle time.
// Both implementations are still compiled and type-checked on their own. Mirrors
// the SwitchRow.d.ts mechanism, but a `forwardRef` shape so call sites keep a
// `ref` for cross-field focus chaining.

import type { ForwardRefExoticComponent, RefAttributes } from 'react';
import type { AuthTextInputHandle, AuthTextInputProps } from './AuthTextInput.types';

export declare const AuthTextInput: ForwardRefExoticComponent<AuthTextInputProps & RefAttributes<AuthTextInputHandle>>;
