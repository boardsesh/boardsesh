import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { write, createDirectory } = vi.hoisted(() => ({ write: vi.fn(), createDirectory: vi.fn() }));
vi.mock('expo-file-system', () => ({
  Directory: class {
    create = createDirectory;
  },
  File: class {
    write = write;
  },
  Paths: { document: 'documents' },
}));

type ProfileHandle = { snapshot: () => { runId: string; marks: { name: string }[] }; flush: () => Promise<void> };
const profilingGlobal = globalThis as typeof globalThis & { __boardseshStartupProfile?: ProfileHandle };

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  write.mockReset();
  createDirectory.mockReset();
  delete profilingGlobal.__boardseshStartupProfile;
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  delete profilingGlobal.__boardseshStartupProfile;
});

describe('startup artifact lifecycle', () => {
  it('does not expose a profiling global, timer, or file in normal builds', async () => {
    vi.stubEnv('EXPO_PUBLIC_PROFILE_STARTUP', undefined);
    const { markStartup } = await import('../startup-profile');
    markStartup('home.useful.commit', 'content');
    expect(profilingGlobal.__boardseshStartupProfile).toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
    expect(write).not.toHaveBeenCalled();
  });

  it('defers export beyond the measured commit and skips duplicate revisions', async () => {
    vi.stubEnv('EXPO_PUBLIC_PROFILE_STARTUP', '1');
    const { markStartup } = await import('../startup-profile');
    markStartup('home.useful.commit', 'content');
    expect(write).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(write).toHaveBeenCalledTimes(1);
    const artifact = JSON.parse(write.mock.calls[0][0] as string) as { runId: string; marks: { name: string }[] };
    expect(artifact.runId).not.toBe('');
    expect(artifact.marks.map(({ name }) => name)).toEqual(['collector.loaded', 'home.useful.commit']);
    markStartup('home.useful.commit', 'empty');
    await profilingGlobal.__boardseshStartupProfile?.flush();
    expect(write).toHaveBeenCalledTimes(1);
    markStartup('sqlite.recovery.end', 'ready');
    await vi.advanceTimersByTimeAsync(1_000);
    expect(write).toHaveBeenCalledTimes(2);
  });

  it('exports incomplete launches and tolerates unavailable local disk', async () => {
    vi.stubEnv('EXPO_PUBLIC_PROFILE_STARTUP', '1');
    write.mockImplementationOnce(() => {
      throw new Error('disk unavailable');
    });
    await import('../startup-profile');
    await vi.advanceTimersByTimeAsync(10_000);
    expect(write).toHaveBeenCalledTimes(1);
    await profilingGlobal.__boardseshStartupProfile?.flush();
    expect(write).toHaveBeenCalledTimes(2);
  });
});
