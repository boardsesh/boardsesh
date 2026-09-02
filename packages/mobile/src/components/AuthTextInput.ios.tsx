// AuthTextInput — iOS implementation, real SwiftUI via @expo/ui/swift-ui.
//
// A native SwiftUI `TextField` (or `SecureField` for passwords) inside its own
// `Host`, with the inline error/hint as a sibling RN `<Text>` below it. The
// platform supplies the keyboard, caret, selection handles, autofill / Strong
// Password (via the `textContentType` modifier), and VoiceOver field behaviour.
// We bridge the brand tint, the keyboard/content-type/submit modifiers, the
// accessibility label + test identifier, and the disabled state.
//
// DELIBERATE iOS DECISIONS (see issue #3266, confirmed with the maintainer):
//   • No password reveal toggle. SwiftUI `SecureField` exposes no reveal prop,
//     and swapping SecureField↔TextField to fake one would remount the field,
//     dropping focus + the Keychain/Strong-Password association mid-edit. We
//     drop the toggle on iOS and lean on the iOS Passwords / Strong Password
//     autofill. Android keeps its toggle (`visualTransformation`, no remount).
//   • System `roundedBorder` look instead of the old custom white-in-dark-mode
//     field — the field now follows system colours like the rest of native iOS.
//   • Error is conveyed by the sibling red `<Text>` (a live region), not a native
//     field-error style — SwiftUI text fields have no `isError`. (Android uses the
//     native M3 `isError` + supporting text.)
//
// One Host per field is intentional (these are one-per-row, like SwitchRow).

import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, type RefObject } from 'react';
import { StyleSheet, View } from 'react-native';
// useNativeState comes from the platform module (not the @expo/ui root) so its
// ObservableState type matches the field's `text` prop — the root re-export
// resolves to the universal, simplified ObservableState that doesn't.
import { TextField, SecureField, useNativeState, type TextFieldRef, type SecureFieldRef } from '@expo/ui/swift-ui';
import {
  accessibilityIdentifier,
  accessibilityLabel as accessibilityLabelModifier,
  autocorrectionDisabled,
  disabled as disabledModifier,
  frame,
  keyboardType as keyboardTypeModifier,
  onSubmit as onSubmitModifier,
  submitLabel as submitLabelModifier,
  textContentType as textContentTypeModifier,
  textFieldStyle,
  textInputAutocapitalization,
  tint,
} from '@expo/ui/swift-ui/modifiers';
import { useTheme } from '../providers/theme-provider';
import { ThemedHost } from './ThemedHost';
import { brandAccentColor } from '../theme/expo-ui-modifiers';
import { iosSystemColors } from '../theme/ios-colors';
import { Text } from './Text';
import {
  shouldPushValueToNative,
  toIosAutocapitalization,
  toIosKeyboardType,
  toIosSubmitLabel,
  toIosTextContentType,
} from './AuthTextInput.logic';
import type { AuthTextInputHandle, AuthTextInputProps } from './AuthTextInput.types';

// Floor the field height so the native Host's matchContents (which under-reports
// the field's intrinsic height to RN) can't squish or clip the field + focus ring.
const HOST_MIN_HEIGHT = 44;

