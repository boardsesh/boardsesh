import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { logger } from '../../utils/logger';
import { ADMISSION_READ_LOG_WINDOW_MS } from '../admission-read-diagnostics';
import {
  __resetAuthAdmissionDiagnosticsForTests,
  AuthAdmissionUnavailableError,
  AUTH_ADMISSION_RESPONSE_DEADLINE_MS,
  AUTH_ADMISSION_SLOW_READ_MS,
  MAX_UNSETTLED_AUTH_ADMISSION_READS,
  runAuthAdmissionRead,
} from '../admission-read-runner';

// The production runner is pure: no database import, admission bypass or mock
// of the actual primary predicate is needed to exercise its resource contract.
let clock = 0;
const finishReads: Array<() => void> = [];
const outcomes: Promise<unknown>[] = [];

function deferred<Result>(fallback: Result) {
  let resolve = (_result: Result) => {};
  let reject = (_error: Error) => {};
  const promise = new Promise<Result>((complete, fail) => {
    resolve = complete;
    reject = fail;
  });
  finishReads.push(() => resolve(fallback));
  return { promise, resolve, reject };
}
function observed<Result>(promise: Promise<Result>): Promise<Result> {
  outcomes.push(
    promise.then(
      (result) => result,
      () => undefined,
    ),
  );
  return promise;
}
async function advance(milliseconds: number) {
  clock += milliseconds;
  await vi.advanceTimersByTimeAsync(milliseconds);
}

