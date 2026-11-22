/** Native layouts keep their existing touch-first controls. */
export const getBrowserMouseAvailable = (): boolean => false;
export const subscribeBrowserMouseAvailable =
  (_listener: () => void): (() => void) =>
  () => {};
export const useBrowserMouseAvailable = (): boolean => false;
