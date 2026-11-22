import {
  initialSprayEditorState,
  countEditorHolds,
  holdRole,
  holdsInIdOrder,
  type SprayEditorHold,
  sprayEditorReducer,
  type SprayEditorAction,
  type SprayEditorState,
} from './spray-hold-editor-reducer';

/** One editor's serial reducer. Gesture completions see every preceding transaction, before React paints. */
export function createSprayEditorStore(initial = initialSprayEditorState()) {
  let current = initial;
  let generation = 0;
  const listeners = new Set<() => void>();
  let countedHolds = current.holds;
  let countedRemovals = current.removedIds;
  let counts = countEditorHolds(countedHolds, countedRemovals.length);
  const getCounts = () => {
    if (countedHolds !== current.holds || countedRemovals !== current.removedIds) {
      countedHolds = current.holds;
      countedRemovals = current.removedIds;
      counts = countEditorHolds(countedHolds, countedRemovals.length);
    }
    return counts;
  };
  let hitCache: {
    holds: typeof current.holds;
    showMaybes: boolean;
    visible: readonly SprayEditorHold[];
    hidden: readonly SprayEditorHold[];
  } | null = null;
  const getHitHolds = (showMaybes: boolean) => {
    if (!hitCache || hitCache.holds !== current.holds || hitCache.showMaybes !== showMaybes) {
      const holds = holdsInIdOrder(current.holds);
      hitCache = {
        holds: current.holds,
        showMaybes,
        visible: showMaybes ? holds : holds.filter((hold) => holdRole(hold) !== 'maybe'),
        hidden: showMaybes ? [] : holds.filter((hold) => holdRole(hold) === 'maybe'),
      };
    }
    return hitCache;
  };
  const getSnapshot = () => current;
  const subscribe = (listener: () => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  };
  const dispatch = (action: SprayEditorAction): SprayEditorState => {
    const next = sprayEditorReducer(current, action);
    if (next !== current) {
      current = next;
      if (action.type === 'LOAD' || action.type === 'RESTORE' || action.type === 'START_OVER') generation += 1;
      for (const listener of listeners) listener();
    }
    return current;
  };
  return {
    get current() {
      return current;
    },
    get generation() {
      return generation;
    },
    get counts() {
      return getCounts();
    },
    getSnapshot,
    getHitHolds,
    subscribe,
    dispatch,
  };
}
