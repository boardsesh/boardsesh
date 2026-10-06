import type { ComponentType } from 'react';
import type { NativeSyntheticEvent, ViewProps } from 'react-native';
import { requireNativeViewManager, requireOptionalNativeModule } from 'expo-modules-core';

/** A modifier a shortcut needs. `command` is Ctrl or Meta on Android. */
export type SprayShortcutModifier = 'command' | 'shift' | 'option';

/**
 * One key the editor answers, as the native view takes it. `input` is one
 * character or a named key (`escape`, `return`, `backspace`, `delete`). An
 * empty `title` keeps an alternate key out of the iOS Cmd-hold overlay.
 */
export type NativeShortcutCommand = {
  id: string;
  input: string;
  modifiers: readonly SprayShortcutModifier[];
  title: string;
};

/**
 * The iPad's Apple Pencil setting for a double tap or a squeeze, as
 * `UIPencilPreferredAction` names it. `unknown` is a value a later iPadOS adds.
 */
export type PencilPreferredAction =
  | 'ignore'
  | 'switchEraser'
  | 'switchPrevious'
  | 'showColorPalette'
  | 'showInkAttributes'
  | 'showContextualPalette'
  | 'runSystemShortcut'
  | 'unknown';

/** A double tap or a squeeze. `x`/`y` (the view's points) only when the Pencil was hovering. */
export type NativePencilGesture = {
  preferredAction: PencilPreferredAction;
  x?: number;
  y?: number;
};

export type SprayEditorKeyScopeNativeProps = ViewProps & {
  commands: readonly NativeShortcutCommand[];
  onShortcut?: (event: NativeSyntheticEvent<{ id: string }>) => void;
  /** iOS only. */
  onPencilTap?: (event: NativeSyntheticEvent<NativePencilGesture>) => void;
  /** iOS only, Pencil Pro on iPadOS 17.5 and later. */
  onPencilSqueeze?: (event: NativeSyntheticEvent<NativePencilGesture>) => void;
};

// The module ships on the release/next train, so JS published as an OTA can
// land on a binary built before it existed. requireOptionalNativeModule returns
// null there (and in Expo Go, and on the web) without throwing, and the view is
// only asked for when the module is present: requireNativeViewManager on an
// absent module would hand back a component that fails when it renders. The
// 'SprayEditorInput' string must match Name("SprayEditorInput") on both
// platforms (ios/SprayEditorInputModule.swift, android/…/SprayEditorInputModule.kt).
const sprayEditorInputNative = requireOptionalNativeModule('SprayEditorInput');

/** The native view, or null when the running binary does not have it. */
export const NativeSprayEditorKeyScope: ComponentType<SprayEditorKeyScopeNativeProps> | null = sprayEditorInputNative
  ? requireNativeViewManager<SprayEditorKeyScopeNativeProps>('SprayEditorInput')
  : null;
