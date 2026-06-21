import { ActivityIndicator as RNActivityIndicator, type ActivityIndicatorProps } from 'react-native';
import { brandColors } from '../theme/colors';
import { useOptionalTheme } from '../providers/theme-provider';

type Props = Omit<ActivityIndicatorProps, 'color'> & {
  color?: string;
};

export function ActivityIndicator({ color, ...props }: Props) {
  // Scheme-aware brand tint (lifts to #A78BFA in dark); falls back to the static
  // light value when rendered before the ThemeProvider mounts.
  const theme = useOptionalTheme();
  const resolvedColor = color ?? theme?.brandColors.primary ?? brandColors.primary;
  return <RNActivityIndicator color={resolvedColor} {...props} />;
}
