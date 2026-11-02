import { useMemo } from 'react';
import { Dimensions } from 'react-native';
import { useSetting } from '../settings/hooks';
import {
  climbListTwoColumnsPossible,
  sanitiseClimbListLayout,
  type ClimbListLayoutPreference,
} from '../components/climb-list-thumbnail-metrics';
import { useDeviceLayout } from './use-device-layout';

/**
 * The climber's Columns choice (one or two columns) and its writer. A string in
 * the synchronous settings store, so the snapshot is stable by value and an
 * unrelated settings write never re-renders a reader.
 */
export function useClimbListLayout(): [ClimbListLayoutPreference, (value: ClimbListLayoutPreference) => void] {
  const [stored, setStored] = useSetting('climbListLayout');
  return [sanitiseClimbListLayout(stored), setStored];
}

/** Whether this device's list can ever be wide enough for two columns, so Settings shows the choice. */
export function useClimbListTwoColumnsPossible(): boolean {
  const { isTablet } = useDeviceLayout();
  // The physical screen, launch-fixed and rotation-invariant, as `useDeviceLayout` reads it.
  const screenLongSide = useMemo(() => {
    const screen = Dimensions.get('screen');
    return Math.max(screen.width, screen.height);
  }, []);
  return climbListTwoColumnsPossible({ isTablet, screenLongSide });
}
