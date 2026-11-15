import type { MutationDeliveryEvent, MutationStatusListenerFailure } from '@boardsesh/offline-sync';

const listeners = new Set<(event: MutationDeliveryEvent) => void>();

export function subscribeMutationDelivery(listener: (event: MutationDeliveryEvent) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function publishMutationDeliveryEvent(
  event: MutationDeliveryEvent,
  onListenerError: (failure: MutationStatusListenerFailure) => void,
  assertCurrent?: () => void,
): void {
  for (const listener of listeners) {
    assertCurrent?.();
    try {
      listener(event);
    } catch (error) {
      assertCurrent?.();
      onListenerError({ error, event });
    }
    assertCurrent?.();
  }
}
