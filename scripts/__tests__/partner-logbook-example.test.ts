/// <reference types="node" />
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import {
  apiRequest,
  readState,
  syncLogbook,
  withStateLock,
  writeState,
  type SyncState,
} from '../../examples/logbook-sync';

let directory: string;
let file: string;
let state: SyncState;
const request = vi.fn<typeof fetch>();

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'boardsesh-partner-example-'));
  file = join(directory, 'logbook.json');
  state = {
    version: 1,
    clientId: 'client',
    subject: 'climber',
    tokens: { accessToken: 'old-access', refreshToken: 'old-refresh' },
    ticks: { old: { id: 'old' } },
    sessions: { older: { id: 'older', notes: 'Last published recap' } },
    cursor: 'old-cursor',
    fullSyncRequired: false,
  };
  request.mockReset();
  vi.stubGlobal('fetch', request);
  await writeState(file, state);
});
afterEach(async () => {
  vi.unstubAllGlobals();
  await rm(directory, { recursive: true, force: true });
});

const page = (changes: unknown[], cursor: string, hasMore: boolean) => Response.json({ changes, cursor, hasMore });

describe('standalone partner logbook example', () => {
  it('keeps the old copy after interrupted 410 recovery and replaces it completely on the next run', async () => {
    request
      .mockResolvedValueOnce(new Response(null, { status: 410 }))
      .mockResolvedValueOnce(page([{ type: 'tick', tick: { id: 'new' } }], 'snapshot-page', true))
      .mockResolvedValueOnce(new Response(null, { status: 400 }));
    await expect(syncLogbook(file, state)).rejects.toThrow('API request failed (400)');
    const interrupted = await readState(file);
    expect(interrupted).toMatchObject({ ticks: { old: { id: 'old' } }, cursor: 'old-cursor', fullSyncRequired: true });
    request.mockResolvedValueOnce(page([{ type: 'tick', tick: { id: 'new' } }], 'settled', false));
    await syncLogbook(file, interrupted);
    expect(await readState(file)).toMatchObject({
      ticks: { new: { id: 'new' } },
      cursor: 'settled',
      fullSyncRequired: false,
    });
    expect((await readState(file)).ticks).not.toHaveProperty('old');
    expect(request.mock.calls[3][0]).toEqual(expect.not.stringContaining('cursor='));
  });

  it('commits mutations and cursors together, including empty pages and unknown entries', async () => {
    request
      .mockResolvedValueOnce(page([], 'empty-page', true))
      .mockResolvedValueOnce(
        page(
          [{ type: 'future-change' }, { type: 'tick.deleted', id: 'old' }, { type: 'tick', tick: { id: '__proto__' } }],
          'final-page',
          false,
        ),
      );
    await syncLogbook(file, state);
    const stored = await readState(file);
    expect(stored.cursor).toBe('final-page');
    expect(Object.keys(stored.ticks)).toEqual(['__proto__']);
    expect(request.mock.calls[1][0]).toEqual(expect.stringContaining('cursor=empty-page'));
  });

  it('stores session edits and deletions atomically with their ticks and cursor', async () => {
    request.mockResolvedValueOnce(
      page(
        [
          { type: 'session.deleted', id: 'older' },
          { type: 'tick', tick: { id: 'climb', sessionId: 'historical' } },
          { type: 'session', session: { id: 'historical', notes: 'Old recap', durationSeconds: 3600 } },
          { type: 'session', session: { id: 'historical', notes: null, durationSeconds: 3660 } },
          { type: 'session', session: { id: '__proto__', notes: 'Safe own property' } },
        ],
        'session-cursor',
        false,
      ),
    );
    await syncLogbook(file, state);
    const stored = await readState(file);
    expect(stored.cursor).toBe('session-cursor');
    expect(stored.ticks.climb.sessionId).toBe('historical');
    expect(stored.sessions).not.toHaveProperty('older');
    expect(stored.sessions.historical).toEqual({ id: 'historical', notes: null, durationSeconds: 3660 });
    expect(Object.hasOwn(stored.sessions, '__proto__')).toBe(true);
  });

  it('keeps both published entities when full session import is interrupted', async () => {
    state.fullSyncRequired = true;
    await writeState(file, state);
    request
      .mockResolvedValueOnce(page([{ type: 'session', session: { id: 'new-session' } }], 'partial', true))
      .mockResolvedValueOnce(new Response(null, { status: 400 }));
    await expect(syncLogbook(file, state)).rejects.toThrow('API request failed (400)');
    expect(await readState(file)).toMatchObject({
      ticks: { old: { id: 'old' } },
      sessions: { older: { id: 'older', notes: 'Last published recap' } },
      fullSyncRequired: true,
    });
    request.mockResolvedValueOnce(
      page(
        [
          { type: 'session', session: { id: 'new-session', durationSeconds: 3600 } },
          { type: 'tick', tick: { id: 'new-tick', sessionId: 'new-session' } },
        ],
        'complete',
        false,
      ),
    );
    const interrupted = await readState(file);
    await syncLogbook(file, interrupted);
    expect(await readState(file)).toMatchObject({
      ticks: { 'new-tick': { id: 'new-tick', sessionId: 'new-session' } },
      sessions: { 'new-session': { id: 'new-session', durationSeconds: 3600 } },
      cursor: 'complete',
      fullSyncRequired: false,
    });
    expect((await readState(file)).sessions).not.toHaveProperty('older');
  });

  it('upgrades an older tick-only state file without losing its published copy', async () => {
    const { sessions: _sessions, ...olderState } = state;
    const { writeFile } = await import('node:fs/promises');
    await writeFile(file, JSON.stringify(olderState));
    const restored = await readState(file);
    expect(restored.sessions).toEqual({});
    expect(restored.ticks).toEqual(state.ticks);
    expect(restored.cursor).toBe('old-cursor');
  });

  it('durably replaces rotated credentials before retrying the API', async () => {
    request
      .mockResolvedValueOnce(new Response(null, { status: 401 }))
      .mockResolvedValueOnce(Response.json({ access_token: 'new-access', refresh_token: 'new-refresh' }))
      .mockImplementationOnce(async (_url, options) => {
        const stored = JSON.parse(await readFile(file, 'utf8')) as SyncState;
        expect(stored.tokens).toEqual({ accessToken: 'new-access', refreshToken: 'new-refresh' });
        expect(new Headers(options?.headers).get('Authorization')).toBe('Bearer new-access');
        return Response.json({ id: 'climber' });
      });
    expect((await apiRequest(file, state, '/v1/me')).ok).toBe(true);
    expect(request).toHaveBeenCalledTimes(3);
  });

  it('never replays a rotating refresh after an ambiguous transport failure', async () => {
    request.mockResolvedValueOnce(new Response(null, { status: 401 })).mockRejectedValueOnce(new Error('timeout'));
    await expect(apiRequest(file, state, '/v1/me')).rejects.toThrow('Refresh outcome is unknown');
    expect(request).toHaveBeenCalledTimes(2);
    expect((await readState(file)).tokens.refreshToken).toBe('old-refresh');
  });

  it.each([
    ['numeric', () => '86400'],
    ['HTTP date', () => new Date(Date.now() + 86_400_000).toUTCString()],
  ])('refuses a long %s API retry without changing state or retaining the lock', async (_kind, retryAfter) => {
    const original = await readFile(file, 'utf8');
    request.mockResolvedValueOnce(new Response(null, { status: 429, headers: { 'Retry-After': retryAfter() } }));
    await expect(withStateLock(file, () => syncLogbook(file, state))).rejects.toThrow('later than 60 seconds');
    expect(request).toHaveBeenCalledOnce();
    expect(await readFile(file, 'utf8')).toBe(original);
    await expect(withStateLock(file, async () => 'available')).resolves.toBe('available');
  });

  it.each([
    ['numeric', () => '86400'],
    ['HTTP date', () => new Date(Date.now() + 86_400_000).toUTCString()],
  ])('refuses a long %s refresh retry without replaying credentials', async (_kind, retryAfter) => {
    const original = await readFile(file, 'utf8');
    request
      .mockResolvedValueOnce(new Response(null, { status: 401 }))
      .mockResolvedValueOnce(new Response(null, { status: 503, headers: { 'Retry-After': retryAfter() } }));
    await expect(withStateLock(file, () => apiRequest(file, state, '/v1/me'))).rejects.toThrow('later than 60 seconds');
    expect(request).toHaveBeenCalledTimes(2);
    expect(await readFile(file, 'utf8')).toBe(original);
    expect(state.tokens).toEqual({ accessToken: 'old-access', refreshToken: 'old-refresh' });
    await expect(withStateLock(file, async () => 'available')).resolves.toBe('available');
  });

  it('serializes synchronization and credential replacement for one private file', async () => {
    await withStateLock(file, async () => {
      await expect(withStateLock(file, async () => undefined)).rejects.toThrow('Another command owns');
    });
    await expect(withStateLock(file, async () => 'available')).resolves.toBe('available');
  });
});
