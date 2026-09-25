// Hands the selected setters back from the standalone route-based setter picker.
// The climb filter sheet suspends and pushes that route, then merges the result
// into its draft when the route hands the selection back. With `apply: true`
// (the route's "Show N climbs" button) the sheet applies the draft straight away
// instead of merging and re-presenting.
export type SetterFilterHandoffOptions = { apply?: boolean };

type SettersFilterListener = (setters: string[], options: SetterFilterHandoffOptions) => void;

const settersFilterListeners = new Set<SettersFilterListener>();

export function emitSetterFilterSelection(setters: string[], options: SetterFilterHandoffOptions = {}): void {
  for (const listener of settersFilterListeners) {
    listener(setters, options);
  }
}

export function subscribeToSetterFilterSelection(listener: SettersFilterListener): () => void {
  settersFilterListeners.add(listener);
  return () => {
    settersFilterListeners.delete(listener);
  };
}
