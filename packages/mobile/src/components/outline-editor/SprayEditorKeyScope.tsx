import React, { useCallback, useMemo, type ReactNode } from 'react';
import {
  Platform,
  StyleSheet,
  View,
  type LayoutChangeEvent,
  type NativeSyntheticEvent,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
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
  /** How the children are laid out (`alignItems` and the like). */
  contentStyle?: StyleProp<ViewStyle>;
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
 * On Android the native view is an `ExpoView`, which is a horizontal
 * `LinearLayout`. Whenever Fabric lays it out, LinearLayout lays out its direct
 * children again in a row: the first one takes the full width and every later
 * one ends up 0 wide at the right edge, off screen, until Fabric moves it again
 * (#6498: the bottom bar and the count capsule never showed). So on Android the
 * children sit in one non-collapsable `View` that fills the scope, which is
 * exactly where LinearLayout puts a lone child, and Fabric alone places
 * everything inside it.
 *
 * On a binary built before the module shipped it is a plain `View`, and every
 * shortcut is simply not there.
 */
export const SprayEditorKeyScope = React.memo(function SprayEditorKeyScope({
  commands,
  onShortcut,
  onPencilGesture,
  style,
  contentStyle,
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

  const wrapperStyle = useMemo(() => [StyleSheet.absoluteFill, contentStyle], [contentStyle]);

  if (!NativeSprayEditorKeyScope) {
    return (
      <View style={[style, contentStyle]} onLayout={onLayout}>
        {children}
      </View>
    );
  }
  const wrapChildren = Platform.OS === 'android';
  return (
    <NativeSprayEditorKeyScope
      pointerEvents="box-none"
      style={wrapChildren ? style : [style, contentStyle]}
      onLayout={onLayout}
      commands={commands}
      onShortcut={handleShortcut}
      onPencilTap={handlePencilGesture}
      onPencilSqueeze={handlePencilGesture}
    >
      {wrapChildren ? (
        <View collapsable={false} pointerEvents="box-none" style={wrapperStyle}>
          {children}
        </View>
      ) : (
        children
      )}
    </NativeSprayEditorKeyScope>
  );
});
