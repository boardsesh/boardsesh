import { useMemo, type ReactNode } from 'react';
import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';
import { PaperProvider } from 'react-native-paper';
import { useTheme } from './theme-provider';
import { buildPaperTheme } from '../theme/paper-theme';

type PaperIconProps = { name: string; color?: string; size: number };

// Route react-native-paper's icons to the @expo/vector-icons MaterialCommunityIcons
// font the app already bundles (Paper uses MDI names by default), so we don't
// ship a second icon font.
function paperIcon({ name, color, size }: PaperIconProps) {
  return (
    <MaterialCommunityIcons
      name={name as React.ComponentProps<typeof MaterialCommunityIcons>['name']}
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
