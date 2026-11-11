const listeners = new Set<() => void>();

export function subscribeAnalyticsIdentity(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function notifyAnalyticsIdentityChanged(): void {
  for (const listener of listeners) listener();
}
