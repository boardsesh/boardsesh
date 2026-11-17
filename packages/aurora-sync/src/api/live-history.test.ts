import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  fetchAuroraLiveHistory,
  normalizeAuroraDisplayTime,
  parseAuroraLiveHistory,
  type AuroraLiveBoardName,
} from './live-history';
import { AURORA_BOARDS, WEB_HOSTS } from './types';

const row = { climb_uuid: 'climb-1', serial_number: '84771', created_at: '2026-11-17 06:53:45.349160' };
const boards = AURORA_BOARDS.filter((board): board is AuroraLiveBoardName => board !== 'kilter');

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('Aurora display timestamps', () => {
  it('retains UTC microseconds and canonicalizes shorter fractions', () => {
    expect(normalizeAuroraDisplayTime(row.created_at)).toBe('2026-11-17T06:53:45.349160Z');
    expect(normalizeAuroraDisplayTime('2026-11-17 06:53:45.1')).toBe('2026-11-17T06:53:45.100000Z');
    expect(normalizeAuroraDisplayTime('2026-11-17 06:53:45')).toBe('2026-11-17T06:53:45.000000Z');
  });

  it.each(['2026-02-30 06:53:45.349160', '2026-11-17 25:00:00', '2026-11-17 06:53:45.1234567', 'yesterday'])(
    'rejects an invalid or lossy timestamp: %s',
    (timestamp) => expect(normalizeAuroraDisplayTime(timestamp)).toBeNull(),
  );
});

describe('parseAuroraLiveHistory', () => {
  it('preserves raw page count and cursors without inventing an angle or sender', () => {
    const parsed = parseAuroraLiveHistory({ exhibits: [row, row] }, '84771');
    expect(parsed).toHaveLength(2);
    expect(parsed[0]).toEqual({
      climbUuid: 'climb-1',
      serialNumber: '84771',
      displayedAt: '2026-11-17T06:53:45.349160Z',
      rawTimestamp: row.created_at,
    });
  });

  it.each([
    null,
    {},
    { exhibits: {} },
    { exhibits: [null] },
    { exhibits: [{ ...row, serial_number: null }] },
    { exhibits: [{ ...row, serial_number: 'foreign' }] },
    { exhibits: [{ ...row, created_at: 'invalid' }] },
  ])('fails malformed/mixed-serial pages before a caller can advance its cursor', (body) =>
    expect(() => parseAuroraLiveHistory(body, '84771')).toThrow(),
  );
});

describe('fetchAuroraLiveHistory', () => {
  it.each(boards)('uses the correct %s host and token-only session', async (board) => {
    const request = vi.fn(() => Promise.resolve(new Response(JSON.stringify({ exhibits: [row] }))));
    vi.stubGlobal('fetch', request);
    await fetchAuroraLiveHistory(board, '84771', 'secret-token', { before: row.created_at });
    expect(request).toHaveBeenCalledOnce();
    const [address, options] = request.mock.calls[0] as unknown as [string, RequestInit];
    const url = new URL(address);
    expect(url.origin).toBe(WEB_HOSTS[board]);
    expect(url.pathname).toBe('/exhibits');
    expect(url.searchParams.get('serial_number')).toBe('84771');
    expect(url.searchParams.get('before')).toBe(row.created_at);
    expect(options.headers).toMatchObject({ Cookie: 'token=secret-token' });
    expect(options.redirect).toBe('error');
  });

  it('keeps 401 and Retry-After distinguishable for account failover/backoff', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const request = vi
      .fn()
      .mockResolvedValueOnce(new Response('', { status: 401 }))
      .mockResolvedValueOnce(new Response('', { status: 429, headers: { 'Retry-After': '120' } }));
    vi.stubGlobal('fetch', request);
    await expect(fetchAuroraLiveHistory('tension', '84771', 'token')).rejects.toMatchObject({ status: 401 });
    await expect(fetchAuroraLiveHistory('tension', '84771', 'token')).rejects.toMatchObject({
      code: 'rate_limited',
      status: 429,
      retryAfterMs: 120_000,
    });
  });

  it('rejects untrusted hosts and the retired Aurora Kilter provider before sending credentials', async () => {
    const request = vi.fn();
    vi.stubGlobal('fetch', request);
    await expect(fetchAuroraLiveHistory('other' as AuroraLiveBoardName, '84771', 'token')).rejects.toThrow();
    await expect(fetchAuroraLiveHistory('kilter' as AuroraLiveBoardName, '84771', 'token')).rejects.toThrow();
    expect(request).not.toHaveBeenCalled();
  });

  it('bounds actual response bytes even when Content-Length is absent', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(new Response(' '.repeat(1_048_577)))),
    );
    await expect(fetchAuroraLiveHistory('tension', '84771', 'token')).rejects.toMatchObject({
      code: 'invalid_response',
    });
  });

  it('preserves caller cancellation instead of classifying it as a timeout', async () => {
    const controller = new AbortController();
    const reason = new Error('viewer left');
    vi.stubGlobal(
      'fetch',
      vi.fn(() => {
        controller.abort(reason);
        return Promise.reject(reason);
      }),
    );
    await expect(fetchAuroraLiveHistory('tension', '84771', 'token', { signal: controller.signal })).rejects.toBe(
      reason,
    );
  });
});
