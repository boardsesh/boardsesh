import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';
import { SymbolView } from 'expo-symbols';
import { Platform } from 'react-native';
import { iconMap, type IconMapping, type IconName } from './icon-map';

type IconProps = {
  name: IconName;
  size?: number;
  color?: string | import('react-native').OpaqueColorValue;
};

// iOS renders native SF Symbols (expo-symbols); Android keeps MaterialCommunityIcons.
// Both glyph names live in icon-map.ts keyed by the same semantic IconName, so call
// sites stay platform-agnostic.
export function Icon({ name, size = 24, color }: IconProps) {
  const mapping: IconMapping = iconMap[name];

  if (Platform.OS === 'ios') {
    // Some SF Symbols centre their bounding box, not their ink; icon-map records
    // the per-glyph correction so every call site gets the same nudge. The
    // transform is visual only, so the symbol still occupies `size` in layout.
    const { iosOpticalCenterRatio } = mapping;
    const opticalCenter = iosOpticalCenterRatio
      ? { transform: [{ translateY: size * iosOpticalCenterRatio }] }
      : undefined;

    return <SymbolView name={mapping.ios} size={size} tintColor={color} style={opticalCenter} />;
  }

  return (
    <MaterialCommunityIcons
      name={mapping.android as React.ComponentProps<typeof MaterialCommunityIcons>['name']}
      size={size}
      color={color}
    />
  );
}
