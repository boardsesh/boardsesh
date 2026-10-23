import { createAddressedHandoff } from './addressed-handoff';

// Hands the picked setters back from the Logbook's setter picker route to the
// Logbook that pushed it. Two Logbooks can be mounted at once (your own in the
// You tab, someone else's in another tab's stack), so every push carries the
// opener's `handoffId` (minted by lib/filter-picker-handoff-id.ts) and a
// selection reaches the Logbook subscribed under that id alone
// (lib/addressed-handoff.ts). An empty id reaches nobody.
//
// `apply: true` is the route's "Show climbs" button: take the picks and return
// to the list (a suspended filter sheet closes instead of coming back). The
// back chevron or swipe-back hands the picks back without it.

/** The picks, as the Logbook that pushed the route receives them. */
export type LogbookSetterPicks = {
  setterUsernames: string[];
  apply: boolean;
};

export type LogbookSetterSelection = LogbookSetterPicks & {
  /** The Logbook the picks go back to. */
  handoffId: string;
};

const logbookSettersHandoff = createAddressedHandoff<LogbookSetterPicks>();

export function emitLogbookSetterSelection({ handoffId, ...picks }: LogbookSetterSelection): void {
  logbookSettersHandoff.emit(handoffId, picks);
}

/** Listens for the picks handed back to `handoffId` only. */
export function subscribeToLogbookSetterSelection(
  handoffId: string,
  listener: (picks: LogbookSetterPicks) => void,
): () => void {
  return logbookSettersHandoff.subscribe(handoffId, listener);
}
