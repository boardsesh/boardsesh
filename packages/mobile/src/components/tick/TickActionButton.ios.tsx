import { useMemo } from 'react';
import { Pressable, StyleSheet, View, type ViewStyle } from 'react-native';
import { Button } from '../Button';
import type { ButtonProps } from '../Button.types';
import { makeButtonPressHandler } from '../Button.logic';
import { opacity } from '../../theme/tokens';

const ignoreNativePress = () => {};

/** Keep a sheet's text input and terminal actions in the same RN touch tree.
 * SwiftUI still draws the control, but its nested hosting controller does not
 * compete with the focused note field for the footer tap. */
export function TickActionButton(props: ButtonProps) {
  const { style, title, accessibilityLabel, disabled = false, loading = false, testID } = props;
  const handlePress = makeButtonPressHandler(props);
  // Preserve the numeric height through the touch wrapper. A percentage makes
  // Button's SwiftUI Host measure itself, so tonal and filled surfaces differ.
  const buttonStyle = useMemo<ViewStyle>(
    () => ({ ...styles.surface, height: style?.height ?? '100%' }),
    [style?.height],
  );
  return (
    <Pressable
      testID={testID}
      onPress={handlePress}
      disabled={disabled || loading}
      accessible
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? title}
      accessibilityState={{ disabled: disabled || loading, busy: loading }}
      style={({ pressed }) => [style, pressed ? styles.pressed : undefined]}
    >
      <View
        pointerEvents="none"
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        style={styles.surface}
      >
        <Button {...props} style={buttonStyle} testID={undefined} onPress={ignoreNativePress} haptic={false} />
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({ surface: { width: '100%', height: '100%' }, pressed: { opacity: opacity.subtle } });
