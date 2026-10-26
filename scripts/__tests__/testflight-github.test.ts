import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTestflightCommandRunner, TESTFLIGHT_PREPARATION_MS } from '../lib/testflight-github';

const epoch = Date.parse('2026-10-26T06:00:00Z');
const ghArguments = ['api', '--paginate', '--slurp', '/repos/boardsesh/boardsesh/issues/42/comments'];
const http = (status: number, headers = '', body = '{}') => `HTTP/2.0 ${status} Response\n${headers}\r\n${body}`;

function failure(status = 403, headers = '', body = '{}', stderr = 'gh: API rate limit exceeded (HTTP 403)') {
  return Object.assign(new Error('gh failed'), { stdout: http(status, headers, body), stderr });
}

function fixture() {
  let clock = epoch;
  const execute = vi.fn<(binary: string, argumentsList: string[]) => string>();
  const sleep = vi.fn((milliseconds: number) => {
    clock += milliseconds;
  });
  const warn = vi.fn<(message: string) => void>();
  const options = { execute, sleep, warn, now: () => clock, deadline: epoch + TESTFLIGHT_PREPARATION_MS };
  const run = createTestflightCommandRunner(options);
  return { execute, sleep, warn, run, options };
}

afterEach(() => vi.unstubAllEnvs());

