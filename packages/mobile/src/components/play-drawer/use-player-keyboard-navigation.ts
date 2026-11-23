import type { PlayerKeyboardNavigationOptions } from './use-player-keyboard-navigation.types';

/** Native hardware-keyboard handling remains owned by the native controls. */
export function usePlayerKeyboardNavigation(_options: PlayerKeyboardNavigationOptions): Record<string, never> {
  return {};
}
