import { useCallback, useState, type ReactNode } from 'react';
import { View, StyleSheet, type LayoutChangeEvent, type StyleProp, type ViewStyle } from 'react-native';

/** Measure in RN before mounting a bridge, which retains its first intrinsic width. */
export function MeasuredMenuAnchor({
  style,
  children,
}: {
  style?: StyleProp<ViewStyle>;
  children: (width: number | undefined) => ReactNode;
}) {
  const [width, setWidth] = useState<number>();
  const measure = useCallback((event: LayoutChangeEvent) => {
    const nextWidth = event.nativeEvent.layout.width;
    if (Number.isFinite(nextWidth) && nextWidth > 0) {
      setWidth((currentWidth) => (currentWidth === nextWidth ? currentWidth : nextWidth));
    }
  }, []);
  return (
    <View collapsable={false} onLayout={measure} style={[styles.anchor, style]}>
      {children(width)}
    </View>
  );
}
const styles = StyleSheet.create({ anchor: { minWidth: 0 } });
