import type { GraphQLFetch } from '../mutation-queue/handlers';

/** Platform-issued in-process capabilities. Never serialized with durable intent. */
export type CapturedSyncRequest = Readonly<{
  kind: 'selected' | 'legacy';
  fetch: GraphQLFetch;
  assertView: (this: void) => void;
  assertDeliveries: (this: void) => void;
  assertErrorDeliveries: (this: void, error: unknown) => void;
  dispose: (this: void) => void;
}>;

export type CapturedSyncSession = Readonly<{
  kind: 'selected' | 'legacy';
  userId: string;
  assertView: (this: void) => void;
  beginRequest: (this: void) => CapturedSyncRequest;
  dispose: (this: void) => void;
}>;

const heldRequests = new WeakSet<object>();
/** Holding an ambiguous request never authorizes a persistent failure verdict. */
export function holdSyncRequest(): Error {
  const error = new Error('Offline request ownership is unavailable');
  heldRequests.add(error);
  return error;
}
export function isSyncRequestHeld(error: unknown): boolean {
  return error !== null && typeof error === 'object' && heldRequests.has(error);
}
