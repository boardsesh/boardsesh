import { useMemo, type ReactNode } from 'react';
import { MaterialDesignIcons } from '@react-native-vector-icons/material-design-icons';
import { PaperProvider } from 'react-native-paper';
import { useTheme } from './theme-provider';
import { buildPaperTheme } from '../theme/paper-theme';

type PaperIconProps = { name: string; color?: string; size: number };

// Paper and the app share Expo's recommended scoped icon pack and font family.
// Its internal controls also resolve this package directly, without a Metro alias.
function paperIcon({ name, color, size }: PaperIconProps) {
  return (
    <MaterialDesignIcons
      name={name as React.ComponentProps<typeof MaterialDesignIcons>['name']}
      color={color}
      size={size}
    />
  );
}

const paperSettings = { icon: paperIcon };

/**
 * Mounts react-native-paper's PaperProvider with an MD3 theme derived from our
 * tokens (see buildPaperTheme). Sits inside ThemeProvider so it tracks the
 * resolved light/dark scheme; the Material variant's primitives read this theme,
 * while the Liquid Glass variant ignores it entirely. Mounted unconditionally —
 * it's cheap and keeps the provider tree stable across a variant switch.
 */
export function MaterialThemeProvider({ children }: { children: ReactNode }) {
  const { colorScheme } = useTheme();
  const paperTheme = useMemo(() => buildPaperTheme(colorScheme), [colorScheme]);

  return (
    <PaperProvider theme={paperTheme} settings={paperSettings}>
      {children}
    </PaperProvider>
  );
}
