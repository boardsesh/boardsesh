// AuthTextInput — web implementation (react-native-web + react-native-paper). On
// web the app renders the Material variant, so this is a Material 3 outlined
// TextInput — the same look as the Compose `OutlinedTextField` in
// AuthTextInput.android.tsx: floating label, error + supporting text, password
// masking with a trailing reveal toggle.
//
// react-native-web maps the underlying RN `TextInput` onto a real DOM <input>, so
// the keyboard, caret, selection, and browser/password-manager autofill (via
// `autoComplete` / `textContentType`) come from the platform. The password reveal
// toggle is kept (Android keeps it too): flipping `secureTextEntry` is a display
// change on the same field, so it doesn't remount/refocus. The controlled-value
// bridge the native files need doesn't apply here — a DOM <input> is already a
// controlled `value`/`onChangeText` field — so `AuthTextInput.logic`'s
// `computeMasked` is the only shared helper this file reuses.

import { forwardRef, useImperativeHandle, useRef, useState } from 'react';
import { StyleSheet, View, type TextInput as RNTextInput } from 'react-native';
import { HelperText, TextInput as PaperTextInput } from 'react-native-paper';
import { computeMasked } from './AuthTextInput.logic';
import type { AuthTextInputHandle, AuthTextInputProps } from './AuthTextInput.types';

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
    autoComplete,
    textContentType,
    returnKeyType,
    onSubmitEditing,
    accessibilityLabel,
    testID,
    showLabel = 'Show password',
    hideLabel = 'Hide password',
  },
  ref,
) {
  // Paper's TextInput `ref` prop is the intersection of `Ref<TextInputHandles>`
  // and the native `Ref<TextInput>` it inherits via `ComponentPropsWithRef`, so a
  // bare `ComponentRef<typeof PaperTextInput>` (which resolves to only
  // `TextInputHandles`) doesn't satisfy it. The RN `TextInput` instance is
  // assignable to both, and it carries the `focus()` the imperative handle needs.
  const fieldRef = useRef<RNTextInput>(null);
  const [revealed, setRevealed] = useState(false);
  const masked = computeMasked(secureTextEntry, revealed);
  const supportingText = error ?? hint;

  // Call sites keep calling `ref.current?.focus()` for cross-field chaining; Paper's
  // TextInput ref exposes the native `focus()`.
  useImperativeHandle(
    ref,
    () => ({
      focus: () => fieldRef.current?.focus(),
    }),
    [],
  );

  return (
    <View style={styles.container}>
      <PaperTextInput
        ref={fieldRef}
        mode="outlined"
        label={label}
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        error={Boolean(error)}
        secureTextEntry={masked}
        // RN `editable={false}` stays legible/selectable (the read-only email + the
        // busy-lockout-during-submit) rather than greying out like `disabled` — the
        // same intent as Compose `readOnly` on Android.
        editable={editable}
        keyboardType={keyboardType}
        autoCapitalize={autoCapitalize}
        autoCorrect={autoCorrect}
        autoComplete={autoComplete}
        textContentType={textContentType}
        returnKeyType={returnKeyType}
        onSubmitEditing={onSubmitEditing}
        accessibilityLabel={accessibilityLabel ?? label}
        testID={testID}
        right={
          secureTextEntry ? (
            <PaperTextInput.Icon
              icon={revealed ? 'eye-off' : 'eye'}
              onPress={() => setRevealed((previous) => !previous)}
              accessibilityLabel={revealed ? hideLabel : showLabel}
              forceTextInputFocus={false}
            />
          ) : undefined
        }
      />
      {supportingText ? (
        <HelperText type={error ? 'error' : 'info'} visible>
          {supportingText}
        </HelperText>
      ) : null}
    </View>
  );
});

const styles = StyleSheet.create({
  container: {
    width: '100%',
  },
});
