import { describe, expect, it, vi } from 'vite-plus/test';
import {
  createAdmissionCoalescer,
  MAX_CONCURRENT_COALESCED_ADMISSION_READS,
  MAX_WAITING_ADMISSION_USERS,
} from '../admission-read-coalescer';
import {
  AUTH_ADMISSION_BATCH_SIZE,
  AUTH_ADMISSION_RESPONSE_DEADLINE_MS,
  AuthAdmissionUnavailableError,
} from '../admission-read-runner';

function nextEventLoopTurn() {
  return new Promise<void>((resolve) => setImmediate(resolve));
}

/** The read's answer for each user it found active: here, the user's own ID. */
function answerFor(userIds: Iterable<string>): ReadonlyMap<string, string> {
  return new Map([...userIds].map((userId) => [userId, `state-of-${userId}`]));
}

describe('admission read coalescer', () => {
  it('serves a same-tick burst of distinct users from one read', async () => {
    const readActiveUserIds = vi.fn(async (userIds: readonly string[]) => answerFor(userIds));
    const admit = createAdmissionCoalescer(readActiveUserIds);
    const userIds = Array.from({ length: 60 }, (_unused, index) => `user-${index}`);

    await expect(Promise.all(userIds.map(admit))).resolves.toEqual(userIds.map((userId) => `state-of-${userId}`));

    expect(readActiveUserIds).toHaveBeenCalledTimes(1);
    expect(readActiveUserIds.mock.calls[0][0]).toEqual(userIds);
  });

  it('shares one lookup between callers asking about the same user', async () => {
    const readActiveUserIds = vi.fn(async (userIds: readonly string[]) => answerFor(userIds));
    const admit = createAdmissionCoalescer(readActiveUserIds);

    await expect(Promise.all([admit('same'), admit('same'), admit('same')])).resolves.toEqual([
      'state-of-same',
      'state-of-same',
      'state-of-same',
    ]);

    expect(readActiveUserIds.mock.calls[0][0]).toEqual(['same']);
  });

  it('answers each caller from the shared read', async () => {
    const admit = createAdmissionCoalescer(async () => answerFor(['active']));

    await expect(Promise.all([admit('active'), admit('deleted-or-missing')])).resolves.toEqual([
      'state-of-active',
      undefined,
    ]);
  });

  it('splits a burst larger than one batch', async () => {
    const readActiveUserIds = vi.fn(async (userIds: readonly string[]) => answerFor(userIds));
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
    let finishFirstRead = (_answers: ReadonlyMap<string, string>) => {};
    const firstRead = new Promise<ReadonlyMap<string, string>>((resolve) => {
      finishFirstRead = resolve;
    });
    const readActiveUserIds = vi
      .fn<(userIds: readonly string[]) => Promise<ReadonlyMap<string, string>>>()
      .mockReturnValueOnce(firstRead)
      .mockResolvedValueOnce(new Map());
    const admit = createAdmissionCoalescer(readActiveUserIds);

    const earlyCaller = admit('account');
    await nextEventLoopTurn();
    expect(readActiveUserIds).toHaveBeenCalledTimes(1);

    // The account is deleted after the first read began, so the later caller
    // must get its own read rather than the in-flight positive answer.
    const lateCaller = admit('account');
    await nextEventLoopTurn();
    expect(readActiveUserIds).toHaveBeenCalledTimes(2);
    await expect(lateCaller).resolves.toBeUndefined();

    finishFirstRead(answerFor(['account']));
    await expect(earlyCaller).resolves.toBe('state-of-account');
  });

  /** Occupies every read with one caller each, in separate event-loop turns. */
  async function saturate() {
    const finishReads: Array<() => void> = [];
    const readActiveUserIds = vi.fn(
      (userIds: readonly string[]) =>
        new Promise<ReadonlyMap<string, string>>((resolve) => {
          finishReads.push(() => resolve(answerFor(userIds)));
        }),
    );
    const admit = createAdmissionCoalescer(readActiveUserIds);
    const runningCallers: Promise<string | undefined>[] = [];
    for (let index = 0; index < MAX_CONCURRENT_COALESCED_ADMISSION_READS; index += 1) {
      runningCallers.push(admit(`running-${index}`));
      await nextEventLoopTurn();
    }
    expect(readActiveUserIds).toHaveBeenCalledTimes(MAX_CONCURRENT_COALESCED_ADMISSION_READS);
    const finishRead = async (index: number) => {
      finishReads[index]();
      await nextEventLoopTurn();
    };
    return { admit, readActiveUserIds, runningCallers, finishRead, finishReads };
  }

  it('holds a caller while every read is busy, then gives it a fresh read', async () => {
    const { admit, readActiveUserIds, runningCallers, finishRead, finishReads } = await saturate();

    const heldCaller = admit('held');
    await nextEventLoopTurn();
    expect(readActiveUserIds).toHaveBeenCalledTimes(MAX_CONCURRENT_COALESCED_ADMISSION_READS);

    await finishRead(0);
    await nextEventLoopTurn();
    expect(readActiveUserIds).toHaveBeenCalledTimes(MAX_CONCURRENT_COALESCED_ADMISSION_READS + 1);
    expect(readActiveUserIds.mock.calls.at(-1)?.[0]).toEqual(['held']);

    for (const finish of finishReads.slice(1)) finish();
    await expect(heldCaller).resolves.toBe('state-of-held');
    await Promise.all(runningCallers);
  });

  it('refuses a held caller once it has waited past the deadline', async () => {
    let clock = 0;
    const nowSpy = vi.spyOn(performance, 'now').mockImplementation(() => clock);
    try {
      const { admit, readActiveUserIds, runningCallers, finishRead, finishReads } = await saturate();

      const heldCaller = admit('held');
      const heldOutcome = heldCaller.catch((error: unknown) => error);
      await nextEventLoopTurn();
      clock += AUTH_ADMISSION_RESPONSE_DEADLINE_MS;
      await finishRead(0);
      await nextEventLoopTurn();

      await expect(heldOutcome).resolves.toBeInstanceOf(AuthAdmissionUnavailableError);
      expect(readActiveUserIds).toHaveBeenCalledTimes(MAX_CONCURRENT_COALESCED_ADMISSION_READS);
      for (const finish of finishReads.slice(1)) finish();
      await Promise.all(runningCallers);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('refuses new users once the waiting list is full', async () => {
    const { admit, runningCallers, finishReads } = await saturate();

    const heldCallers = Array.from({ length: MAX_WAITING_ADMISSION_USERS }, (_unused, index) => admit(`held-${index}`));
    await expect(admit('one-too-many')).rejects.toBeInstanceOf(AuthAdmissionUnavailableError);

    for (const finish of finishReads) finish();
    await Promise.all(runningCallers);
    for (;;) {
      const pending = finishReads.splice(0);
      if (pending.length === 0 && finishReads.length === 0) {
        await nextEventLoopTurn();
        if (finishReads.length === 0) break;
      }
      for (const finish of pending) finish();
      await nextEventLoopTurn();
    }
    await Promise.all(heldCallers);
  });

  it('shares two read slots between coalescers of one group, and lets a waiting one in first', async () => {
    const finishReads: Array<() => void> = [];
    const pendingRead = (userIds: readonly string[]) =>
      new Promise<ReadonlyMap<string, string>>((resolve) => finishReads.push(() => resolve(answerFor(userIds))));
    // Created first, like the account read at startup.
    const readSubjects = vi.fn(pendingRead);
    const readSessions = vi.fn(pendingRead);
    const admitSubject = createAdmissionCoalescer(readSubjects, 'per-request');
    const admitSession = createAdmissionCoalescer(readSessions, 'per-request');
    const sessions = [admitSession('session-0')];
    await nextEventLoopTurn();
    sessions.push(admitSession('session-1'));
    await nextEventLoopTurn();
    expect(readSessions).toHaveBeenCalledTimes(MAX_CONCURRENT_COALESCED_ADMISSION_READS);
    // Both slots are taken by the session reads: the account read waits.
    const subject = admitSubject('native-climber');
    sessions.push(admitSession('session-2'));
    await nextEventLoopTurn();
    expect(readSubjects).not.toHaveBeenCalled();
    expect(readSessions).toHaveBeenCalledTimes(2);
    finishReads[0]();
    await nextEventLoopTurn();
    await nextEventLoopTurn();
    // The freed slot goes to the waiting account read, not to the next session read.
    expect(readSubjects).toHaveBeenCalledTimes(1);
    expect(readSessions).toHaveBeenCalledTimes(2);
    finishReads[1]();
    await nextEventLoopTurn();
    await nextEventLoopTurn();
    expect(readSessions).toHaveBeenCalledTimes(3);
    for (const finish of finishReads.slice(2)) finish();
    await expect(subject).resolves.toBe('state-of-native-climber');
    await expect(Promise.all(sessions)).resolves.toEqual([
      'state-of-session-0',
      'state-of-session-1',
      'state-of-session-2',
    ]);
  });

  it('keeps a coalescer without a group on its own two slots', async () => {
    const finishReads: Array<() => void> = [];
    const pendingRead = (userIds: readonly string[]) =>
      new Promise<ReadonlyMap<string, string>>((resolve) => finishReads.push(() => resolve(answerFor(userIds))));
    const first = vi.fn(pendingRead);
    const second = vi.fn(pendingRead);
    const admitFirst = createAdmissionCoalescer(first);
    const admitSecond = createAdmissionCoalescer(second);
    const callers = [admitFirst('a'), admitFirst('b')];
    await nextEventLoopTurn();
    callers.push(admitFirst('c'), admitSecond('d'));
    await nextEventLoopTurn();
    expect(second).toHaveBeenCalledTimes(1);
    for (let index = 0; index < 4; index += 1) {
      for (const finish of finishReads.splice(0)) finish();
      await nextEventLoopTurn();
    }
    await Promise.all(callers);
  });
});
