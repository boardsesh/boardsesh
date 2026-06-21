const wallConfirmListeners = new Set<(climbUuid: string) => void>();

export function subscribeToWallConfirm(callback: (climbUuid: string) => void): () => void {
  wallConfirmListeners.add(callback);
  return () => {
    wallConfirmListeners.delete(callback);
  };
}

export function emitWallConfirm(climbUuid: string): void {
  for (const listener of wallConfirmListeners) {
    try {
      listener(climbUuid);
    } catch (error) {
      console.error('wall-confirm listener threw:', error);
    }
  }
}
