import { describe, it, expect, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import { isDeadlineError } from '../ssr-fetch-deadline';

describe('isDeadlineError', () => {
  it('matches timeout and abort errors', () => {
    expect(isDeadlineError(new DOMException('timed out', 'TimeoutError'))).toBe(true);
    expect(isDeadlineError(new DOMException('aborted', 'AbortError'))).toBe(true);
  });

  it('finds a deadline error wrapped in cause', () => {
    const wrapped = new Error('request failed', { cause: new DOMException('timed out', 'TimeoutError') });
    expect(isDeadlineError(wrapped)).toBe(true);
  });

  it('rejects ordinary errors and non-objects', () => {
    expect(isDeadlineError(new Error('boom'))).toBe(false);
    expect(isDeadlineError(null)).toBe(false);
    expect(isDeadlineError('TimeoutError')).toBe(false);
  });

  it('stops on a circular cause chain', () => {
    const loop: { name: string; cause?: unknown } = { name: 'Error' };
    loop.cause = loop;
    expect(isDeadlineError(loop)).toBe(false);
  });
});
