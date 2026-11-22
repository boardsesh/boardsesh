/** Native editors share one JS runtime. Hold the lease through the final storage drain. */
const owners = new Map<string, Promise<void>>();

export async function acquireSprayHoldEditorLease(key: string, signal: AbortSignal): Promise<() => void> {
  if (signal.aborted) throw new Error('Hold editor lease aborted');
  const previous = owners.get(key) ?? Promise.resolve();
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const queued = previous.then(() => held);
  owners.set(key, queued);
  const cleanUp = () => {
    release();
    if (owners.get(key) === queued) owners.delete(key);
  };
  try {
    await new Promise<void>((resolve, reject) => {
      const aborted = () => reject(new Error('Hold editor lease aborted'));
      signal.addEventListener('abort', aborted, { once: true });
      void previous.then(() => {
        signal.removeEventListener('abort', aborted);
        if (signal.aborted) aborted();
        else resolve();
      });
    });
    return cleanUp;
  } catch (error) {
    // Keep our place in the chain until the preceding owner releases it.
    void previous.then(cleanUp);
    throw error;
  }
}
