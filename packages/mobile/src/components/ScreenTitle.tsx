import { type ReactNode } from 'react';
import { type StyleProp, type TextStyle } from 'react-native';
import { Text } from './Text';
import { useTheme } from '../providers/theme-provider';

type ScreenTitleProps = {
  children: ReactNode;
  style?: StyleProp<TextStyle>;
};

/**
 * The in-body large screen title that sits under the floating chrome and collapses
 * into the header capsule on scroll. Renders `null` on Material, where the M3 app
 * bar owns the title — so the profile tabs and session screens write
 * `<ScreenTitle>{title}</ScreenTitle>` unconditionally instead of repeating a
 * Material-only null gate (the old inline largeTitle suppression) at each site.
 */
export function ScreenTitle({ children, style }: ScreenTitleProps) {
  const { features } = useTheme();
  if (!features.inBodyLargeTitle) return null;
  return (
    <Text variant="largeTitle" style={style}>
      {children}
    </Text>
  );
}
