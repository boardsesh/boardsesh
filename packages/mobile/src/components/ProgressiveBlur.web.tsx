import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { useTheme } from '../providers/theme-provider';

type ProgressiveBlurProps = {
  style?: StyleProp<ViewStyle>;
  blurAmount?: number;
  layers?: number;
};

const FADE_LOCATIONS = [0, 0.55, 1] as const;

export function ProgressiveBlur({ style }: ProgressiveBlurProps) {
  const { colorScheme } = useTheme();
  const backgroundColor = colorScheme === 'dark' ? '#000000' : '#FFFFFF';

  return (
    <View pointerEvents="none" style={style}>
      <LinearGradient
        colors={[backgroundColor, backgroundColor, 'transparent']}
        locations={FADE_LOCATIONS}
        pointerEvents="none"
        style={StyleSheet.absoluteFill}
      />
    </View>
  );
}
