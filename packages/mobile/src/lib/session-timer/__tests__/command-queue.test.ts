import { describe, expect, it, vi } from 'vitest';
import { createLatestWinsQueue } from '../command-queue';

/** A run whose every call waits for the test to finish it. */
function controlledRun() {
  const started: string[] = [];
  const finishers: Array<(error?: Error) => void> = [];
  const run = vi.fn(
    (command: string) =>
      new Promise<void>((resolve, reject) => {
        started.push(command);
        finishers.push((error) => (error ? reject(error) : resolve()));
      }),
  );
  /** Finish the oldest unfinished run, and let the queue move on. */
  const finishNext = async (error?: Error) => {
    finishers.shift()?.(error);
    await Promise.resolve();
    await Promise.resolve();
  };
  return { run, started, finishNext };
}

describe('createLatestWinsQueue', () => {
  it('runs a command at once when idle', () => {
    const { run, started } = controlledRun();
    const queue = createLatestWinsQueue(run);
    queue.push('a');
    expect(started).toEqual(['a']);
  });

  it('runs one command at a time', async () => {
    const { run, started, finishNext } = controlledRun();
    const queue = createLatestWinsQueue(run);
    queue.push('a');
    queue.push('b');
    expect(started).toEqual(['a']);
    await finishNext();
    expect(started).toEqual(['a', 'b']);
  });

  it('keeps only the newest command waiting', async () => {
    const { run, started, finishNext } = controlledRun();
    const queue = createLatestWinsQueue(run);
    queue.push('a');
    queue.push('b');
    queue.push('c');
    await finishNext();
    await finishNext();
    expect(started).toEqual(['a', 'c']);
  });

  it('drops a command the one in flight already delivers, and what was waiting', async () => {
    const { run, started, finishNext } = controlledRun();
    const queue = createLatestWinsQueue(run, { absorbs: (inFlight, incoming) => inFlight === incoming });
    queue.push('restart');
    queue.push('reset');
    queue.push('restart');
    await finishNext();
    expect(started).toEqual(['restart']);
  });

  it('queues a command the one in flight does not deliver', async () => {
    const { run, started, finishNext } = controlledRun();
    const queue = createLatestWinsQueue(run, { absorbs: (inFlight, incoming) => inFlight === incoming });
    queue.push('reset');
    queue.push('restart');
    await finishNext();
    expect(started).toEqual(['reset', 'restart']);
  });

  it('carries on after a run throws, and reports it', async () => {
    const { run, started, finishNext } = controlledRun();
    const onError = vi.fn();
    const queue = createLatestWinsQueue(run, { onError });
    queue.push('a');
    queue.push('b');
    await finishNext(new Error('link dropped'));
    expect(onError).toHaveBeenCalledWith(new Error('link dropped'), 'a');
    expect(started).toEqual(['a', 'b']);
  });

  it('swallows a failure with no reporter', async () => {
    const { run, started, finishNext } = controlledRun();
    const queue = createLatestWinsQueue(run);
    queue.push('a');
    await finishNext(new Error('link dropped'));
    queue.push('b');
    expect(started).toEqual(['a', 'b']);
  });

  it('drops what is waiting and accepts nothing once disposed', async () => {
    const { run, started, finishNext } = controlledRun();
    const queue = createLatestWinsQueue(run);
    queue.push('a');
    queue.push('b');
    queue.dispose();
    queue.push('c');
    await finishNext();
    expect(started).toEqual(['a']);
  });

  it('runs again once idle', async () => {
    const { run, started, finishNext } = controlledRun();
    const queue = createLatestWinsQueue(run);
    queue.push('a');
    await finishNext();
    queue.push('b');
    expect(started).toEqual(['a', 'b']);
  });
});
