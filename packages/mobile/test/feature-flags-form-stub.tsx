// Test stub for the platform-split FeatureFlagsForm. Its iOS / Android
// implementations render native @expo/ui trees (a SwiftUI `Form` / Compose
// `LazyColumn` of cards) that can't mount under Vitest's node env, and Vitest
// doesn't resolve `.ios`/`.android` platform extensions, so any suite that
// transitively renders the Feature Flags screen redirects here via a vite alias
// (see vite.config.ts).
//
// This is a FAITHFUL PASSTHROUGH (not a null stub): it preserves the public API
// and the radio/radiogroup + button accessibility semantics with plain React
// Native primitives, so screen tests' label / role assertions keep passing.
// Component tests that assert FeatureFlagsForm internals register their own
// vi.mock, which takes precedence over this alias.

import { Pressable, Text, View } from 'react-native';
// The shared props type has no native imports, so it's safe to pull into the
// node-env stub — keeps the stub's contract from drifting from the real component.
import type { FeatureFlagsFormProps } from '../src/components/FeatureFlagsForm.types';

export function FeatureFlagsForm({ rows, onSelect, onReset, canReset, noticeText, title }: FeatureFlagsFormProps) {
  return (
    <View>
      <Text>{title}</Text>
      <Text>{noticeText}</Text>
      {rows.map((row) => (
        <View key={row.key}>
          <Text>{row.label}</Text>
          <Text>{row.description}</Text>
          <View accessibilityRole="radiogroup" accessibilityLabel={row.label}>
            {row.options.map((option) => (
              <Pressable
                key={option.key}
                onPress={() => onSelect(row.key, option.key)}
                accessibilityRole="radio"
                accessibilityState={{ selected: option.key === row.choice }}
                accessibilityLabel={option.label}
              >
                <Text>{option.label}</Text>
              </Pressable>
            ))}
          </View>
          <Text>{row.effectiveLabel}</Text>
        </View>
      ))}
      <Pressable
        onPress={onReset}
        disabled={!canReset}
        accessibilityRole="button"
        accessibilityLabel="Reset all overrides"
        accessibilityState={{ disabled: !canReset }}
      >
        <Text>Reset all overrides</Text>
      </Pressable>
    </View>
  );
}
