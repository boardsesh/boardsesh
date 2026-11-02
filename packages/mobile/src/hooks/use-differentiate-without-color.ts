import { useEffect, useSyncExternalStore } from 'react';
import {
  getDifferentiateWithoutColor,
  startDifferentiateWithoutColorSignal,
  subscribeDifferentiateWithoutColor,
  type DifferentiateWithoutColorState,
} from '../lib/differentiate-without-color';

/**
 * iOS "Differentiate Without Color", live: 'on', 'off', or 'unknown' (Android, a
 * binary without the module, or not read yet). For a control that keeps a shape
 * cue only while the climber has asked for one.
 */
export function useDifferentiateWithoutColor(): DifferentiateWithoutColorState {
  useEffect(() => startDifferentiateWithoutColorSignal(), []);
  return useSyncExternalStore(
    subscribeDifferentiateWithoutColor,
    getDifferentiateWithoutColor,
    getDifferentiateWithoutColor,
  );
}
