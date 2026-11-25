import { describe, expect, it } from 'vitest';
import { parsePushReplayArgs } from '../notification-push-replay-options';

describe('notification push replay arguments', () => {
  it('defaults to a bounded dry run', () => {
    expect(parsePushReplayArgs([])).toEqual({ apply: false, limit: 25 });
    expect(parsePushReplayArgs(['--limit', '1'])).toEqual({ apply: false, limit: 1 });
  });
  it('requires explicit apply and permits the maximum bounded batch', () => {
    expect(parsePushReplayArgs(['--limit', '200', '--apply'])).toEqual({ apply: true, limit: 200 });
  });
  it.each([
    ['--limit'],
    ['--limit', '0'],
    ['--limit', '201'],
    ['--limit', '-1'],
    ['--limit', '1.5'],
    ['--limit', 'Infinity'],
    ['--limit', '1', '--limit', '2'],
    ['--apply', '--apply'],
    ['--force'],
  ])('rejects invalid or duplicate arguments: %j', (...args) => {
    expect(() => parsePushReplayArgs(args)).toThrow(/^PUSH_REPLAY_/);
  });
});
