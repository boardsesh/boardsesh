import { describe, it, expect, vi } from 'vitest';
import { executeWithLatestWins } from '../use-queue-mutations';

interface TestArgs { id: string }

function createDeferred() {
  const calls: { args: TestArgs; resolve: () => void; reject: (e: Error) => void }[] = [];
  const fn = vi.fn((args: TestArgs) => new Promise<void>((resolve, reject) => {
    calls.push({ args, resolve, reject });
  }));
  return { fn, calls };
}

async function waitForCall(calls: { args: TestArgs }[], index: number) {
  const start = Date.now();
  while (calls.length <= index) {
    if (Date.now() - start > 1000) throw new Error(`Timed out waiting for call ${index}`);
    await new Promise(r => setTimeout(r, 5));
  }
}

describe('executeWithLatestWins', () => {
  it('executes a single call immediately and awaits it', async () => {
    const { fn, calls } = createDeferred();
    const refs = { inFlight: false, pending: null };

    const promise = executeWithLatestWins(refs, { id: 'a' }, fn);
    expect(fn).toHaveBeenCalledTimes(1);

    calls[0].resolve();
    await promise;
    expect(refs.inFlight).toBe(false);
  });

  it('supersedes intermediate calls — only first and latest are sent', async () => {
    const { fn, calls } = createDeferred();
    const refs = { inFlight: false, pending: null as TestArgs | null };

    const p1 = executeWithLatestWins(refs, { id: 'a' }, fn);
    // These two arrive while 'a' is in-flight
    executeWithLatestWins(refs, { id: 'b' }, fn);
    executeWithLatestWins(refs, { id: 'c' }, fn);

    expect(fn).toHaveBeenCalledTimes(1);

    // Complete 'a' — drain sends 'c', skipping 'b'
    calls[0].resolve();
    await waitForCall(calls, 1);
    expect(calls[1].args).toEqual({ id: 'c' });
    expect(fn).toHaveBeenCalledTimes(2);

    calls[1].resolve();
    await p1;
    expect(refs.inFlight).toBe(false);
  });

  it('calls onSupersede when a pending call is replaced', async () => {
    const { fn, calls } = createDeferred();
    const refs = { inFlight: false, pending: null as TestArgs | null };
    const onSupersede = vi.fn();

    executeWithLatestWins(refs, { id: 'a' }, fn);
    executeWithLatestWins(refs, { id: 'b' }, fn, onSupersede);
    // 'b' is now pending; 'c' supersedes it
    executeWithLatestWins(refs, { id: 'c' }, fn, onSupersede);

    expect(onSupersede).toHaveBeenCalledTimes(1);
    expect(onSupersede).toHaveBeenCalledWith({ id: 'b' });

    calls[0].resolve();
    await waitForCall(calls, 1);
    calls[1].resolve();
  });

  it('drains pending after in-flight error and re-throws', async () => {
    const { fn, calls } = createDeferred();
    const refs = { inFlight: false, pending: null as TestArgs | null };

    const p1 = executeWithLatestWins(refs, { id: 'a' }, fn);
    executeWithLatestWins(refs, { id: 'b' }, fn);

    calls[0].reject(new Error('network'));
    await waitForCall(calls, 1);
    expect(calls[1].args).toEqual({ id: 'b' });

    calls[1].resolve();
    await expect(p1).rejects.toThrow('network');
    expect(refs.inFlight).toBe(false);
  });

  it('resets state after drain error so next call works', async () => {
    const { fn, calls } = createDeferred();
    const refs = { inFlight: false, pending: null as TestArgs | null };

    const p1 = executeWithLatestWins(refs, { id: 'a' }, fn);
    executeWithLatestWins(refs, { id: 'b' }, fn);

    calls[0].resolve();
    await waitForCall(calls, 1);
    calls[1].reject(new Error('drain fail'));
    await p1;

    expect(refs.inFlight).toBe(false);

    // New call should work
    const p2 = executeWithLatestWins(refs, { id: 'c' }, fn);
    expect(fn).toHaveBeenCalledTimes(3);
    calls[2].resolve();
    await p2;
  });
});
