// Test stub for the platform-split AuthFieldset. Its iOS / Android impls render
// native @expo/ui trees that can't mount under Vitest's node env (and Vitest
// doesn't resolve `.ios`/`.android`), so any suite that transitively renders
// AuthFieldset redirects here via a vite alias (see vite.config.ts).
//
// Faithful passthrough: plain RN primitives preserving the public API, the
// per-field testID / accessibility label / error / hint, and the return-key focus
// chain (each field advances to the next; the last submits) — so screen tests
// asserting label/role/focus pass. (No reveal toggle: it's an Android-only
// interactive detail of the real field, not modelled by this node-env stub.)

import { useRef } from 'react';
import { TextInput as RNTextInput, Text, View } from 'react-native';
import type { AuthFieldsetProps } from '../src/components/AuthFieldset.types';

export function AuthFieldset({ fields, onSubmit }: AuthFieldsetProps) {
  const refs = useRef<Array<RNTextInput | null>>([]);
  const lastIndex = fields.length - 1;

  return (
    <View>
      {fields.map((field, index) => {
        const isLast = index === lastIndex;
        return (
          <View key={field.key}>
            <RNTextInput
              ref={(node) => {
                refs.current[index] = node;
              }}
              testID={field.testID}
              accessibilityLabel={field.accessibilityLabel ?? field.label}
              value={field.value}
              onChangeText={field.onChangeText}
              placeholder={field.placeholder ?? field.label}
              editable={field.editable ?? true}
              secureTextEntry={field.secureTextEntry}
              returnKeyType={isLast ? 'done' : 'next'}
              onSubmitEditing={() => {
                if (isLast) onSubmit?.();
                else refs.current[index + 1]?.focus();
              }}
            />
            {field.error ? (
              <Text accessibilityLiveRegion="polite">{field.error}</Text>
            ) : field.hint ? (
              <Text>{field.hint}</Text>
            ) : null}
          </View>
        );
      })}
    </View>
  );
}
