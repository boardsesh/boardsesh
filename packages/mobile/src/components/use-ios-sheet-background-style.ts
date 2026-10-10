import { useMemo } from 'react';
import { Platform } from 'react-native';
import { useEffectiveSurfaceMode } from '../hooks/use-effective-surface-mode';
import { useTheme } from '../providers/theme-provider';

/** Let SwiftUI own the sheet ground in the Apple theme. An explicit Material
 * choice or Reduce Transparency needs an opaque presentation instead. */
export function useIosSheetBackgroundStyle(): { backgroundColor: string } | undefined {
  const { sheetSurface } = useTheme();
  const surfaceMode = useEffectiveSurfaceMode();

  return useMemo(
    () =>
      Platform.OS === 'ios' && (surfaceMode === 'material' || surfaceMode === 'solid')
        ? { backgroundColor: sheetSurface }
        : undefined,
    [sheetSurface, surfaceMode],
  );
}
