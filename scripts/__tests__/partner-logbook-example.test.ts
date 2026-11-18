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

  it('serializes synchronization and credential replacement for one private file', async () => {
    await withStateLock(file, async () => {
      await expect(withStateLock(file, async () => undefined)).rejects.toThrow('Another command owns');
    });
    await expect(withStateLock(file, async () => 'available')).resolves.toBe('available');
  });
});
