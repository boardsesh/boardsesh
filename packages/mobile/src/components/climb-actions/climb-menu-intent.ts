// The hand-off from the iOS native context menu to `openClimbActions`.
//
// Every long-press surface already opens its menu through its own callback,
// which calls `openClimbActions(climb, boardConfig, options)` with the options
// only that surface knows (the logbook's "Edit entry", the queue row's slot, the
// board sheet's dismiss waiter). When the climber picks an item in the native
// menu, the menu calls that same callback inside `withClimbActionIntent`, and
// `openClimbActions` reads the intent: instead of showing the overlay it runs
// the chosen action with those same options. So no surface has to learn a
// second way to describe itself.
//
// The intent lives only for the duration of the synchronous callback, so a
// later long-press or ⋮ tap can never pick up a stale one.

import { createContext, useContext } from 'react';
import type { ClimbActionId } from './climb-action-gating';

let pendingIntent: ClimbActionId | null = null;

/** Run `open` with `actionId` as the intent; `openClimbActions` consumes it. */
export function withClimbActionIntent(actionId: ClimbActionId, open: () => void): void {
  pendingIntent = actionId;
  try {
    open();
  } finally {
    pendingIntent = null;
  }
}

/** The intent of the menu pick in progress, if any. Clears it. */
export function takeClimbActionIntent(): ClimbActionId | null {
  const intent = pendingIntent;
  pendingIntent = null;
  return intent;
}

/** Who is looking, for the native menu's gating. Provided by DrawerHostProvider,
 *  which already resolves both for the overlay. Its own context, so a menu on
 *  every row doesn't subscribe to the drawer host's much busier value. */
export type ClimbMenuViewer = {
  currentUserId: string | null;
  isAuthenticated: boolean;
};

const SIGNED_OUT: ClimbMenuViewer = { currentUserId: null, isAuthenticated: false };

export const ClimbMenuViewerContext = createContext<ClimbMenuViewer>(SIGNED_OUT);

export function useClimbMenuViewer(): ClimbMenuViewer {
  return useContext(ClimbMenuViewerContext);
}
