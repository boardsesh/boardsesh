import { StyleSheet, useWindowDimensions } from 'react-native';
import Svg, { Path } from 'react-native-svg';
import type { MaterialIconProps } from './MaterialCommunityIcon.types';
import { materialIconPaths, materialIconViewBox } from './material-icon-paths';

/** Android icon fonts can fail to load after an update; draw the same glyphs directly. */
export default function MaterialCommunityIcon({
  name,
  size = 12,
  color = 'black',
  style,
  testID,
  pointerEvents,
  allowFontScaling = false,
  maxFontSizeMultiplier,
}: MaterialIconProps) {
  const { fontScale } = useWindowDimensions();
  const scale = allowFontScaling
    ? Math.min(fontScale, maxFontSizeMultiplier && maxFontSizeMultiplier > 0 ? maxFontSizeMultiplier : Infinity)
    : 1;
  // Paper supplies a Text style, including its RTL transform. Keep view styles
  // while removing font metrics, which are irrelevant to SVG's square viewport.
  const {
    lineHeight: _lineHeight,
    fontFamily: _fontFamily,
    fontWeight: _fontWeight,
    fontStyle: _fontStyle,
    fontSize: _fontSize,
    ...viewStyle
  } = StyleSheet.flatten(style) ?? {};
  return (
    <Svg
      width={size * scale}
      height={size * scale}
      viewBox={materialIconViewBox}
      style={viewStyle}
      testID={testID}
      pointerEvents={pointerEvents}
      accessible={false}
      importantForAccessibility="no-hide-descendants"
      focusable={false}
    >
      <Path d={materialIconPaths[name]} fill={color} />
    </Svg>
  );
}
