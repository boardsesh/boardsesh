// Shared props for the platform-split AuthFieldset — a GROUP of auth fields
// rendered together so iOS Password AutoFill can pair the username/email field
// with the password field. (iOS pairs credential fields only within one view
// hierarchy; the per-field AuthTextInput renders each field in its own @expo/ui
// `Host`/UIHostingController, which unpaired them — password filled, email
// didn't. AuthFieldset.ios.tsx puts every field in ONE Host so the pairing
// works again.) Android has no such constraint, so AuthFieldset.android.tsx just
// reuses the per-field AuthTextInput.
//
// Use this for credential forms (login, register, reset-password). For a lone,
// non-credential field (e.g. edit-profile's display name + read-only email) keep
// using AuthTextInput directly.

import type { AuthTextInputProps } from './AuthTextInput.types';

/**
 * One field in the set. Same shape as `AuthTextInput`, minus the props the
 * fieldset owns: focus chaining (`onSubmitEditing`) and the return key
 * (`returnKeyType`) are derived from field order — every field but the last gets
 * "next" and advances focus; the last gets "done" and triggers `onSubmit`.
 */
export type AuthFieldSpec = Omit<AuthTextInputProps, 'onSubmitEditing' | 'returnKeyType'> & {
  /** Stable identity for the field (React key + focus-chain index). */
  key: string;
};

export type AuthFieldsetProps = {
  fields: AuthFieldSpec[];
  /** Fired when the last field's return key ("done") is pressed. */
  onSubmit?: () => void;
};
