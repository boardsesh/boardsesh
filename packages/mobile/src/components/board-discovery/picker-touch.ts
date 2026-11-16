import { createContext, type RefObject } from 'react';

/**
 * Whether the climber has touched the board picker since it opened: a tap or
 * the start of a drag on its scroll view (`BoardSelectorView`). A ref, so a
 * touch re-renders nothing; read it when something is about to move, never
 * while rendering. Null outside a picker (a story, a test): treat it as
 * touched, so nothing moves.
 */
export const PickerTouchContext = createContext<RefObject<boolean> | null>(null);
