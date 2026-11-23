import type { OpeningInput } from './sheet-presentation-policy';

/** Native presentation is chosen by UIKit/Material rather than input modality. */
export function getOpeningInput(): OpeningInput {
  return 'unknown';
}
export function startOpeningInputTracking(): () => void {
  return () => {};
}
