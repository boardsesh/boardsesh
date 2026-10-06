import { beforeEach, describe, expect, it, vi } from 'vitest';

const storage = vi.hoisted(() => ({
  read: vi.fn(async () => null),
  write: vi.fn(async (_key: string, _sessionId: string) => {}),
  remove: vi.fn(async (_key: string) => {}),
}));
vi.mock('../secure-store-io', () => ({
  readSecureValue: storage.read,
  writeSecureValue: storage.write,
  deleteSecureValue: storage.remove,
}));

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
});

describe('session identity persistence ordering', () => {
  it('finishes an old teardown before persisting a newer join and provenance', async () => {
    const { clearStoredSessionId, clearStoredCreatedSessionId, setStoredSessionId, setStoredCreatedSessionId } =
      await import('../session-store');
    let finishRemoval: (() => void) | undefined;
    storage.remove.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishRemoval = resolve;
        }),
    );
    const removingSession = clearStoredSessionId();
    const removingProvenance = clearStoredCreatedSessionId();
    await Promise.resolve();
    const joining = setStoredSessionId('new-room');
    const creating = setStoredCreatedSessionId('new-room');
    expect(storage.write).not.toHaveBeenCalled();
    expect(finishRemoval).toBeDefined();
    finishRemoval?.();
    await Promise.all([removingSession, removingProvenance, joining, creating]);
    expect(storage.remove).toHaveBeenCalledTimes(2);
    expect(storage.write).toHaveBeenCalledTimes(2);
    expect(storage.remove.mock.invocationCallOrder[1]).toBeLessThan(storage.write.mock.invocationCallOrder[0]);
    expect(storage.write.mock.calls.every((call) => call[1] === 'new-room')).toBe(true);
  });
});
