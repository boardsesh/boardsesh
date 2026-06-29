// Shared props for the platform-split AuthTextInput. The implementation is split
// across AuthTextInput.ios.tsx (native @expo/ui SwiftUI TextField / SecureField)
// and AuthTextInput.android.tsx (native @expo/ui Jetpack Compose
// OutlinedTextField). The split keeps each platform's @expo/ui native tree —
// which resolves native views at module load — off the other platform's bundle.
// The public API is identical to the previous react-native-paper / Liquid-Glass
// implementation, so every call site (login, register, forgot/reset password,
// edit-profile) is unchanged.

import type { TextInputProps as RNTextInputProps } from 'react-native';

export type AuthTextInputProps = {
  label: string;
  value: string;
  onChangeText: (text: string) => void;
  /** Visible placeholder. iOS falls back to `label` when omitted (the native
   *  field has no floating label), so a label-only field never renders blank. */
  placeholder?: string;
  /** Translated error message — renders inline and flips the field to its error state. */
  error?: string;
  /** Translated helper text shown when there's no error (e.g. a password rule). */
  hint?: string;
  /** When true, the field is a password: it masks input. Android also shows a
   *  show/hide toggle; iOS uses a native `SecureField` (no reveal — relies on the
   *  iOS Passwords / Strong Password autofill instead). */
  secureTextEntry?: boolean;
  /** `false` makes the field non-editable: Android maps it to `readOnly` (stays
   *  legible/selectable, not greyed); iOS maps it to `disabled` (greyed). */
  editable?: boolean;
  keyboardType?: RNTextInputProps['keyboardType'];
  autoCapitalize?: RNTextInputProps['autoCapitalize'];
  autoCorrect?: boolean;
  /** Drives autofill: passed to the Android `semantics({ contentType })` modifier
   *  (the HTML-autocomplete tokens — `email`, `password`, `new-password`, `name` —
   *  the Compose ContentType mapper understands). iOS autofill rides
   *  `textContentType` instead, so this is Android-only. */
  autoComplete?: RNTextInputProps['autoComplete'];
  /** Drives iOS autofill / Strong Password via the SwiftUI `textContentType`
   *  modifier. */
  textContentType?: RNTextInputProps['textContentType'];
  returnKeyType?: RNTextInputProps['returnKeyType'];
  /** No native @expo/ui equivalent — kept for API parity but currently not
   *  applied; iOS Strong Password uses its default rules (which satisfy the
   *  8–128 length the validator enforces). */
  passwordRules?: string;
  onSubmitEditing?: () => void;
  /** Defaults to `label` so VoiceOver has a name. iOS-only: Android derives the
   *  accessible name from the visible Material floating label (the `semantics`
   *  modifier exposes only `contentType`, not `contentDescription`), so a value
   *  here differing from `label` is not applied on Android — no call site does. */
  accessibilityLabel?: string;
  /** Show-password / hide-password labels for the toggle (already translated).
   *  Android-only — the iOS native SecureField has no reveal toggle. */
  showLabel?: string;
  hideLabel?: string;
  /** Native test identifier (used by Maestro screenshot flows). Applied via the
   *  iOS `accessibilityIdentifier` / Android `testID` modifier on the field. */
  testID?: string;
};

/**
 * Imperative handle exposed via `ref` for cross-field focus chaining. The native
 * field refs (`TextFieldRef` / `SecureFieldRef` / Compose `TextFieldRef`) expose
 * an async `focus(): Promise<void>`; both platform components wrap it in this
 * synchronous shape so call sites keep calling `ref.current?.focus()` exactly as
 * they did with the old RN `TextInput` ref.
 */
export type AuthTextInputHandle = {
  focus: () => void;
};
