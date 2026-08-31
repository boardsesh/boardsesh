// Test stub for the platform-split MoreForm. Its iOS / Android implementations
// render native @expo/ui trees (a SwiftUI `Form` / Compose `LazyColumn`) that
// can't mount under Vitest's node env, and Vitest doesn't resolve `.ios`/`.android`
// platform extensions, so any suite that transitively renders the More screen
// redirects here via a vite alias (see vite.config.ts).
//
// This is a FAITHFUL PASSTHROUGH (not a null stub): it renders every row's visible
// label and wires its handler to a plain React Native primitive with a sensible
// accessibility role (nav/button → button, toggle → switch, segmented/select →
// radiogroup of radios), so screen tests' label / role assertions and handler
// invocations keep working. Component tests that assert MoreForm internals can
// register their own vi.mock, which takes precedence over this alias.

import { Pressable, Switch, Text, View } from 'react-native';
import { assertNeverRow, selectedOptionLabel } from '../src/components/MoreForm.logic';
// The shared props type has no native imports, so it's safe in the node-env stub —
// keeps the stub's contract from drifting from the real component.
import type { MoreFormProps, MoreRow } from '../src/components/MoreForm.types';

function StubRow({ row }: { row: MoreRow }) {
  switch (row.kind) {
    case 'nav':
      return (
        <Pressable onPress={row.onPress} accessibilityRole="button" accessibilityLabel={row.label}>
          <Text>{row.label}</Text>
          {row.subtitle ? <Text>{row.subtitle}</Text> : null}
          {row.badge ? <Text>{row.badge}</Text> : null}
        </Pressable>
      );
    case 'toggle':
      return (
        <View>
          <Text>{row.label}</Text>
          {row.subtitle ? <Text>{row.subtitle}</Text> : null}
          <Switch value={row.value} onValueChange={row.onValueChange} accessibilityLabel={row.label} />
        </View>
      );
    case 'segmented':
    case 'select':
      return (
        <View accessibilityRole="radiogroup" accessibilityLabel={row.label}>
          {row.kind === 'select' ? <Text>{selectedOptionLabel(row.options, row.selectedKey)}</Text> : null}
          {row.options.map((option) => (
            <Pressable
              key={option.key}
              onPress={() => row.onSelect(option.key)}
              accessibilityRole="radio"
              accessibilityState={{ selected: option.key === row.selectedKey }}
              accessibilityLabel={option.label}
            >
              <Text>{option.label}</Text>
            </Pressable>
          ))}
        </View>
      );
    case 'info':
      return (
        <View>
          <Text>{row.label}</Text>
          <Text>{row.body}</Text>
          {row.detail ? <Text>{row.detail}</Text> : null}
        </View>
      );
    case 'button':
      return (
        <Pressable onPress={row.onPress} accessibilityRole="button" accessibilityLabel={row.label}>
          <Text>{row.label}</Text>
        </Pressable>
      );
    case 'slider':
      // Two separate buttons rather than one, because the whole point of the
      // slider contract is that dragging and committing are different events:
      // a test must be able to assert that a drag does NOT reach the store.
      return (
        <View
          accessible
          accessibilityRole="adjustable"
          accessibilityLabel={row.label}
          accessibilityValue={{ text: row.format(row.value) }}
        >
          <Text>{row.label}</Text>
          <Text>{row.format(row.value)}</Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`${row.label} drag`}
            onPress={() => row.onValueChange(row.value + row.step)}
          />
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`${row.label} commit`}
            onPress={() => row.onCommit(row.value)}
          />
        </View>
      );
    case 'custom':
      // Render the hosted subtree verbatim. That is what keeps existing screen
      // tests working across the native migration: a suite that mocks the
      // carousel still gets its mock rendered, exactly as it did when the screen
      // was plain React Native.
      return <View>{row.content}</View>;
    // Match the real platform files: a future MoreRow kind that isn't handled is a
    // compile error here, not a row that silently renders nothing.
    default:
      return assertNeverRow(row);
  }
}

export function MoreForm({ model }: MoreFormProps) {
  return (
    <View>
      {model.sections.map((section) => (
        <View key={section.key}>
          {section.title ? <Text>{section.title}</Text> : null}
          {section.rows.map((row) => (
            <StubRow key={row.key} row={row} />
          ))}
          {section.footer ? <Text>{section.footer}</Text> : null}
        </View>
      ))}
    </View>
  );
}
