// Test stub for the platform-split AppMenu. Its iOS / Android implementations render
// native @expo/ui trees (a SwiftUI `Menu` / a Compose `DropdownMenu`) that can't
// mount under Vitest's node env, and Vitest doesn't resolve `.ios`/`.android`
// platform extensions, so any suite that transitively renders AppMenu redirects here
// via a vite alias (see vite.config.ts).
//
// This is a FAITHFUL PASSTHROUGH (not a null stub): it preserves the public API and
// the button accessibility semantics with plain React Native primitives — a labelled
// anchor button plus one button per action (carrying the selected state and firing
// `onSelectIndex` with its position) — so indirect screen tests keep their label /
// role / selection assertions. Component tests that assert AppMenu internals register
// their own vi.mock, which takes precedence over this alias.

import { Pressable, Text, View } from 'react-native';
// The shared props type has no native imports, so it's safe to pull into the node-env
// stub — keeps the stub's contract from drifting from the real component.
import type { AppMenuProps } from '../src/components/AppMenu.types';

export function AppMenu({ label, actions, onSelectIndex, accessibilityLabel, accessibilityHint }: AppMenuProps) {
  return (
    <View>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={accessibilityLabel ?? label}
        accessibilityHint={accessibilityHint}
      >
        <Text>{label}</Text>
      </Pressable>
      {actions.map((action, index) => (
        <Pressable
          key={`${index}-${action.label}`}
          accessibilityRole="button"
          accessibilityState={{ selected: action.selected }}
          onPress={() => onSelectIndex(index)}
        >
          <Text>{action.label}</Text>
        </Pressable>
      ))}
    </View>
  );
}
