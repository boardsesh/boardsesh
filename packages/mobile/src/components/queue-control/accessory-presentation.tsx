import { createContext, useContext, useSyncExternalStore } from 'react';

export type WindowRect = Readonly<{ x: number; y: number; width: number; height: number }>;

export type AccessoryPresentationEvent = {
  phase: string;
  environment: string;
  sourceId: number;
  revision: number;
  windowX: number;
  windowY: number;
  width: number;
  height: number;
};

export type AccessoryPresentation = Readonly<{
  sourceId: number;
  revision: number;
  frame: WindowRect;
}>;

/** One store per mounted native accessory; both static placement trees share it. */
export function createAccessoryPresentationStore() {
  let snapshot: AccessoryPresentation | null = null;
  let sourceId = 0;
  let revision = 0;
  const listeners = new Set<() => void>();
  const notify = () => {
    for (const listener of listeners) listener();
  };
  return {
    getSnapshot: () => snapshot,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    publish(event: AccessoryPresentationEvent) {
      if (
        !Number.isSafeInteger(event.sourceId) ||
        !Number.isSafeInteger(event.revision) ||
        event.sourceId < 1 ||
        event.revision < 1 ||
        event.sourceId < sourceId ||
        (event.sourceId === sourceId && event.revision <= revision)
      )
        return;
      sourceId = event.sourceId;
      revision = event.revision;
      const frame = { x: event.windowX, y: event.windowY, width: event.width, height: event.height };
      const next =
        event.phase === 'settled' && event.environment === 'regular' && isValidWindowRect(frame)
          ? { sourceId, revision, frame }
          : null;
      if (snapshot === null && next === null) return;
      snapshot = next;
      notify();
    },
  };
}

export type AccessoryPresentationStore = ReturnType<typeof createAccessoryPresentationStore>;
export const AccessoryPresentationContext = createContext<AccessoryPresentationStore | null>(null);
const subscribeNever = () => () => {};
const getUnknown = () => null;

export function useAccessoryPresentation() {
  const store = useContext(AccessoryPresentationContext);
  const presentation = useSyncExternalStore(store?.subscribe ?? subscribeNever, store?.getSnapshot ?? getUnknown);
  return { store, presentation };
}

export function isValidWindowRect(rect: WindowRect): boolean {
  return (
    Number.isFinite(rect.x) &&
    Number.isFinite(rect.y) &&
    Number.isFinite(rect.width) &&
    Number.isFinite(rect.height) &&
    rect.width > 0 &&
    rect.height > 0
  );
}

function containsRect(container: WindowRect, child: WindowRect): boolean {
  return (
    child.x >= container.x - 0.5 &&
    child.y >= container.y - 0.5 &&
    child.x + child.width <= container.x + container.width + 0.5 &&
    child.y + child.height <= container.y + container.height + 0.5
  );
}

/** The Paper host need not start at the window origin (safe areas, split windows). */
export function resolveAccessoryMenuAnchor(
  source: WindowRect,
  root: WindowRect,
  accessory: WindowRect,
): WindowRect | null {
  if (
    !isValidWindowRect(source) ||
    !isValidWindowRect(root) ||
    !isValidWindowRect(accessory) ||
    !containsRect(accessory, source) ||
    !containsRect(root, source)
  )
    return null;
  return { x: source.x - root.x, y: source.y - root.y, width: source.width, height: source.height };
}