describe('TestFlight GitHub rate-limit retries', () => {
  it('preserves paginated slurp JSON and request arguments while stripping each page’s headers', () => {
    const { run, execute } = fixture();
    const pages = [{ id: 1 }, { body: 'HTTP/2.0 200 OK\nX-Test: embedded\n\nclimber notes' }];
    execute.mockReturnValue(
      `[${http(200, 'X-RateLimit-Remaining: 1\r\n', JSON.stringify(pages[0]))},${http(200, '', JSON.stringify(pages[1]))}]`,
    );
    expect(JSON.parse(run('gh', ghArguments))).toEqual(pages);
    expect(execute).toHaveBeenCalledWith('gh', ['api', '--include', ...ghArguments.slice(1)]);
  });

  it('leaves git commands and their output unchanged', () => {
    const { run, execute } = fixture();
    execute.mockReturnValue('commit\n');
    expect(run('git', ['rev-list', 'HEAD'])).toBe('commit\n');
    expect(execute).toHaveBeenCalledWith('git', ['rev-list', 'HEAD']);
  });

  it('waits until the primary quota reset before repeating the same request', () => {
    const { run, execute, sleep } = fixture();
    execute.mockImplementationOnce(() => {
      throw failure(403, `X-RateLimit-Remaining: 0\r\nX-RateLimit-Reset: ${epoch / 1000 + 3600}\r\n`);
    });
    execute.mockReturnValue(http(200, '', '[{"id":42}]'));
    expect(JSON.parse(run('gh', ghArguments))).toEqual([{ id: 42 }]);
    expect(sleep).toHaveBeenCalledExactlyOnceWith(3_600_000);
    expect(execute.mock.calls[0]).toEqual(execute.mock.calls[1]);
  });

  it('honors the later of Retry-After and an exhausted quota’s reset', () => {
    const { run, execute, sleep } = fixture();
    execute.mockImplementationOnce(() => {
      throw failure(
        429,
        `Retry-After: 90\r\nX-RateLimit-Remaining: 0\r\nX-RateLimit-Reset: ${epoch / 1000 + 30}\r\n`,
        '{}',
        '',
      );
    });
    execute.mockReturnValue(http(200));
    run('gh', ghArguments);
    expect(sleep).toHaveBeenCalledExactlyOnceWith(90_000);
  });

  it('accepts an HTTP-date Retry-After and case-insensitive header names', () => {
    const { run, execute, sleep } = fixture();
    execute.mockImplementationOnce(() => {
      throw failure(403, `retry-after: ${new Date(epoch + 120_000).toUTCString()}\r\n`, '{}', '');
    });
    execute.mockReturnValue(http(200));
    run('gh', ghArguments);
    expect(sleep).toHaveBeenCalledExactlyOnceWith(120_000);
  });

  it('uses the failed page’s headers after partial successful pagination', () => {
    const { run, execute, sleep } = fixture();
    const error = failure(429, 'Retry-After: 70\r\n', '{}', '');
    error.stdout = `[${http(200, 'X-RateLimit-Remaining: 3\r\n', '[]')},${error.stdout}`;
    execute.mockImplementationOnce(() => {
      throw error;
    });
    execute.mockReturnValue(`[${http(200, '', '[]')}]`);
    expect(JSON.parse(run('gh', ghArguments))).toEqual([[]]);
    expect(sleep).toHaveBeenCalledExactlyOnceWith(70_000);
  });

  it('backs off secondary limits for 60, 120, and 240 seconds, then stops', () => {
    const { run, execute, sleep, warn } = fixture();
    execute.mockImplementation(() => {
      throw failure(403, '', '{}', 'gh: You have exceeded a secondary rate limit (HTTP 403)');
    });
    expect(() => run('gh', ghArguments)).toThrow('after three retries');
    expect(sleep.mock.calls.flat()).toEqual([60_000, 120_000, 240_000]);
    expect(execute).toHaveBeenCalledTimes(4);
    expect(warn).toHaveBeenCalledTimes(3);
  });

  it('retries GraphQL RATE_LIMITED errors returned with HTTP 200', () => {
    const { run, execute, sleep } = fixture();
    execute.mockImplementationOnce(() => {
      throw failure(200, '', '{"errors":[{"type":"RATE_LIMITED"}]}', 'gh: API rate limit exceeded');
    });
    execute.mockReturnValue(http(200, '', '{"data":{"repository":{}}}'));
    expect(JSON.parse(run('gh', ['api', 'graphql', '-f', 'query=query { repository { name } }']))).toHaveProperty(
      'data.repository',
    );
    expect(sleep).toHaveBeenCalledExactlyOnceWith(60_000);
  });

  it.each([401, 403, 404])('does not retry an ordinary HTTP %s permission/not-found error', (status) => {
    const { run, execute, sleep } = fixture();
    const error = failure(
      status,
      `X-RateLimit-Remaining: 25\r\nX-RateLimit-Reset: ${epoch / 1000 + 3600}\r\n`,
      '{"message":"Resource not accessible by integration"}',
      'gh: Resource not accessible by integration',
    );
    execute.mockImplementation(() => {
      throw error;
    });
    expect(() => run('gh', ghArguments)).toThrow(error);
    expect(execute).toHaveBeenCalledOnce();
    expect(sleep).not.toHaveBeenCalled();
  });

  it('does not hide GraphQL permission errors behind a simultaneous rate limit', () => {
    const { run, execute, sleep } = fixture();
    const error = failure(200, '', '{"errors":[{"type":"RATE_LIMITED"},{"type":"FORBIDDEN"}]}');
    execute.mockImplementation(() => {
      throw error;
    });
    expect(() => run('gh', ghArguments)).toThrow(error);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('does not retry transport failures', () => {
    const { run, execute, sleep } = fixture();
    const error = Object.assign(new Error('network unreachable'), { stderr: 'error connecting to api.github.com' });
    execute.mockImplementation(() => {
      throw error;
    });
    expect(() => run('gh', ghArguments)).toThrow(error);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('fails before sleeping when the server reset would exceed the preparation deadline', () => {
    const { run, execute, sleep } = fixture();
    execute.mockImplementation(() => {
      throw failure(429, 'Retry-After: 4000\r\n');
    });
    expect(() => run('gh', ghArguments)).toThrow('exceeds the 65-minute preparation deadline');
    expect(sleep).not.toHaveBeenCalled();
  });

  it('shares the workflow’s absolute deadline across separate CLI runners', () => {
    const setup = fixture();
    vi.stubEnv('TESTFLIGHT_PREPARATION_DEADLINE_MS', String(epoch + TESTFLIGHT_PREPARATION_MS));
    const { deadline: _deadline, ...options } = setup.options;
    const first = createTestflightCommandRunner(options);
    setup.execute.mockImplementationOnce(() => {
      throw failure(429, 'Retry-After: 3840\r\n');
    });
    setup.execute.mockReturnValue(http(200));
    first('gh', ghArguments);
    const second = createTestflightCommandRunner(options);
    setup.execute.mockImplementationOnce(() => {
      throw failure(429, 'Retry-After: 120\r\n');
    });
    expect(() => second('gh', ghArguments)).toThrow('exceeds the 65-minute preparation deadline');
    expect(setup.sleep.mock.calls.flat()).toEqual([3_840_000]);
  });

  it('refuses expired or malformed preparation deadlines before calling GitHub', () => {
    const { execute, options } = fixture();
    const expired = createTestflightCommandRunner({ ...options, deadline: epoch });
    expect(() => expired('gh', ghArguments)).toThrow('preparation exceeded 65 minutes');
    expect(execute).not.toHaveBeenCalled();
    vi.stubEnv('TESTFLIGHT_PREPARATION_DEADLINE_MS', 'tomorrow');
    expect(() => createTestflightCommandRunner()).toThrow('Invalid TestFlight preparation deadline');
  });
});
