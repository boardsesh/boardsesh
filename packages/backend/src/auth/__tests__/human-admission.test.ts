import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import {
  AuthAdmissionUnavailableError,
  AUTH_ADMISSION_RESPONSE_DEADLINE_MS,
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
