import type { Client } from 'graphql-ws';

export type ClientOperationScope = {
  readonly getClient: (this: void) => Client;
  readonly assertCurrent: (this: void) => void;
};

type ClientGetter = () => Client;
const captures = new WeakMap<ClientGetter, { readonly capture: () => ClientOperationScope }>();

/** A platform may pin its current viewer once per operation while still using
 * a replacement transport for that same viewer after a confirmed rate limit.
 * Ordinary getters retain the existing retry behavior. */
export function registerClientOperationScope(getClient: ClientGetter, capture: () => ClientOperationScope): () => void {
  const registration = { capture };
  captures.set(getClient, registration);
  return () => {
    if (captures.get(getClient) === registration) captures.delete(getClient);
  };
}

/** Copy both functions before any operation work. Registry replacement,
 * cleanup or later mutation of the caller's returned object cannot rebind an
 * already-started operation. This scope carries no credential receipt. */
export function captureClientOperationScope(getClient: ClientGetter): ClientOperationScope | undefined {
  const registration = captures.get(getClient);
  if (!registration) return undefined;
  const { getClient: scopedGetter, assertCurrent } = registration.capture();
  return Object.freeze({ getClient: scopedGetter, assertCurrent });
}
