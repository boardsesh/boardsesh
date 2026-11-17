import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';
import { SymbolView, type SymbolWeight, type SymbolScale } from 'expo-symbols';
import { Platform, I18nManager, useWindowDimensions, type ColorValue } from 'react-native';
import { useBoldText } from '../hooks/use-bold-text';
import { textFontScale } from '../theme/dynamic-type';
import type { TextVariant } from '../theme/typography';
import { iconMap, type IconMapping, type IconName } from './icon-map';

type IconProps = {
  name: IconName;
  size?: number;
  color?: ColorValue;
  /**
   * The SF Symbol's stroke weight (iOS only). Chrome glyphs (close, back, ✓,
   * ellipsis) draw semibold, as iOS 26's own bar buttons do.
   */
  weight?: SymbolWeight;
  scale?: SymbolScale;
  /** Inline icons grow with nearby text; fixed chrome opts into a cap of 1. */
  maxFontSizeMultiplier?: number;
  /**
   * The text style the icon sits beside, so it grows on that style's Dynamic
   * Type ramp (iOS). Defaults to `body`; set it for an icon in a footnote or
   * caption line, which grows faster than body text from xLarge to xxxLarge.
   */
  textVariant?: TextVariant;
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
  textVariant = 'body',
}: IconProps) {
  const { fontScale } = useWindowDimensions();
  const boldText = useBoldText();
  // An icon has no text style of its own, so it grows on the ramp of the text it
  // sits beside (`textVariant`, body by default), as that `Text` does on iOS.
  // The body ramp equals React Native's `fontScale` at every iOS setting up to
  // xxxLarge (1.353), so a body icon under the default 1.5 cap draws the same
  // size as before; an uncapped one comes out smaller at AX1–AX5, in step with
  // the body text beside it.
  const textScale = textFontScale(textVariant, fontScale, Platform.OS);
  const size = baseSize * Math.min(textScale, maxFontSizeMultiplier <= 0 ? textScale : maxFontSizeMultiplier);
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

  // Vector icon declarations still use the pre-strict native color union.
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
      color={color as React.ComponentProps<typeof MaterialCommunityIcons>['color']}
    />
  );
}
