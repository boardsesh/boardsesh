// Inert stand-ins for `src/components/chrome/use-root-bar-items.tsx`, for chrome
// suites that cover the custom glass capsules. The real hooks pull in the
// user drawer, the angle picker and the Bluetooth bulb; the native bar-item
// path has its own suites (`root-bar-items.test.ts`, `use-root-bar-items.test.tsx`).
const noop = () => undefined;

export const useAccountRailItem = () => ({ type: 'button', label: 'account', onPress: noop });
export const useNotificationsBarItem = () => ({ type: 'button', label: 'notifications', onPress: noop });
export const useBoardSwitcherBarItem = () => null;
export const useAngleBarItem = () => ({ item: null, picker: null });
export const useLightbulbBarItem = () => null;
export const useClimbListBarItems = () => [];
export const useBarItemsOnRail = () => false;