describe('bounded primary-admission read response contract', () => {
  beforeEach(() => {
    clock = 0;
    vi.useFakeTimers();
    vi.spyOn(performance, 'now').mockImplementation(() => clock);
  });
  afterEach(async () => {
    for (const finish of finishReads.splice(0)) finish();
    await Promise.allSettled(outcomes.splice(0));
    await Promise.resolve();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('returns actual results without caching an earlier authority decision', async () => {
    const read = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    expect(await observed(runAuthAdmissionRead(read))).toBe(false);
    expect(await observed(runAuthAdmissionRead(read))).toBe(true);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('maps synchronous and asynchronous private failures to a fixed unavailable error', async () => {
    const privateFailure = new Error('owned-private-database-cause');
    for (const read of [
      () => {
        throw privateFailure;
      },
      () => Promise.reject(privateFailure),
    ]) {
      const result = await observed(runAuthAdmissionRead(read)).catch((error) => error as unknown);
      expect(result).toBeInstanceOf(AuthAdmissionUnavailableError);
      expect(result).toMatchObject({ message: 'Authentication is temporarily unavailable' });
      expect(result).not.toHaveProperty('cause');
      expect(result).not.toBe(privateFailure);
    }
  });

  it('times out while the actual read remains pending', async () => {
    const source = deferred(true);
    const result = observed(runAuthAdmissionRead(() => source.promise));
    const rejected = expect(result).rejects.toBeInstanceOf(AuthAdmissionUnavailableError);
    await advance(AUTH_ADMISSION_RESPONSE_DEADLINE_MS);
    await rejected;
    source.resolve(true);
    await Promise.resolve();
  });

  it.each([true, false])('discards a late %j even before the overdue timer callback runs', async (expected) => {
    const source = deferred(expected);
    const result = observed(runAuthAdmissionRead(() => source.promise));
    await Promise.resolve();
    clock = AUTH_ADMISSION_RESPONSE_DEADLINE_MS;
    source.resolve(expected);
    await expect(result).rejects.toBeInstanceOf(AuthAdmissionUnavailableError);
  });

  it('accepts a settled response strictly before the deadline', async () => {
    const source = deferred(true);
    const result = observed(runAuthAdmissionRead(() => source.promise));
    await Promise.resolve();
    clock = AUTH_ADMISSION_RESPONSE_DEADLINE_MS - 1;
    source.resolve(true);
    await expect(result).resolves.toBe(true);
  });

  it('retains all eight slots after response timeouts and recovers only on actual settlement', async () => {
    const sources = Array.from({ length: MAX_UNSETTLED_AUTH_ADMISSION_READS }, () => deferred(false));
    const waiting = sources.map((source) => observed(runAuthAdmissionRead(() => source.promise)));
    const rejected = Promise.all(
      waiting.map((result) => expect(result).rejects.toBeInstanceOf(AuthAdmissionUnavailableError)),
    );
    await advance(AUTH_ADMISSION_RESPONSE_DEADLINE_MS);
    await rejected;
    const excessRead = vi.fn().mockResolvedValue(true);
    await expect(observed(runAuthAdmissionRead(excessRead))).rejects.toBeInstanceOf(AuthAdmissionUnavailableError);
    expect(excessRead).not.toHaveBeenCalled();

    sources[0].resolve(false);
    for (let turn = 0; turn < 5; turn++) await Promise.resolve();
    await expect(observed(runAuthAdmissionRead(excessRead))).resolves.toBe(true);
    expect(excessRead).toHaveBeenCalledOnce();
    await expect(observed(runAuthAdmissionRead(excessRead))).resolves.toBe(true);
    for (const source of sources) source.resolve(false);
  });

  it('releases a retained slot after a late rejection without leaking an unhandled error', async () => {
    const source = deferred(false);
    const result = observed(runAuthAdmissionRead(() => source.promise));
    const rejected = expect(result).rejects.toBeInstanceOf(AuthAdmissionUnavailableError);
    await advance(AUTH_ADMISSION_RESPONSE_DEADLINE_MS);
    await rejected;
    source.reject(new Error('owned-late-read-failure'));
    await Promise.resolve();
    await Promise.resolve();
    await expect(observed(runAuthAdmissionRead(() => Promise.resolve(true)))).resolves.toBe(true);
  });
});

describe('admission read timing log', () => {
  let warn: ReturnType<typeof vi.spyOn>;

  /** A read that reports it reached a connection after `waitMs`, and is still running. */
  async function readReachingConnectionAfter(waitMs: number) {
    const source = deferred(true);
    let markExecuting = () => {};
    const result = observed(
      runAuthAdmissionRead((mark) => {
        markExecuting = mark;
        return source.promise;
      }),
    );
    await Promise.resolve();
    await advance(waitMs);
    markExecuting();
    return { source, result };
  }

  beforeEach(() => {
    clock = 0;
    vi.useFakeTimers();
    vi.spyOn(performance, 'now').mockImplementation(() => clock);
    __resetAuthAdmissionDiagnosticsForTests();
    warn = vi.spyOn(logger, 'warn').mockImplementation(() => logger);
  });
  afterEach(async () => {
    for (const finish of finishReads.splice(0)) finish();
    await Promise.allSettled(outcomes.splice(0));
    await Promise.resolve();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('logs nothing for a read answered quickly', async () => {
    const { source, result } = await readReachingConnectionAfter(1);
    source.resolve(true);
    await expect(result).resolves.toBe(true);
    expect(warn).not.toHaveBeenCalled();
  });

  it('logs a read past the slow threshold with how long it waited versus ran', async () => {
    const { source, result } = await readReachingConnectionAfter(60);
    await advance(AUTH_ADMISSION_SLOW_READ_MS - 60);
    source.resolve(true);
    await expect(result).resolves.toBe(true);
    expect(warn).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledWith('[auth-admission] read slow or unanswered', {
      outcome: 'slow',
      waitMs: 60,
      executeMs: AUTH_ADMISSION_SLOW_READ_MS - 60,
      unsettledReads: 0,
    });
  });

  it('does not count a read one millisecond under the threshold as slow', async () => {
    const { source, result } = await readReachingConnectionAfter(1);
    await advance(AUTH_ADMISSION_SLOW_READ_MS - 2);
    source.resolve(true);
    await expect(result).resolves.toBe(true);
    expect(warn).not.toHaveBeenCalled();
  });

  it('reports a deadline miss after it reached a connection as mostly executing', async () => {
    const { result } = await readReachingConnectionAfter(5);
    const rejected = expect(result).rejects.toBeInstanceOf(AuthAdmissionUnavailableError);
    await advance(AUTH_ADMISSION_RESPONSE_DEADLINE_MS - 5);
    await rejected;
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0][1]).toEqual({
      outcome: 'deadline_missed',
      waitMs: 5,
      executeMs: AUTH_ADMISSION_RESPONSE_DEADLINE_MS - 5,
      unsettledReads: 1,
    });
  });

  it('reports a read that never reached a connection as all waiting', async () => {
    const source = deferred(true);
    const result = observed(runAuthAdmissionRead(() => source.promise));
    const rejected = expect(result).rejects.toBeInstanceOf(AuthAdmissionUnavailableError);
    await advance(AUTH_ADMISSION_RESPONSE_DEADLINE_MS);
    await rejected;
    expect(warn.mock.calls[0][1]).toMatchObject({
      outcome: 'deadline_missed',
      waitMs: AUTH_ADMISSION_RESPONSE_DEADLINE_MS,
      executeMs: 0,
    });
  });

  it('counts a late answer as a missed deadline, once', async () => {
    const { source, result } = await readReachingConnectionAfter(2);
    clock = AUTH_ADMISSION_RESPONSE_DEADLINE_MS;
    source.resolve(true);
    await expect(result).rejects.toBeInstanceOf(AuthAdmissionUnavailableError);
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0][1]).toMatchObject({ outcome: 'deadline_missed' });
  });

  it('logs a failed read by code alone, never its message', async () => {
    const privateFailure = Object.assign(new Error('owned-private climber@example.com'), { code: '57014' });
    const result = observed(runAuthAdmissionRead(() => Promise.reject(privateFailure)));
    await expect(result).rejects.toBeInstanceOf(AuthAdmissionUnavailableError);
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0][1]).toMatchObject({ outcome: 'failed', errorCode: '57014' });
    expect(JSON.stringify(warn.mock.calls)).not.toContain('climber@example.com');
  });

  it('logs a refusal when all eight read slots are held', async () => {
    const sources = Array.from({ length: MAX_UNSETTLED_AUTH_ADMISSION_READS }, () => deferred(false));
    for (const source of sources) observed(runAuthAdmissionRead(() => source.promise));
    await Promise.resolve();
    expect(warn).not.toHaveBeenCalled();

    const refused = vi.fn();
    await expect(observed(runAuthAdmissionRead(refused))).rejects.toBeInstanceOf(AuthAdmissionUnavailableError);
    expect(refused).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0][1]).toEqual({
      outcome: 'refused',
      waitMs: 0,
      executeMs: 0,
      unsettledReads: MAX_UNSETTLED_AUTH_ADMISSION_READS,
    });
    for (const source of sources) source.resolve(false);
  });

  it('keeps a burst of missed deadlines to one line and a totals line', async () => {
    const sources = Array.from({ length: 4 }, () => deferred(false));
    const results = sources.map((source) => observed(runAuthAdmissionRead(() => source.promise)));
    const rejected = Promise.all(
      results.map((result) => expect(result).rejects.toBeInstanceOf(AuthAdmissionUnavailableError)),
    );
    await advance(AUTH_ADMISSION_RESPONSE_DEADLINE_MS);
    await rejected;
    expect(warn).toHaveBeenCalledTimes(1);

    await advance(ADMISSION_READ_LOG_WINDOW_MS);
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn.mock.calls[1][1]).toMatchObject({ outcome: 'deadline_missed', suppressedReads: 3 });
    for (const source of sources) source.resolve(false);
  });
});
