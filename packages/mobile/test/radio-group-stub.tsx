// Test stub for the platform-split RadioGroup. Its iOS / Android implementations
// render native @expo/ui trees (a SwiftUI inline Picker / Compose RadioButton
// group) that can't mount under Vitest's node env, and Vitest doesn't resolve
// `.ios`/`.android` platform extensions, so any suite that transitively renders a
// RadioGroup redirects here via a vite alias (see vite.config.ts).
//
// This is a FAITHFUL PASSTHROUGH (not a null stub): it preserves the public API
// and the `radio`/`radiogroup` accessibility semantics with plain React Native
// primitives, so indirect screen tests keep their label / role assertions passing
// unchanged. Component tests that assert RadioGroup internals register their own
// vi.mock, which takes precedence over this alias.

import { Pressable, Text, View } from 'react-native';
// The shared props type has no native imports, so it's safe to pull into the
// node-env stub — keeps the stub's contract from drifting from the real component.
import type { RadioGroupProps } from '../src/components/RadioGroup.types';

export function RadioGroup<T extends string>({ options, value, onChange }: RadioGroupProps<T>) {
  return (
    <View accessibilityRole="radiogroup">
      {options.map((option) => {
        const selected = option.value === value;
        const disabled = option.disabled ?? false;
        return (
          <Pressable
            key={option.value}
            onPress={() => {
              if (disabled) return;
              onChange(option.value);
            }}
            disabled={disabled}
            accessibilityRole="radio"
            accessibilityState={{ selected, disabled }}
            accessibilityLabel={option.label}
          >
            <Text>{option.label}</Text>
            {option.description ? <Text>{option.description}</Text> : null}
          </Pressable>
        );
      })}
    </View>
  );
}
