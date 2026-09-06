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

export function AppMenu(props: AppMenuProps) {
  const { actions, onSelectIndex, accessibilityLabel, accessibilityHint } = props;
  return (
    <View>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={accessibilityLabel ?? props.label}
        accessibilityHint={accessibilityHint}
      >
        {/* An icon anchor renders a glyph, so it has no visible text to mirror —
            its `accessibilityLabel` is the only name it has, and it is required
            for exactly that reason. Deliberately NOT echoed as text here: doing
            so would let a screen test find by text an anchor that shows none. */}
        <Text>{props.label}</Text>
      </Pressable>
      {actions.map((action, index) => (
        <Pressable
          key={`${index}-${action.label}`}
          accessibilityRole="button"
          accessibilityState={{ selected: action.selected, disabled: action.disabled }}
          // Mirrors the real component's shared guard: a disabled row keeps its
          // position (indices address actions) but never reports a selection.
          disabled={action.disabled}
          onPress={() => {
            if (action.disabled) return;
            onSelectIndex(index);
          }}
        >
          <Text>{action.label}</Text>
        </Pressable>
      ))}
    </View>
  );
}
