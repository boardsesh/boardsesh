import { createContext, useContext, useSyncExternalStore, useRef, useMemo, useEffect } from 'react';

/**
 * Lightweight external store for the selected climb UUID.
 *
 * Components subscribe via `useIsClimbSelected(uuid)` which returns a
 * primitive boolean. React's `useSyncExternalStore` bails out when the
 * boolean hasn't changed, so only the previously-selected and
 * newly-selected items re-render — without the parent list needing to
 * iterate all items.
 */
export type SelectionStore = {
  getSnapshot: () => string | null;
  subscribe: (cb: () => void) => () => void;
  setUuid: (uuid: string | null) => void;
};

export function createSelectionStore(initial: string | null = null): SelectionStore {
  let uuid = initial;
  const subscribers = new Set<() => void>();
  return {
    getSnapshot: () => uuid,
    subscribe: (cb) => {
      subscribers.add(cb);
      return () => subscribers.delete(cb);
    },
    setUuid: (next) => {
      if (next === uuid) return;
      uuid = next;
      subscribers.forEach((cb) => cb());
    },
  };
}

export const SelectionStoreContext = createContext<SelectionStore | null>(null);

const serverSnapshot = () => false;

/**
 * Subscribe to selection state for a single climb UUID.
 * Returns a stable boolean — only re-renders when the selected state
 * of THIS specific climb actually changes.
 */
export function useIsClimbSelected(climbUuid: string): boolean {
  const store = useContext(SelectionStoreContext);
  const subscribe = store?.subscribe ?? noopSubscribe;
  const getSnapshot = useMemo(
    () => store ? () => store.getSnapshot() === climbUuid : () => false,
    [store, climbUuid],
  );
  return useSyncExternalStore(subscribe, getSnapshot, serverSnapshot);
}

function noopSubscribe() {
  return () => {};
}

/**
 * Create and manage a selection store, syncing it to a `selectedClimbUuid` prop.
 * Returns the stable store instance (safe to pass via context).
 */
export function useSelectionStore(selectedClimbUuid: string | null | undefined): SelectionStore {
  const store = useRef<SelectionStore>(null!);
  if (store.current === null) {
    store.current = createSelectionStore(selectedClimbUuid ?? null);
  }

  useEffect(() => {
    store.current.setUuid(selectedClimbUuid ?? null);
  }, [selectedClimbUuid]);

  return store.current;
}
