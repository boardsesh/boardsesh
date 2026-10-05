/** Orders snapshot writes and fences callbacks scheduled before a clear. */
export function createQueueSnapshotWriteLane() {
  let generation = 0;
  let writeQueue: Promise<void> = Promise.resolve();

  function enqueue(write: () => Promise<void>): Promise<void> {
    const operation = writeQueue.then(write, write);
    writeQueue = operation.catch(() => undefined);
    return operation;
  }

  return {
    getGeneration: () => generation,
    write(write: () => Promise<void>, expectedGeneration = generation): Promise<void> {
      return enqueue(async () => {
        if (expectedGeneration !== generation) return;
        await write();
      });
    },
    clear(remove: () => Promise<void>): Promise<void> {
      generation += 1;
      return enqueue(remove);
    },
  };
}