export const AuthTextInput = forwardRef<AuthTextInputHandle, AuthTextInputProps>(function AuthTextInput(
  {
    label,
    value,
    onChangeText,
    placeholder,
    error,
    hint,
    secureTextEntry = false,
    editable = true,
    keyboardType,
    autoCapitalize,
    autoCorrect,
    textContentType,
    returnKeyType,
    onSubmitEditing,
    accessibilityLabel,
    testID,
  },
  ref,
) {
  const { brandColors, systemColors } = useTheme();
  const textState = useNativeState(value);
  const lastEmittedRef = useRef(value);
  const fieldRef = useRef<TextFieldRef | SecureFieldRef>(null);

  // Push external value changes (e.g. EditProfile seeding the email once the
  // profile resolves) into the native observable. Our own edits already echo
  // back via onTextChange, so the guard stops a caret-jump/feedback loop.
  // `textState` is a stable ref from useNativeState (captured once), so this
  // effect runs only when `value` changes.
  useEffect(() => {
    if (shouldPushValueToNative(value, lastEmittedRef.current)) {
      lastEmittedRef.current = value;
      textState.set(value);
    }
  }, [value, textState]);

  useImperativeHandle(
    ref,
    () => ({
      focus: () => {
        void fieldRef.current?.focus();
      },
    }),
    [],
  );

  const handleTextChange = useCallback(
    (text: string) => {
      lastEmittedRef.current = text;
      onChangeText(text);
    },
    [onChangeText],
  );

  const a11yLabel = accessibilityLabel ?? label;
  const iosKeyboardType = toIosKeyboardType(keyboardType);
  const iosContentType = toIosTextContentType(textContentType);
  const iosAutocaps = toIosAutocapitalization(autoCapitalize);
  const iosSubmitLabel = toIosSubmitLabel(returnKeyType);

  const modifiers = [
    textFieldStyle('roundedBorder'),
    // Floor the field's intrinsic height at the native level so the Host's
    // matchContents reports a value that can't squish/clip the field. The RN
    // Host-style minHeight alone proved unreliable under matchContents — the
    // native Host under-reports height and the style floor didn't apply (see
    // SegmentedControl.ios.tsx); a SwiftUI frame floors the view itself.
    frame({ minHeight: HOST_MIN_HEIGHT }),
    tint(brandAccentColor(brandColors)),
    // Name the field for VoiceOver (these fields have no visible label, only the
    // placeholder) and expose the test identifier for Maestro/QA.
    accessibilityLabelModifier(a11yLabel),
    ...(testID ? [accessibilityIdentifier(testID)] : []),
    ...(iosKeyboardType ? [keyboardTypeModifier(iosKeyboardType)] : []),
    // Drives iOS autofill / Strong Password.
    ...(iosContentType ? [textContentTypeModifier(iosContentType)] : []),
    ...(iosAutocaps ? [textInputAutocapitalization(iosAutocaps)] : []),
    ...(autoCorrect === false ? [autocorrectionDisabled(true)] : []),
    ...(iosSubmitLabel ? [submitLabelModifier(iosSubmitLabel)] : []),
    ...(onSubmitEditing ? [onSubmitModifier(() => onSubmitEditing())] : []),
    // SwiftUI greys the field and blocks interaction natively. `editable={false}`
    // is the read-only email + the busy-lockout-during-submit; both are fine greyed.
    // Conditionally spread (like the rest) so an editable field sends no no-op modifier.
    ...(editable ? [] : [disabledModifier(true)]),
  ];

  // The placeholder is the field's only on-screen text (no floating label on
  // iOS), so fall back to the label when none is given — otherwise label-only
  // fields (reset-password, the read-only email) would render as blank boxes.
  const visiblePlaceholder = placeholder ?? label;

  return (
    <View>
      <ThemedHost matchContents={{ vertical: true }} style={styles.host}>
        {secureTextEntry ? (
          <SecureField
            ref={fieldRef as RefObject<SecureFieldRef>}
            text={textState}
            placeholder={visiblePlaceholder}
            onTextChange={handleTextChange}
            modifiers={modifiers}
          />
        ) : (
          <TextField
            ref={fieldRef as RefObject<TextFieldRef>}
            text={textState}
            placeholder={visiblePlaceholder}
            onTextChange={handleTextChange}
            modifiers={modifiers}
          />
        )}
      </ThemedHost>
      {error ? (
        <Text
          variant="footnote"
          style={[styles.message, { color: iosSystemColors.systemRed }]}
          accessibilityLiveRegion="polite"
        >
          {error}
        </Text>
      ) : hint ? (
        <Text variant="footnote" color={systemColors.secondaryLabel} style={styles.message}>
          {hint}
        </Text>
      ) : null}
    </View>
  );
});

const styles = StyleSheet.create({
  host: { width: '100%', minHeight: HOST_MIN_HEIGHT },
  message: { marginTop: 4 },
});
