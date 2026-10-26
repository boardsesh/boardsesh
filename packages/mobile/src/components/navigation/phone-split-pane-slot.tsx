import { createContext, useContext, useEffect, useSyncExternalStore, type ReactNode } from 'react';

type SetPaneContent = (content: ReactNode | null) => void;

/**
 * Lets a screen inside a tab put its own content in the phone split's leading
 * pane (iPhone Duo open in landscape) in place of the player. Provided by the
 * iPhone tab host in `NativeTabletContent`; absent everywhere else (iPad, the
 * Material shell, a root route), where `usePhoneSplitPaneContent` is a no-op.
 *
 * The value is the host's state setter, so it never changes identity and the
 * tab's screens never re-render because of it.
 */
export const PhoneSplitPaneSlotContext = createContext<SetPaneContent | null>(null);

// Whether a screen has the pane right now, so the drawer host sends climb taps to
// `/play` instead of a player that is not on screen. One flag is enough: a screen
// fills the pane only while it is the focused one.
let paneTaken = false;
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getPaneTaken(): boolean {
  return paneTaken;
}

function publishPaneTaken(taken: boolean): void {
  if (taken === paneTaken) return;
  paneTaken = taken;
  for (const listener of listeners) listener();
}

/** True while a screen's content, not the player, fills the split's pane. */
export function usePhoneSplitPaneTaken(): boolean {
  return useSyncExternalStore(subscribe, getPaneTaken, getPaneTaken);
}

/** Whether this screen sits in a tab host whose split pane it can fill. */
export function useHasPhoneSplitPaneSlot(): boolean {
  return useContext(PhoneSplitPaneSlotContext) !== null;
}

/**
 * Show `content` in the split's leading pane while it is non-null; null hands the
 * pane back to the player. Cleared on unmount, so a screen that leaves never
 * strands its content in the pane.
 */
export function usePhoneSplitPaneContent(content: ReactNode | null): void {
  const setPaneContent = useContext(PhoneSplitPaneSlotContext);
  const hasContent = content != null;
  useEffect(() => {
    setPaneContent?.(content);
  }, [setPaneContent, content]);
  useEffect(() => {
    if (!setPaneContent) return undefined;
    publishPaneTaken(hasContent);
    return () => publishPaneTaken(false);
  }, [setPaneContent, hasContent]);
  useEffect(() => () => setPaneContent?.(null), [setPaneContent]);
}

/** Test-only: back to the launch state. */
export function resetPhoneSplitPaneTakenForTests(): void {
  paneTaken = false;
  listeners.clear();
}
