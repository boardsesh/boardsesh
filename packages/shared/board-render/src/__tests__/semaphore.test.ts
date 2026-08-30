import { describe, expect, it } from 'vitest';
import { createSemaphore } from '../semaphore';

/** A promise plus the handles to settle it from the test body. */
function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Drain the microtask queue so a just-released slot has reached its waiter. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('createSemaphore', () => {
  it('never runs more than `limit` tasks at once', async () => {
    const semaphore = createSemaphore(3);
    let running = 0;
    let highWaterMark = 0;

    const tasks = Array.from({ length: 10 }, () =>
      semaphore.run(async () => {
        running += 1;
        highWaterMark = Math.max(highWaterMark, running);
        // Yield across a few microtask turns so overlapping tasks can pile up.
        await Promise.resolve();
        await Promise.resolve();
        running -= 1;
      }),
    );

    await Promise.all(tasks);

    expect(highWaterMark).toBe(3);
    expect(semaphore.active).toBe(0);
    expect(semaphore.pending).toBe(0);
  });

  it('serves waiters in arrival order', async () => {
    const semaphore = createSemaphore(1);
    const started: number[] = [];
    const gates = [deferred(), deferred(), deferred()];

    const tasks = gates.map((gate, index) =>
      semaphore.run(async () => {
        started.push(index);
        await gate.promise;
      }),
    );

    // Only the first task holds the single slot; the rest are queued.
    await flush();
    expect(started).toEqual([0]);
    expect(semaphore.active).toBe(1);
    expect(semaphore.pending).toBe(2);

    gates[0].resolve();
    await tasks[0];
    await flush();
    expect(started).toEqual([0, 1]);

    gates[1].resolve();
    await tasks[1];
    await flush();
    expect(started).toEqual([0, 1, 2]);

    gates[2].resolve();
    await Promise.all(tasks);
    expect(semaphore.active).toBe(0);
  });

  it('serves request work before queued low-priority warmups', async () => {
    const semaphore = createSemaphore(1);
    const started: string[] = [];
    const activeGate = deferred();

    const active = semaphore.run(async () => {
      started.push('active');
      await activeGate.promise;
    });
    const warmup = semaphore.runLowPriority(async () => {
      started.push('warmup');
    });
    const request = semaphore.run(async () => {
      started.push('request');
    });

    await flush();
    expect(started).toEqual(['active']);
    expect(semaphore.pending).toBe(2);

    activeGate.resolve();
    await Promise.all([active, request, warmup]);
    expect(started).toEqual(['active', 'request', 'warmup']);
    expect(semaphore.active).toBe(0);
    expect(semaphore.pending).toBe(0);
  });

  it('releases the slot when a task throws', async () => {
    const semaphore = createSemaphore(1);

    await expect(
      semaphore.run(async () => {
        throw new Error('render exploded');
      }),
    ).rejects.toThrow('render exploded');

    expect(semaphore.active).toBe(0);
    expect(semaphore.pending).toBe(0);

    // The slot is reusable — a stranded one would hang this forever.
    await expect(semaphore.run(async () => 'ok')).resolves.toBe('ok');
  });

  it('clamps a nonsensical limit to one slot instead of deadlocking', async () => {
    const semaphore = createSemaphore(Number.NaN);
    let running = 0;
    let highWaterMark = 0;

    await Promise.all(
      Array.from({ length: 4 }, () =>
        semaphore.run(async () => {
          running += 1;
          highWaterMark = Math.max(highWaterMark, running);
          await Promise.resolve();
          running -= 1;
        }),
      ),
    );

    expect(highWaterMark).toBe(1);
  });
});
