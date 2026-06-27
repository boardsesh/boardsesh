// Hands the selected setters back from the standalone route-based setter picker.
// The climb filter sheet suspends and pushes that route, then merges the result
// into its draft when the route hands the selection back.
type SettersFilterListener = (setters: string[]) => void;

const settersFilterListeners = new Set<SettersFilterListener>();

export function emitSetterFilterSelection(setters: string[]): void {
  for (const listener of settersFilterListeners) {
    listener(setters);
  }
}

export function subscribeToSetterFilterSelection(listener: SettersFilterListener): () => void {
  settersFilterListeners.add(listener);
  return () => {
    settersFilterListeners.delete(listener);
  };
}
