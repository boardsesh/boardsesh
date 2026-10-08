import {
  getDifferentiateWithoutColor,
  startDifferentiateWithoutColorSignal,
  subscribeDifferentiateWithoutColor,
} from './differentiate-without-color';
import { setSystemPrefersRoleShapes } from './hold-color-overrides';

let started = false;

/**
 * Keep the hold-marker shape default in step with iOS "Differentiate Without
 * Color": per-role shapes while it is on, circles while it is off or unknown.
 * Only roles the climber left alone follow it (see `hold-color-overrides.ts`).
 *
 * Lives apart from both modules so the store stays free of React Native and
 * the signal knows nothing about holds. Called once from the root layout.
 */
export function startHoldShapeSystemDefaultSync(): void {
  if (started) return;
  started = true;
  startDifferentiateWithoutColorSignal();
  setSystemPrefersRoleShapes(getDifferentiateWithoutColor() === 'on');
  subscribeDifferentiateWithoutColor((state) => setSystemPrefersRoleShapes(state === 'on'));
}
