import { ActivityIndicator as RNActivityIndicator, type ActivityIndicatorProps, type ColorValue } from 'react-native';
import { brandColors } from '../theme/colors';
import { useOptionalTheme } from '../providers/theme-provider';

type Props = Omit<ActivityIndicatorProps, 'color'> & {
  // `ColorValue`, not `string`: on Liquid Glass every `systemColors.*` read is an
  // opaque iOS `PlatformColor` object, so callers were casting a lie to pass one.
  color?: ColorValue;
};

export function ActivityIndicator({ color, ...props }: Props) {
  // Scheme-aware brand tint (lifts to #A78BFA in dark); falls back to the static
  // light value when rendered before the ThemeProvider mounts.
  const theme = useOptionalTheme();
  const resolvedColor = color ?? theme?.brandColors.primary ?? brandColors.primary;
  return <RNActivityIndicator color={resolvedColor} {...props} />;
}
