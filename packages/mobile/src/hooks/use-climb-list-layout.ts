import { useMemo } from 'react';
import { Dimensions, useWindowDimensions } from 'react-native';
import { useSetting } from '../settings/hooks';
import {
  climbListColumns,
  climbListTwoColumnsPossible,
  sanitiseClimbListLayout,
  type ClimbListColumns,
  type ClimbListLayoutPreference,
} from '../components/climb-list-thumbnail-metrics';
import { useDeviceLayout } from './use-device-layout';

/**
 * The climber's Layout choice (one or two columns) and its writer. A string in
 * the synchronous settings store, so the snapshot is stable by value and an
 * unrelated settings write never re-renders a reader.
 */
export function useClimbListLayout(): [ClimbListLayoutPreference, (value: ClimbListLayoutPreference) => void] {
  const [stored, setStored] = useSetting('climbListLayout');
  return [sanitiseClimbListLayout(stored), setStored];
}

/** The Climbs list's column count for a measured list width and the climber's choice. */
export function useClimbListColumns(listWidth: number): ClimbListColumns {
  const [preference] = useClimbListLayout();
  return climbListColumns({ listWidth, preference });
}

/** Whether this device can ever draw two columns, so Settings shows the Layout choice. */
export function useClimbListTwoColumnsPossible(): boolean {
  const { isTablet, foldableInnerDisplay } = useDeviceLayout();
  const { width, height } = useWindowDimensions();
  // A tablet's physical screen is launch-fixed and rotation-invariant, as
  // `useDeviceLayout` reads it. The Duo swaps displays when it folds, so its
  // long side is the live window's, read while the inner display is lit.
  const screenLongSide = useMemo(() => {
    const screen = Dimensions.get('screen');
    return Math.max(screen.width, screen.height);
  }, []);
  const longSide = foldableInnerDisplay ? Math.max(width, height) : screenLongSide;
  return climbListTwoColumnsPossible({ isTablet, foldableInnerDisplay, screenLongSide: longSide });
}
