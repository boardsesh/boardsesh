// Hands the picked setters back from the Logbook's setter picker route to the
// Logbook that pushed it. Two Logbooks can be mounted at once (your own in the
// You tab, someone else's in another tab's stack), so every push carries the
// opener's `handoffId` and a Logbook only takes a selection addressed to it.
//
// `apply: true` is the route's "Show climbs" button: take the picks and return
// to the list (a suspended filter sheet closes instead of coming back). The
// back chevron or swipe-back hands the picks back without it.

export type LogbookSetterSelection = {
  handoffId: string;
  setterUsernames: string[];
  apply: boolean;
};

type LogbookSetterListener = (selection: LogbookSetterSelection) => void;

const listeners = new Set<LogbookSetterListener>();

export function emitLogbookSetterSelection(selection: LogbookSetterSelection): void {
  for (const listener of listeners) listener(selection);
}

export function subscribeToLogbookSetterSelection(listener: LogbookSetterListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

let handoffCounter = 0;

/** A fresh id for one mounted Logbook. */
export function createLogbookSetterHandoffId(): string {
  handoffCounter += 1;
  return `logbook-setters-${handoffCounter}`;
}
