import { describe, expect, it, vi } from 'vitest';
import { consoleLogger, describeError } from '../logger';

describe('describeError', () => {
  it('returns a plain error message unchanged', () => {
    expect(describeError(new Error('web returned HTTP 500'))).toBe('web returned HTTP 500');
  });

  it('unwraps the cause fetch hides behind "fetch failed"', () => {
    // What Node actually throws when the web host refuses the connection: the
    // runbook needs ECONNREFUSED, not the useless outer message.
    const connectionRefused = new Error('connect ECONNREFUSED 10.0.0.1:443');
    const fetchFailure = new Error('fetch failed', { cause: connectionRefused });

    expect(describeError(fetchFailure)).toBe('fetch failed: connect ECONNREFUSED 10.0.0.1:443');
  });

  it('walks a nested cause chain but stops before a pathological one', () => {
    const chained = new Error('one', {
      cause: new Error('two', {
        cause: new Error('three', { cause: new Error('four', { cause: new Error('five') }) }),
      }),
    });

    // Three links deep, then it stops — "five" never makes it into the line.
    expect(describeError(chained)).toBe('one: two: three: four');
  });

  it('skips a repeated or empty message instead of doubling it up', () => {
    expect(describeError(new Error('fetch failed', { cause: new Error('fetch failed') }))).toBe('fetch failed');
    expect(describeError(new Error('fetch failed', { cause: new Error('') }))).toBe('fetch failed');
  });

  it('falls back to the error name when there is no message at all', () => {
    expect(describeError(new TypeError())).toBe('TypeError');
  });

  it('ignores a non-Error cause and stringifies a non-Error throw', () => {
    expect(describeError(new Error('outer', { cause: 'a string cause' }))).toBe('outer');
    expect(describeError('not an error')).toBe('not an error');
  });
});

describe('consoleLogger', () => {
  it('writes one JSON line per entry, tagged with the service', () => {
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => undefined);

    consoleLogger.info('job tick', { job: 'cleanup' });

    expect(infoSpy).toHaveBeenCalledTimes(1);
    const line = JSON.parse(infoSpy.mock.calls[0][0] as string) as Record<string, unknown>;
    expect(line).toMatchObject({ level: 'info', service: 'scheduler', message: 'job tick', job: 'cleanup' });
    expect(typeof line.time).toBe('string');

    infoSpy.mockRestore();
  });
});
