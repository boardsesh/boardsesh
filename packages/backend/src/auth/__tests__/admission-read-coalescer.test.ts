import { describe, expect, it, vi } from 'vite-plus/test';
import { createAdmissionCoalescer } from '../admission-read-coalescer';
import { AUTH_ADMISSION_BATCH_SIZE, AuthAdmissionUnavailableError } from '../admission-read-runner';

function nextEventLoopTurn() {
  return new Promise<void>((resolve) => setImmediate(resolve));
}

describe('admission read coalescer', () => {
  it('serves a same-tick burst of distinct users from one read', async () => {
    const readActiveUserIds = vi.fn(async (userIds: readonly string[]) => new Set(userIds));
    const admit = createAdmissionCoalescer(readActiveUserIds);
    const userIds = Array.from({ length: 60 }, (_unused, index) => `user-${index}`);

    await expect(Promise.all(userIds.map(admit))).resolves.toEqual(userIds.map(() => true));

    expect(readActiveUserIds).toHaveBeenCalledTimes(1);
    expect(readActiveUserIds.mock.calls[0][0]).toEqual(userIds);
  });

  it('shares one lookup between callers asking about the same user', async () => {
    const readActiveUserIds = vi.fn(async (userIds: readonly string[]) => new Set(userIds));
    const admit = createAdmissionCoalescer(readActiveUserIds);

    await expect(Promise.all([admit('same'), admit('same'), admit('same')])).resolves.toEqual([true, true, true]);

    expect(readActiveUserIds.mock.calls[0][0]).toEqual(['same']);
  });

  it('answers each caller from the shared read', async () => {
    const admit = createAdmissionCoalescer(async () => new Set(['active']));

    await expect(Promise.all([admit('active'), admit('deleted-or-missing')])).resolves.toEqual([true, false]);
  });

  it('splits a burst larger than one batch', async () => {
    const readActiveUserIds = vi.fn(async (userIds: readonly string[]) => new Set(userIds));
    const admit = createAdmissionCoalescer(readActiveUserIds);
    const userIds = Array.from({ length: AUTH_ADMISSION_BATCH_SIZE + 1 }, (_unused, index) => `user-${index}`);

    await Promise.all(userIds.map(admit));

    expect(readActiveUserIds.mock.calls.map(([batchUserIds]) => batchUserIds.length)).toEqual([
      AUTH_ADMISSION_BATCH_SIZE,
      1,
    ]);
  });

  it('rejects every caller in a failed batch with the read error', async () => {
    const failure = new AuthAdmissionUnavailableError();
    const admit = createAdmissionCoalescer(async () => {
      throw failure;
    });

    const outcomes = await Promise.allSettled([admit('first'), admit('second')]);

    expect(outcomes).toEqual([
      { status: 'rejected', reason: failure },
      { status: 'rejected', reason: failure },
    ]);
  });

  it('never lets a caller join a read that has already started', async () => {
    let finishFirstRead = (_activeUserIds: ReadonlySet<string>) => {};
    const firstRead = new Promise<ReadonlySet<string>>((resolve) => {
      finishFirstRead = resolve;
    });
    const readActiveUserIds = vi
      .fn<(userIds: readonly string[]) => Promise<ReadonlySet<string>>>()
      .mockReturnValueOnce(firstRead)
      .mockResolvedValueOnce(new Set());
    const admit = createAdmissionCoalescer(readActiveUserIds);

    const earlyCaller = admit('account');
    await nextEventLoopTurn();
    expect(readActiveUserIds).toHaveBeenCalledTimes(1);

    // The account is deleted after the first read began, so the later caller
    // must get its own read rather than the in-flight positive answer.
    const lateCaller = admit('account');
    await nextEventLoopTurn();
    expect(readActiveUserIds).toHaveBeenCalledTimes(2);
    await expect(lateCaller).resolves.toBe(false);

    finishFirstRead(new Set(['account']));
    await expect(earlyCaller).resolves.toBe(true);
  });
});
