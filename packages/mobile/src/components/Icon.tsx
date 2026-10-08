import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';
import { SymbolView, type SymbolWeight, type SymbolScale } from 'expo-symbols';
import { Platform, I18nManager, useWindowDimensions } from 'react-native';
import { useBoldText } from '../hooks/use-bold-text';
import { iconMap, type IconMapping, type IconName } from './icon-map';

type IconProps = {
  name: IconName;
  size?: number;
  color?: string | import('react-native').OpaqueColorValue;
  /**
   * The SF Symbol's stroke weight (iOS only). Chrome glyphs (close, back, ✓,
   * ellipsis) draw semibold, as iOS 26's own bar buttons do.
   */
  weight?: SymbolWeight;
  scale?: SymbolScale;
  /** Inline icons grow with nearby text; fixed chrome opts into a cap of 1. */
  maxFontSizeMultiplier?: number;
};

// iOS renders native SF Symbols (expo-symbols); Android keeps MaterialCommunityIcons.
// Both glyph names live in icon-map.ts keyed by the same semantic IconName, so call
// sites stay platform-agnostic.
export function Icon({
  name,
  size: baseSize = 24,
  color,
  weight = 'regular',
  scale = 'medium',
  maxFontSizeMultiplier = 1.5,
}: IconProps) {
  const { fontScale } = useWindowDimensions();
  const boldText = useBoldText();
  const size = baseSize * Math.min(fontScale, maxFontSizeMultiplier <= 0 ? fontScale : maxFontSizeMultiplier);
  const mapping: IconMapping = iconMap[name];
  const resolvedWeight = boldText
    ? weight === 'regular'
      ? 'semibold'
      : weight === 'medium' || weight === 'semibold'
        ? 'bold'
        : weight
    : weight;

  if (Platform.OS === 'ios') {
    // Some SF Symbols centre their bounding box, not their ink; icon-map records
    // the per-glyph correction so every call site gets the same nudge. The
    // transform is visual only, so the symbol still occupies `size` in layout.
    const { iosOpticalCenterRatio } = mapping;
    const opticalCenter = iosOpticalCenterRatio
      ? { transform: [{ translateY: size * iosOpticalCenterRatio }] }
      : undefined;

    return (
      <SymbolView
        name={mapping.ios}
        size={size}
        tintColor={color}
        weight={resolvedWeight}
        scale={scale}
        style={opticalCenter}
      />
    );
  }

  return (
    <MaterialCommunityIcons
      name={
        (I18nManager.isRTL && (name === 'back' || name === 'chevron.left')
          ? name === 'back'
            ? 'arrow-right'
            : 'chevron-right'
          : I18nManager.isRTL && name === 'chevron.right'
            ? 'chevron-left'
            : mapping.android) as React.ComponentProps<typeof MaterialCommunityIcons>['name']
      }
      size={size}
      color={color}
    />
  );
}
