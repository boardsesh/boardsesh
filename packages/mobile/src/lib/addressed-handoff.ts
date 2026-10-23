// One channel a pushed picker route hands its result back through, addressed to
// the opener that pushed it. Every filter picker handoff (Setters, Hold types,
// Board region, the Logbook's setters) is one of these: more than one opener can
// be mounted at once (the Climbs tab's sheet stays suspended under a setter page
// whose own sheet then opens Hold types; two Logbooks in two tabs), so each push
// carries the opener's id (lib/filter-picker-handoff-id.ts) and a result reaches
// the subscribers under that id alone. An empty id (a route opened without one,
// a deep link) reaches nobody.

export type AddressedHandoff<Payload> = {
  emit: (handoffId: string, payload: Payload) => void;
  /** Listens for the results handed back to `handoffId` only. Returns the unsubscribe. */
  subscribe: (handoffId: string, listener: (payload: Payload) => void) => () => void;
};

export function createAddressedHandoff<Payload>(): AddressedHandoff<Payload> {
  const subscriptions = new Set<{ handoffId: string; listener: (payload: Payload) => void }>();
  return {
    emit(handoffId, payload) {
      if (!handoffId) return;
      for (const subscription of subscriptions) {
        if (subscription.handoffId === handoffId) subscription.listener(payload);
      }
    },
    subscribe(handoffId, listener) {
      const subscription = { handoffId, listener };
      subscriptions.add(subscription);
      return () => {
        subscriptions.delete(subscription);
      };
    },
  };
}
