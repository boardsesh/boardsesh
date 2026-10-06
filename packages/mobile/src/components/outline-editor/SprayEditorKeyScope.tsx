import React, { useCallback } from 'react';
import { StyleSheet, type NativeSyntheticEvent } from 'react-native';
import {
  NativeSprayEditorKeyScope,
  type NativePencilGesture,
  type NativeShortcutCommand,
} from '../../../modules/spray-editor-input/src/index';
import { isSprayShortcutId, type SprayShortcutId } from './spray-editor-shortcuts';

type SprayEditorKeyScopeProps = {
  /** What to register: `sprayShortcutCommands(titles)`. */
  commands: readonly NativeShortcutCommand[];
  onShortcut: (id: SprayShortcutId) => void;
  /**
   * A Pencil double tap or squeeze (iPad only), with the hover point when there
   * was one. The two arrive alike: each carries the climber's own setting for
   * that gesture, and the setting is what decides the action.
   */
  onPencilGesture: (gesture: NativePencilGesture) => void;
};

/**
 * While this is mounted, the editor answers its keyboard shortcuts and the
 * Apple Pencil's double tap and squeeze (`modules/spray-editor-input`).
 *
 * Mount it inside the editor's root view: it lays an invisible native view
 * over the whole editor, which takes no touches and is hidden from screen
 * readers, so a hover point it reports is in the editor's own coordinates.
 * On a binary built before the module shipped it renders nothing, and every
 * shortcut is simply not there.
 */
export const SprayEditorKeyScope = React.memo(function SprayEditorKeyScope({
  commands,
  onShortcut,
  onPencilGesture,
}: SprayEditorKeyScopeProps) {
  const handleShortcut = useCallback(
    (event: NativeSyntheticEvent<{ id: string }>) => {
      const { id } = event.nativeEvent;
      if (isSprayShortcutId(id)) onShortcut(id);
    },
    [onShortcut],
  );
  const handlePencilGesture = useCallback(
    (event: NativeSyntheticEvent<NativePencilGesture>) => onPencilGesture(event.nativeEvent),
    [onPencilGesture],
  );

  if (!NativeSprayEditorKeyScope) return null;
  return (
    <NativeSprayEditorKeyScope
      pointerEvents="none"
      style={StyleSheet.absoluteFill}
      accessible={false}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      commands={commands}
      onShortcut={handleShortcut}
      onPencilTap={handlePencilGesture}
      onPencilSqueeze={handlePencilGesture}
    />
  );
});
