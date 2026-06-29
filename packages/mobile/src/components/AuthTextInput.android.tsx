// AuthTextInput — Android implementation, real Jetpack Compose via
// @expo/ui/jetpack-compose.
//
// A Material 3 `OutlinedTextField` inside its own `Host`, with the native
// floating label, `isError` + supporting text, and password masking via
// `visualTransformation`. The platform supplies the keyboard, caret, selection,
// and TalkBack field behaviour; autofill is wired through the
// `semantics({ contentType })` modifier (Google Autofill / password managers).
// This drops `react-native-paper` for these fields. We bridge the brand focused
// outline + cursor colour and the test identifier.
//
// Unlike iOS, the password reveal toggle is KEPT here: `visualTransformation` is
// a display prop on the same field, so flipping it doesn't remount/refocus. The
// toggle lives in the native `TrailingIcon` slot as an `IconButton`.
//
// One Host per field is intentional (these are one-per-row, like SwitchRow).

import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type ComponentProps,
} from 'react';
import { StyleSheet } from 'react-native';
import { Host } from '@expo/ui';
// useNativeState comes from the platform module (not the @expo/ui root) so its
// ObservableState type matches the field's `value` prop — the root re-export
// resolves to the universal, simplified ObservableState that doesn't.
import { Icon, IconButton, OutlinedTextField, Text, useNativeState } from '@expo/ui/jetpack-compose';
import { semantics, testID as testIDModifier } from '@expo/ui/jetpack-compose/modifiers';
import { useTheme } from '../providers/theme-provider';
import { textFieldBrandColors } from '../theme/expo-ui-modifiers';
import {
  computeMasked,
  shouldPushValueToNative,
  toAndroidContentType,
  toAndroidKeyboardOptions,
} from './AuthTextInput.logic';
import type { AuthTextInputHandle, AuthTextInputProps } from './AuthTextInput.types';

// Material XML vector drawables, bundled as ASSETS (metro.config.js adds `xml` to
// resolver.assetExts). White-filled so the Compose `Icon` recolours them to the
// field's trailing content colour (tint omitted → inherits LocalContentColor).
const EYE_ICON = require('../../assets/material-icons/visibility.xml');
const EYE_OFF_ICON = require('../../assets/material-icons/visibilityOff.xml');

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
    returnKeyType,
    onSubmitEditing,
    testID,
    showLabel = 'Show password',
    hideLabel = 'Hide password',
  },
  ref,
) {
  const { brandColors } = useTheme();
  const textState = useNativeState(value);
  const lastEmittedRef = useRef(value);
  const fieldRef = useRef<{ focus: () => Promise<void> }>(null);
  const [revealed, setRevealed] = useState(false);
  const masked = computeMasked(secureTextEntry, revealed);

  // Push external value changes (e.g. EditProfile seeding the email once the
  // profile resolves) into the native observable. Our own edits already echo
  // back via onValueChange, so the guard stops a caret-jump/feedback loop.
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

  const keyboardOptions = toAndroidKeyboardOptions({
    keyboardType,
    autoCapitalize,
    autoCorrect,
    returnKeyType,
    secureTextEntry,
  });
  // Only the action matching keyboardOptions.imeAction fires, so wiring both is safe.
  // Memoized so the native Host isn't handed a fresh object every render.
  const keyboardActions = useMemo(
    () => (onSubmitEditing ? { onNext: () => onSubmitEditing(), onDone: () => onSubmitEditing() } : undefined),
    [onSubmitEditing],
  );
  const contentType = toAndroidContentType(autoComplete);
  const supportingText = error ?? hint;

  return (
    <Host matchContents={{ vertical: true }} style={styles.host}>
      <OutlinedTextField
        ref={fieldRef as unknown as ComponentProps<typeof OutlinedTextField>['ref']}
        value={textState}
        onValueChange={handleTextChange}
        isError={Boolean(error)}
        // RN `editable={false}` is non-editable but legible/selectable (the
        // read-only email + the busy-lockout-during-submit) — Compose `readOnly`,
        // NOT `enabled={false}` which would grey it out and remove selection.
        readOnly={!editable}
        singleLine
        visualTransformation={masked ? 'password' : 'none'}
        keyboardOptions={keyboardOptions}
        keyboardActions={keyboardActions}
        colors={textFieldBrandColors(brandColors)}
        modifiers={[
          // Autofill (Google Autofill / password managers).
          ...(contentType ? [semantics({ contentType })] : []),
          // Test identifier for Maestro/QA (OutlinedTextField has no testID prop).
          ...(testID ? [testIDModifier(testID)] : []),
        ]}
      >
        <OutlinedTextField.Label>
          <Text>{label}</Text>
        </OutlinedTextField.Label>
        {placeholder ? (
          <OutlinedTextField.Placeholder>
            <Text>{placeholder}</Text>
          </OutlinedTextField.Placeholder>
        ) : null}
        {supportingText ? (
          <OutlinedTextField.SupportingText>
            <Text>{supportingText}</Text>
          </OutlinedTextField.SupportingText>
        ) : null}
        {secureTextEntry ? (
          <OutlinedTextField.TrailingIcon>
            <IconButton onClick={() => setRevealed((prev) => !prev)}>
              <Icon source={revealed ? EYE_OFF_ICON : EYE_ICON} contentDescription={revealed ? hideLabel : showLabel} />
            </IconButton>
          </OutlinedTextField.TrailingIcon>
        ) : null}
      </OutlinedTextField>
    </Host>
  );
});

const styles = StyleSheet.create({
  host: { width: '100%' },
});
