// Check available inputs at startup so a mouse also works alongside a touchscreen.
export const DEFAULT_PLAYER_PREVIOUS_NEXT =
  typeof window !== 'undefined' &&
  typeof window.matchMedia === 'function' &&
  window.matchMedia('(any-hover: hover) and (any-pointer: fine)').matches;
