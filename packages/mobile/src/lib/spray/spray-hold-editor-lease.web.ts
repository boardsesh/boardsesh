/** Web Locks protect the recovery record across tabs in this origin. */
export function acquireSprayHoldEditorLease(key: string, signal: AbortSignal): Promise<() => void> {
  return new Promise((resolve, reject) => {
    let lockManager: LockManager | undefined;
    try {
      lockManager = typeof navigator === 'undefined' ? undefined : navigator.locks;
    } catch (error) {
      reject(error);
      return;
    }
    if (!lockManager) {
      reject(new Error('Hold editor locking is unavailable'));
      return;
    }
    void lockManager
      .request(
        `boardsesh-hold-editor:${key}`,
        { mode: 'exclusive', signal },
        () =>
          new Promise<void>((release) => {
            resolve(release);
          }),
      )
      .catch(reject);
  });
}
