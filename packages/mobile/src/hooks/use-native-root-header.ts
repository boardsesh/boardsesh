import { Platform } from 'react-native';
import { useTheme } from '../providers/theme-provider';

export function useNativeRootHeader(): boolean {
  const { variant } = useTheme();
  return Platform.OS === 'ios' && variant === 'liquidGlass';
}
