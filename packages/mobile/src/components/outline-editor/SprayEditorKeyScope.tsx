import React, { useCallback, type ReactNode } from 'react';
import { View, type LayoutChangeEvent, type NativeSyntheticEvent, type StyleProp, type ViewStyle } from 'react-native';
import {
  NativeSprayEditorKeyScope,
  type NativePencilGesture,
  type NativeShortcutCommand,
} from '../../../modules/spray-editor-input/src/index';
import { isSprayShortcutId, type SprayShortcutId } from './spray-editor-shortcuts';

type SprayEditorKeyScopeProps = {
  /** What to register: `sprayShortcutCommands(titles)`. Empty answers nothing. */
  commands: readonly NativeShortcutCommand[];
  onShortcut: (id: SprayShortcutId) => void;
  /**
   * A Pencil double tap or squeeze (iPad only), with the hover point when there
   * was one. The two arrive alike: each carries the climber's own setting for
   * that gesture, and the setting is what decides the action.
   */
  onPencilGesture: (gesture: NativePencilGesture) => void;
  style?: StyleProp<ViewStyle>;
  onLayout?: (event: LayoutChangeEvent) => void;
  children?: ReactNode;
};

/**
 * The editor's root view. While it is mounted, the editor answers its keyboard
 * shortcuts and the Apple Pencil's double tap and squeeze
 * (`modules/spray-editor-input`).
 *
 * It wraps the whole editor rather than lying on top of it. On iOS, Fabric
 * turns `pointerEvents="none"` into `userInteractionEnabled = NO`, and UIKit
 * may then refuse the view first responder (no key command would ever fire)
 * and never hit-tests it (the Pencil interaction on it would rest on
 * undocumented delivery). As the ancestor of every view a touch lands on, with
 * `box-none`, it keeps interaction on, sees each hit test (which is how a touch
 * hands it the keyboard back) and still passes every touch to the editor. A
 * hover point it reports is in the editor's own coordinates.
 *
 * On a binary built before the module shipped it is a plain `View`, and every
 * shortcut is simply not there.
 */
export const SprayEditorKeyScope = React.memo(function SprayEditorKeyScope({
  commands,
  onShortcut,
  onPencilGesture,
  style,
  onLayout,
  children,
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

  if (!NativeSprayEditorKeyScope) {
    return (
      <View style={style} onLayout={onLayout}>
        {children}
      </View>
    );
  }
  return (
    <NativeSprayEditorKeyScope
      pointerEvents="box-none"
      style={style}
      onLayout={onLayout}
      commands={commands}
      onShortcut={handleShortcut}
      onPencilTap={handlePencilGesture}
      onPencilSqueeze={handlePencilGesture}
    >
      {children}
    </NativeSprayEditorKeyScope>
  );
});
