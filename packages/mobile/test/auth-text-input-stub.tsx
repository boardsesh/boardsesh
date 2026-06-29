// Test stub for the platform-split AuthTextInput. Its iOS / Android
// implementations render native @expo/ui trees (SwiftUI TextField/SecureField /
// Compose OutlinedTextField) that can't mount under Vitest's node env, and Vitest
// doesn't resolve `.ios`/`.android` platform extensions, so any suite that
// transitively renders AuthTextInput redirects here via a vite alias (see
// vite.config.ts).
//
// This is a FAITHFUL PASSTHROUGH (not a null stub): plain React Native primitives
// preserving the public API, the `ref.focus()` handle, the `testID`s, the
// accessibility label, the password reveal toggle, and the inline error/hint —
// so screen tests keep their label / role / focus assertions passing. Component
// tests that assert AuthTextInput internals register their own vi.mock, which
// takes precedence over this alias.

import { forwardRef, useImperativeHandle, useRef, useState } from 'react';
import { Pressable, TextInput as RNTextInput, Text, View } from 'react-native';
// The shared props type has no native imports, so it's safe to pull into the
// node-env stub — keeps the stub's contract from drifting from the real component.
import type { AuthTextInputHandle, AuthTextInputProps } from '../src/components/AuthTextInput.types';

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
    accessibilityLabel,
    showLabel = 'Show password',
    hideLabel = 'Hide password',
    testID,
    onSubmitEditing,
  },
  ref,
) {
  const inputRef = useRef<RNTextInput>(null);
  const [revealed, setRevealed] = useState(false);

  useImperativeHandle(ref, () => ({ focus: () => inputRef.current?.focus() }), []);

  return (
    <View>
      <RNTextInput
        ref={inputRef}
        testID={testID}
        accessibilityLabel={accessibilityLabel ?? label}
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        editable={editable}
        secureTextEntry={secureTextEntry && !revealed}
        onSubmitEditing={onSubmitEditing}
      />
      {secureTextEntry ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={revealed ? hideLabel : showLabel}
          accessibilityState={{ selected: revealed }}
          onPress={() => setRevealed((prev) => !prev)}
        >
          <Text>{revealed ? hideLabel : showLabel}</Text>
        </Pressable>
      ) : null}
      {error ? <Text accessibilityLiveRegion="polite">{error}</Text> : hint ? <Text>{hint}</Text> : null}
    </View>
  );
});
