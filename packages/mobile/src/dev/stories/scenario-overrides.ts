import type { SessionUser } from '@boardsesh/shared-schema';

/**
 * Live values a story can fake on top of the real app. Each field patches one
 * value the real provider computes; anything left out keeps the real value.
 *
 * The patch reaches only readers of the split queue contexts below
 * DevScenarioOverrides. These still see the real session, so judge what they
 * draw from the real app, not the story:
 * - full `useQueue()` readers: BluetoothProvider (the wall's session id),
 *   QueueBottomAccessory (the persistent queue bar) and LiveActivityBridge.
 *   QueueContext is left alone on purpose: patching it would start a Live
 *   Activity under a fake session id.
 * - BoardAdapterWrapper, which sits above DevScenarioOverrides, so tick logging
 *   files ticks under the real session id.
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
     * "Someone else is in this session", flag or no flag: who may move the wall
     * (the rest timer's auto-advance). Follows `isSharedSession` when left out,
     * so a crew story is a crew for both; set it on its own to fake a crew with
     * the browse flag off.
     */
    isCrewSession?: boolean;
    /**
     * A session id for display only. Nothing exists on the server under it,
     * so any request made with it fails.
     */
    sessionId?: string;
    /**
     * The roster the session screen and crew faces read. Also patches
     * `sessionMemberUserIds` on the session controls (the lightbulb's "is the
     * wall holder in my session"), from each member's `userId`.
     */
    sessionUsers?: SessionUser[];
  };
  /**
   * Who holds the wall, as the wall-driver rule sees it (the rest timer's crew
   * states, #5382): this phone, a named crewmate, or nobody. Patches only
   * `useSessionTimerDriver`, so the lightbulb and the Bluetooth surfaces keep
   * the real board link.
   */
  wall?: {
    connection: 'connectedByMe' | 'heldByPeer' | 'disconnected';
    holderDisplayName?: string | null;
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
