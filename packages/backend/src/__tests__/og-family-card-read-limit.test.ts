import { describe, expect, it } from 'vitest';
import { CardReadsSaturatedError, runCardRead } from '../services/og-family/card-read-limit';

function deferred() {
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { gate, release };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

describe('runCardRead', () => {
  it('runs one read at a time and sheds past the queue without starting it', async () => {
    const { gate, release } = deferred();
    let running = 0;
    let mostAtOnce = 0;
    const read = async () => {
      running += 1;
      mostAtOnce = Math.max(mostAtOnce, running);
      await gate;
      running -= 1;
    };

    const accepted = Array.from({ length: 9 }, () => runCardRead(read));
    await settle();
    expect(running).toBe(1);

    let started = false;
    await expect(
      runCardRead(async () => {
        started = true;
      }),
    ).rejects.toBeInstanceOf(CardReadsSaturatedError);
    expect(started).toBe(false);

    release();
    await Promise.all(accepted);
    expect(mostAtOnce).toBe(1);
  });

  it('frees the slot when a read fails', async () => {
    await expect(runCardRead(() => Promise.reject(new Error('database down')))).rejects.toThrow('database down');

    await expect(runCardRead(async () => 'next')).resolves.toBe('next');
  });
});
