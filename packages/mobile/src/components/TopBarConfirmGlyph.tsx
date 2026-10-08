// The iOS 26 top-bar confirm: a ✓ (or a caller's glyph, such as a lock) in a
// brand circle the size of the leading close, as iOS 26's own sheets and editors
// draw it. Shared by SheetTopBar and the native header's JS fallback
// (HeaderTrailingButton). The label it replaces stays the spoken name.
import React from 'react';
import { StyleSheet, View, type ColorValue } from 'react-native';
import { Icon } from './Icon';
import { ActivityIndicator } from './ActivityIndicator';
import { PressableSurface } from './PressableSurface';
import type { IconName } from './icon-map';

type TopBarConfirmGlyphProps = {
  glyph: IconName;
  fillColor: ColorValue | undefined;
  glyphColor: ColorValue;
  glyphSize: number;
  /** 1, or the dimmed opacity while disabled; the whole circle dims. */
  opacity: number;
  /** The circle's diameter. */
  size: number;
  hitSlop: number;
  loading: boolean;
  /** Disabled or loading: taps are swallowed. */
  inert: boolean;
  onPress: () => void;
  accessibilityLabel: string;
  accessibilityHint?: string;
  testID: string;
  spinnerTestID: string;
};

export const TopBarConfirmGlyph = React.memo(function TopBarConfirmGlyph({
  glyph,
  fillColor,
  glyphColor,
  glyphSize,
  opacity,
  size,
  hitSlop,
  loading,
  inert,
  onPress,
  accessibilityLabel,
  accessibilityHint,
  testID,
  spinnerTestID,
}: TopBarConfirmGlyphProps) {
  return (
    <PressableSurface
      testID={testID}
      onPress={onPress}
      disabled={inert}
      feedback="opacity"
      hitSlop={hitSlop}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityHint={accessibilityHint}
      accessibilityState={{ disabled: inert, busy: loading }}
      style={[
        styles.circle,
        { width: size, height: size, borderRadius: size / 2, backgroundColor: fillColor, opacity },
      ]}
    >
      {/* The spinner takes the glyph's place, in the same circle. */}
      {loading ? (
        <View testID={spinnerTestID}>
          <ActivityIndicator size="small" color={glyphColor} />
        </View>
      ) : (
        <Icon name={glyph} size={glyphSize} color={glyphColor} weight="semibold" />
      )}
    </PressableSurface>
  );
});

const styles = StyleSheet.create({
  circle: {
    alignItems: 'center',
    justifyContent: 'center',
  },
});
