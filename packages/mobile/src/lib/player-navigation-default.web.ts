import { getBrowserMouseAvailable, useBrowserMouseAvailable } from './browser-input-capabilities.web';

// Settings retain their initial default; the player follows capabilities live
// until the climber explicitly saves a Previous and next preference.
export const DEFAULT_PLAYER_PREVIOUS_NEXT = getBrowserMouseAvailable();
export const getDefaultPlayerPreviousNext = getBrowserMouseAvailable;
export const useDefaultPlayerPreviousNext = useBrowserMouseAvailable;
