import type { SessionUser } from '@boardsesh/shared-schema';

/**
 * Live values a story can fake on top of the real app. Each field patches one
 * value the real provider computes; anything left out keeps the real value.
 *
 * Add a field here when a screen's state depends on something you can't reach
 * on a simulator alone (a second phone, a lit wall, a server push), and patch it
 * in DevScenarioOverrides.
 */
export type ScenarioOverrides = {
  queue?: {
    /**
     * "Someone else is in this session with me". This is what switches the
     * play drawer and the climb list to browse-first in a crew (#4281).
     */
    isSharedSession?: boolean;
    /**
     * A session id for display only. Nothing exists on the server under it,
     * so any request made with it fails.
     */
    sessionId?: string;
    /** The roster the session screen and crew faces read. */
    sessionUsers?: SessionUser[];
  };
};

type Listener = () => void;

let current: ScenarioOverrides | null = null;
const listeners = new Set<Listener>();

export function getScenarioOverrides(): ScenarioOverrides | null {
  return current;
}

export function setScenarioOverrides(next: ScenarioOverrides | null): void {
  if (next === current) return;
  current = next;
  if (__DEV__) {
    // Agents read this line from the Metro log to confirm a scenario took.
    // eslint-disable-next-line no-console
    console.log(`[stories] scenario overrides ${next ? JSON.stringify(next) : 'cleared'}`);
  }
  for (const listener of listeners) listener();
}

export function subscribeScenarioOverrides(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
