// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { reportError } from '../error-reporting';

vi.mock('../error-reporting', () => ({ reportError: vi.fn() }));
afterEach(cleanup);

vi.mock('@react-native-async-storage/async-storage', () => {
  let storage: Record<string, string> = {};
  return {
    default: {
      getItem: vi.fn(async (key: string) => storage[key] ?? null),
      setItem: vi.fn(async (key: string, value: string) => {
        storage[key] = value;
      }),
      removeItem: vi.fn(async (key: string) => {
        delete storage[key];
      }),
      __reset: () => {
        storage = {};
      },
      __setRaw: (key: string, value: string) => {
        storage[key] = value;
      },
    },
  };
});

async function asyncStorageMock() {
  return (await import('@react-native-async-storage/async-storage')).default as unknown as {
    __reset: () => void;
    __setRaw: (key: string, value: string) => void;
    getItem: Mock<(key: string) => Promise<string | null>>;
    setItem: Mock<(key: string, serializedValue: string) => Promise<void>>;
  };
}

describe('climb-list-density-preference', () => {
  beforeEach(async () => {
    vi.resetModules();
    (await asyncStorageMock()).__reset();
  });

  it('leaves the choice unset when nothing is stored, so the default tier wins', async () => {
    const { loadClimbListDensityChoice } = await import('../climb-list-density-preference');
    await expect(loadClimbListDensityChoice()).resolves.toBeUndefined();
  });

  it('honours an explicit compact choice persisted from a previous session', async () => {
    (await asyncStorageMock()).__setRaw('climbListDensity', JSON.stringify('compact'));

    const { loadClimbListDensityChoice } = await import('../climb-list-density-preference');
    await expect(loadClimbListDensityChoice()).resolves.toBe('compact');
  });

  it('honours an explicit rich choice persisted from a previous session', async () => {
    (await asyncStorageMock()).__setRaw('climbListDensity', JSON.stringify('rich'));

    const { loadClimbListDensityChoice } = await import('../climb-list-density-preference');
    await expect(loadClimbListDensityChoice()).resolves.toBe('rich');
  });

  it('keeps an explicit default choice, rather than collapsing it back to "unset"', async () => {
    (await asyncStorageMock()).__setRaw('climbListDensity', JSON.stringify('default'));

    const { loadClimbListDensityChoice } = await import('../climb-list-density-preference');
    await expect(loadClimbListDensityChoice()).resolves.toBe('default');
  });

  it('ignores a stored value that is not a density tier', async () => {
    (await asyncStorageMock()).__setRaw('climbListDensity', JSON.stringify('enormous'));

    const { loadClimbListDensityChoice } = await import('../climb-list-density-preference');
    await expect(loadClimbListDensityChoice()).resolves.toBeUndefined();
  });

  it('persists the climber choice', async () => {
    const { loadClimbListDensityChoice, setClimbListDensityPreference } =
      await import('../climb-list-density-preference');
    await setClimbListDensityPreference('compact');
    await expect(loadClimbListDensityChoice()).resolves.toBe('compact');
    await expect((await asyncStorageMock()).getItem('climbListDensity')).resolves.toBe(JSON.stringify('compact'));
  });

  it('lets a set() that races in during the initial load win over the (now stale) persisted value', async () => {
    const asyncStorage = await asyncStorageMock();
    // Persisted value is `rich`, but gate the read so it resolves only after the
    // user's explicit choice has already landed.
    asyncStorage.__setRaw('climbListDensity', JSON.stringify('rich'));
    let releaseRead: () => void = () => {};
    const readGate = new Promise<void>((resolve) => {
      releaseRead = resolve;
    });
    asyncStorage.getItem.mockImplementationOnce(async () => {
      await readGate;
      return JSON.stringify('rich');
    });

    const { loadClimbListDensityChoice, setClimbListDensityPreference } =
      await import('../climb-list-density-preference');

    const loadPromise = loadClimbListDensityChoice();
    // The climber's explicit compact choice lands while the (slow) disk read is
    // still in flight.
    await setClimbListDensityPreference('compact');
    releaseRead();

    await expect(loadPromise).resolves.toBe('compact');
  });

  it('leaves the store unloaded when the storage read rejects, so a later read retries', async () => {
    const asyncStorage = await asyncStorageMock();
    asyncStorage.getItem.mockRejectedValueOnce(new Error('locked before first unlock'));

    const { loadClimbListDensityChoice } = await import('../climb-list-density-preference');
    await expect(loadClimbListDensityChoice()).rejects.toThrow('locked before first unlock');

    asyncStorage.__setRaw('climbListDensity', JSON.stringify('compact'));
    await expect(loadClimbListDensityChoice()).resolves.toBe('compact');
  });

  it('keeps the chosen density usable and reports a failed preference write', async () => {
    const storageFailure = new Error('preference storage unavailable');
    (await asyncStorageMock()).setItem.mockRejectedValueOnce(storageFailure);
    const { useClimbListDensity } = await import('../climb-list-density-preference');
    const { result } = renderHook(() => useClimbListDensity());
    await waitFor(() => expect(result.current.loaded).toBe(true));
    await act(async () => result.current.setDensity('compact'));
    expect(result.current.density).toBe('compact');
    expect(reportError).toHaveBeenCalledWith(storageFailure, {
      tags: { source: 'climb-list-density-preference' },
    });
  });
});
