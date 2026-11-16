import type { MutationDeliveryEvent, MutationStatusListenerFailure } from '@boardsesh/offline-sync';

const listeners = new Set<(event: MutationDeliveryEvent) => void>();

export function subscribeMutationDelivery(listener: (event: MutationDeliveryEvent) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function publishMutationDeliveryEvent(
  event: MutationDeliveryEvent,
  onListenerError: (failure: MutationStatusListenerFailure) => void,
): void {
  for (const listener of listeners) {
    try {
      listener(event);
    } catch (error) {
      onListenerError({ error, event });
    }
  }
}
