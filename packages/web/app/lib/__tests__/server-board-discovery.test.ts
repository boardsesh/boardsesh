import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { discoveryBoard } from '@/app/__test-helpers__/board-discovery-fixture';

vi.mock('server-only', () => ({}));
const captureException = vi.hoisted(() => vi.fn());
vi.mock('@sentry/nextjs', () => ({ captureException }));
const executeGraphQLInternal = vi.hoisted(() => vi.fn());
vi.mock('@/app/lib/graphql/server-cached-client', () => ({ executeGraphQLInternal }));
const { getBoardDiscovery } = await import('../server-board-discovery');

describe('public board discovery snapshots', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-19T00:00:00Z'));
    captureException.mockReset();
    executeGraphQLInternal.mockReset().mockResolvedValue({ boardDiscovery: [discoveryBoard()] });
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('asks for eight ranked physical boards with fresh anonymous authorization', async () => {
    expect(await getBoardDiscovery()).toEqual([discoveryBoard()]);
    expect(executeGraphQLInternal).toHaveBeenCalledWith(
      expect.anything(),
      { input: { limit: 8 } },
      expect.any(AbortSignal),
    );
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps gym requests distinct and bounded to the requested preview count', async () => {
    await getBoardDiscovery({ gymUuid: 'gym-one', limit: 3 });
    await getBoardDiscovery({ gymUuid: 'gym-two', limit: 3 });
    expect(executeGraphQLInternal.mock.calls.map((call) => call[1])).toEqual([
      { input: { gymUuid: 'gym-one', limit: 3 } },
      { input: { gymUuid: 'gym-two', limit: 3 } },
    ]);
  });

  it('reauthorizes a board after its owner withdraws public access', async () => {
    expect(await getBoardDiscovery()).toHaveLength(1);
    executeGraphQLInternal.mockResolvedValueOnce({ boardDiscovery: [] });
    expect(await getBoardDiscovery()).toEqual([]);
    expect(executeGraphQLInternal).toHaveBeenCalledTimes(2);
  });

  it('keeps a null selected climb null instead of inventing a fallback', async () => {
    const boards = await getBoardDiscovery();
    expect(boards[0].currentClimb).toBeNull();
  });

  it('fails softly on backend errors and releases its deadline timer', async () => {
    executeGraphQLInternal.mockRejectedValue(new Error('backend unavailable'));
    expect(await getBoardDiscovery()).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
    expect(captureException).toHaveBeenCalledWith(expect.any(Error), {
      tags: { surface: 'board-discovery', operation: 'fetch' },
    });
  });

  it('aborts a stalled optional query after three seconds', async () => {
    executeGraphQLInternal.mockImplementation(
      (_query: unknown, _variables: unknown, signal: AbortSignal) =>
        new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')))),
    );
    const result = getBoardDiscovery();
    await vi.advanceTimersByTimeAsync(3000);
    expect(await result).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });
});
