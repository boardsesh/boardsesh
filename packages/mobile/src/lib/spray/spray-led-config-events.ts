const listeners = new Set<(wallUuid: string) => void>();

export function subscribeSprayLedConfiguration(listener: (wallUuid: string) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function notifySprayLedConfiguration(wallUuid: string): void {
  for (const listener of listeners) listener(wallUuid);
}
