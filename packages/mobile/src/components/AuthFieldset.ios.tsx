// AuthFieldset — iOS implementation, real SwiftUI via @expo/ui/swift-ui.
//
// THE iOS AUTOFILL FIX: every field renders inside ONE `Host` (a single SwiftUI
// view tree / UIHostingController), as a `VStack` of `TextField`/`SecureField`s.
// iOS Password AutoFill pairs a username/email field with a password field only
// within one view hierarchy — the per-field `AuthTextInput` put each field in its
// own Host, which unpaired them (AutoFill filled the password but not the email).
// Grouping them here restores the native paired fill, the same way a hand-written
// SwiftUI login form does.
//
// Each field is its own child component (`AuthField`) so its per-field hooks
// (`useNativeState`, refs) are legal — mapping hooks inline would break the rules
// of hooks. Focus chaining is internal: every field but the last submits "next"
// and focuses the following field; the last submits "done" and calls `onSubmit`.
//
// iOS deliberately has no reveal toggle (SecureField has none — see
// AuthTextInput.ios.tsx); error/hint render as SwiftUI Text inside the VStack
// (red / hierarchical-secondary), so they can sit between fields in the one Host.

import { useCallback, useEffect, useRef, type RefObject } from 'react';
import { AccessibilityInfo, StyleSheet } from 'react-native';
import {
  TextField,
  SecureField,
  VStack,
  Text as SwiftUIText,
  useNativeState,
  type TextFieldRef,
  type SecureFieldRef,
} from '@expo/ui/swift-ui';
import {
  accessibilityIdentifier,
  accessibilityLabel as accessibilityLabelModifier,
  autocorrectionDisabled,
  disabled as disabledModifier,
  foregroundStyle,
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
import {
  shouldPushValueToNative,
  toIosAutocapitalization,
  toIosKeyboardType,
  toIosTextContentType,
} from './AuthTextInput.logic';
import type { AuthFieldSpec, AuthFieldsetProps } from './AuthFieldset.types';

// Floor each field's intrinsic height at the native level (see AuthTextInput.ios).
const FIELD_MIN_HEIGHT = 44;

type AuthFieldProps = {
  spec: AuthFieldSpec;
  index: number;
  isLast: boolean;
  registerFocus: (index: number, focus: (() => void) | undefined) => void;
  onAdvance: (index: number) => void;
};

function AuthField({ spec, index, isLast, registerFocus, onAdvance }: AuthFieldProps) {
  const { brandColors } = useTheme();
  const textState = useNativeState(spec.value);
  const lastEmittedRef = useRef(spec.value);
  const fieldRef = useRef<TextFieldRef | SecureFieldRef>(null);
  const { onChangeText } = spec;

  // Push external value changes (e.g. a seeded value) into the native observable;
  // our own edits echo back via onTextChange, so the guard stops a caret loop.
  // textState is a stable ref from useNativeState, so this runs only on value change.
  useEffect(() => {
    if (shouldPushValueToNative(spec.value, lastEmittedRef.current)) {
      lastEmittedRef.current = spec.value;
      textState.set(spec.value);
    }
  }, [spec.value, textState]);

  // Register this field's focuser so the previous field's return key can advance
  // to it; clear on unmount.
  useEffect(() => {
    registerFocus(index, () => {
      void fieldRef.current?.focus();
    });
    return () => registerFocus(index, undefined);
  }, [index, registerFocus]);

  // Parity with the old per-field RN error (accessibilityLiveRegion="polite"):
  // the error renders as SwiftUI Text, which can't be a VoiceOver live region, so
  // announce a newly-shown/changed error explicitly.
  //
  // Seeding the ref with spec.error means an error already present on first render
  // is intentionally NOT announced on mount. That's correct for auth flows, where
  // errors only surface after the user interacts (submit/validation) — never
  // pre-seeded — so this avoids announcing stale validation as the screen appears.
  const previousErrorRef = useRef(spec.error);
  useEffect(() => {
    if (spec.error && spec.error !== previousErrorRef.current) {
      AccessibilityInfo.announceForAccessibility(spec.error);
    }
    previousErrorRef.current = spec.error;
  }, [spec.error]);

  const handleTextChange = useCallback(
    (text: string) => {
      lastEmittedRef.current = text;
      onChangeText(text);
    },
    [onChangeText],
  );

  const editable = spec.editable ?? true;
  const a11yLabel = spec.accessibilityLabel ?? spec.label;
  const iosKeyboardType = toIosKeyboardType(spec.keyboardType);
  const iosContentType = toIosTextContentType(spec.textContentType);
  const iosAutocaps = toIosAutocapitalization(spec.autoCapitalize);
  // The placeholder is the field's only on-screen text (no floating label on iOS),
  // so fall back to the label so a label-only field never renders blank.
  const placeholder = spec.placeholder ?? spec.label;

  const modifiers = [
    textFieldStyle('roundedBorder'),
    frame({ minHeight: FIELD_MIN_HEIGHT }),
    tint(brandAccentColor(brandColors)),
    accessibilityLabelModifier(a11yLabel),
    ...(spec.testID ? [accessibilityIdentifier(spec.testID)] : []),
    ...(iosKeyboardType ? [keyboardTypeModifier(iosKeyboardType)] : []),
    // Drives iOS autofill / Strong Password (paired with the other fields in this Host).
    ...(iosContentType ? [textContentTypeModifier(iosContentType)] : []),
    ...(iosAutocaps ? [textInputAutocapitalization(iosAutocaps)] : []),
    ...(spec.autoCorrect === false ? [autocorrectionDisabled(true)] : []),
    // Return-key chaining: derived from field order (next → focus the next field; done → submit).
    submitLabelModifier(isLast ? 'done' : 'next'),
    onSubmitModifier(() => onAdvance(index)),
    ...(editable ? [] : [disabledModifier(true)]),
  ];

  return (
    <VStack alignment="leading" spacing={4}>
      {spec.secureTextEntry ? (
        <SecureField
          ref={fieldRef as RefObject<SecureFieldRef>}
          text={textState}
          placeholder={placeholder}
          onTextChange={handleTextChange}
          modifiers={modifiers}
        />
      ) : (
        <TextField
          ref={fieldRef as RefObject<TextFieldRef>}
          text={textState}
          placeholder={placeholder}
          onTextChange={handleTextChange}
          modifiers={modifiers}
        />
      )}
      {spec.error ? (
        <SwiftUIText modifiers={[foregroundStyle(iosSystemColors.systemRed)]}>{spec.error}</SwiftUIText>
      ) : spec.hint ? (
        <SwiftUIText modifiers={[foregroundStyle({ type: 'hierarchical', style: 'secondary' })]}>
          {spec.hint}
        </SwiftUIText>
      ) : null}
    </VStack>
  );
}

export function AuthFieldset({ fields, onSubmit }: AuthFieldsetProps) {
  // One array of focusers keeps chaining off the hooks-in-a-loop footgun.
  const focusers = useRef<Array<(() => void) | undefined>>([]);
  const registerFocus = useCallback((index: number, focus: (() => void) | undefined) => {
    focusers.current[index] = focus;
  }, []);
  const onAdvance = useCallback(
    (index: number) => {
      const next = focusers.current[index + 1];
      if (next) next();
      else onSubmit?.();
    },
    [onSubmit],
  );
  const lastIndex = fields.length - 1;

  return (
    <ThemedHost matchContents={{ vertical: true }} style={styles.host}>
      <VStack alignment="leading" spacing={12}>
        {fields.map((spec, index) => (
          <AuthField
            key={spec.key}
            spec={spec}
            index={index}
            isLast={index === lastIndex}
            registerFocus={registerFocus}
            onAdvance={onAdvance}
          />
        ))}
      </VStack>
    </ThemedHost>
  );
}

const styles = StyleSheet.create({
  host: { width: '100%' },
});
