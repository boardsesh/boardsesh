// Hands the selected setters back from a route-based setter picker (the Climbs
// setters route, a playlist's setters route) to the filter sheet that pushed it.
// The sheet suspends and pushes the route with its `handoffId`
// (lib/filter-picker-handoff-id.ts), then merges the picks into its draft when
// the route hands them back to that id. With `apply: true` (the route's "Show
// climbs" button) the sheet applies the draft straight away instead of merging
// and re-presenting.
export type SetterFilterHandoffOptions = { apply?: boolean };

export type SetterFilterSelection = SetterFilterHandoffOptions & {
  /** The sheet the picks go back to. Empty for a route opened without one: nobody gets them. */
  handoffId: string;
  setters: string[];
};

type SettersFilterListener = (setters: string[], options: SetterFilterHandoffOptions) => void;

const settersFilterListeners = new Set<{ handoffId: string; listener: SettersFilterListener }>();

export function emitSetterFilterSelection({ handoffId, setters, ...options }: SetterFilterSelection): void {
  if (!handoffId) return;
  for (const subscription of settersFilterListeners) {
    if (subscription.handoffId === handoffId) subscription.listener(setters, options);
  }
}

/** Listens for the picks handed back to `handoffId` only. */
export function subscribeToSetterFilterSelection(handoffId: string, listener: SettersFilterListener): () => void {
  const subscription = { handoffId, listener };
  settersFilterListeners.add(subscription);
  return () => {
    settersFilterListeners.delete(subscription);
  };
}
