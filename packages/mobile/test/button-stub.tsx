// Test stub for the platform-split Button. Its iOS / Android implementations
// render native @expo/ui trees (SwiftUI Button / Compose Button) that can't mount
// under Vitest's node env, and Vitest doesn't resolve `.ios`/`.android` platform
// extensions, so any suite that transitively renders a Button redirects here via a
// vite alias (see vite.config.ts). Button is the most-rendered primitive, so a lot
// of screen/sheet suites hit this.
//
// This is a FAITHFUL PASSTHROUGH (not a null stub): it preserves the public API
// and the `button` accessibility semantics with plain React Native primitives, so
// indirect screen tests keep their label / role / press assertions passing.
// Component tests that assert Button internals register their own vi.mock, which
// takes precedence over this alias.

import { Pressable, Text } from 'react-native';
// The shared props type has no native imports (icon-map is a type-only import),
// so it's safe to pull into the node-env stub — keeps the stub's contract from
// drifting from the real component.
import type { ButtonProps } from '../src/components/Button.types';

export function Button({ title, onPress, accessibilityLabel, disabled = false, loading = false, testID }: ButtonProps) {
  const handlePress = () => {
    if (disabled || loading) return;
    onPress();
  };

  return (
    <Pressable
      onPress={handlePress}
      disabled={disabled || loading}
      accessibilityRole="button"
      accessibilityState={{ disabled: disabled || loading }}
      accessibilityLabel={accessibilityLabel ?? title}
      testID={testID}
    >
      <Text>{title}</Text>
    </Pressable>
  );
}
