import { existsSync, mkdtempSync, rmSync, statSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { LocalStore } from '../storage';
import { searchLogbook, summarizeLogbook } from '../history';
import { syncLogbook } from '../sync';
import { logbookStates, logbookTicks } from '../db/schema';
import { ISSUER, McpError, PartnerError, type PartnerClient, type Profile } from '../types';

const directories: string[] = [];
const stores: LocalStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) {
    if (store.database.open) store.close();
  }
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function profile(overrides: Partial<Profile> = {}): Profile {
  return {
    issuer: ISSUER,
    clientId: 'public-client',
    subject: 'usr_one',
    accountId: 'account-one',
    generation: randomUUID(),
    authStatus: 'connected',
    scopes: ['logbook:read', 'workouts:write'],
    ...overrides,
  };
}

function openStore(directory = mkdtempSync(join(tmpdir(), 'boardsesh-mcp-history-')), assertHeld?: () => void) {
  if (!directories.includes(directory)) directories.push(directory);
  const store = new LocalStore(directory, assertHeld);
  stores.push(store);
  return store;
}

function connected() {
  const store = openStore();
  const account = profile();
  store.setProfile(account);
  return { store, account };
}

function tick(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    climbedAt: new Date(Date.now() - 86_400_000).toISOString(),
    status: 'send',
    attempts: 3,
    angle: 40,
    mirrored: false,
    stars: null,
    grade: null,
    benchmark: false,
    comment: null,
    climb: {
      id: `climb-${id}`,
      name: `Problem ${id}`,
      board: { type: 'kilter', layout: 'Original' },
      grade: { v: 4, font: '6B+', label: 'V4' },
      boardseshGrade: null,
    },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

const upsert = (id: string, overrides: Record<string, unknown> = {}) => ({ type: 'tick', tick: tick(id, overrides) });
const page = (changes: unknown[], cursor: string, hasMore = false) => ({ changes, cursor, hasMore });

function fixtureClient(responses: unknown[]) {
  const paths: string[] = [];
  const client: PartnerClient = {
    async request(_profile, path) {
      paths.push(path);
      const response = responses.shift();
      if (response instanceof Error) throw response;
      if (typeof response === 'function') return response();
      if (!response) throw new Error('Unexpected extra backend request');
      return response;
    },
  };
  return { client, paths };
}

describe('local SQLite logbook', () => {
  it('migrates a fresh database, reopens it, and restricts file permissions', () => {
    const store = openStore();
    const account = profile();
    store.setProfile(account);
    store.close();
    expect(openStore(store.dataDir).getProfile()).toEqual(account);
    if (process.platform !== 'win32') {
      expect(statSync(store.dataDir).mode & 0o777).toBe(0o700);
      expect(statSync(join(store.dataDir, 'history.sqlite')).mode & 0o777).toBe(0o600);
    }
  });

  it('rejects a database symlink before SQLite opens it', () => {
    const directory = mkdtempSync(join(tmpdir(), 'boardsesh-mcp-link-'));
    directories.push(directory);
    symlinkSync(join(directory, 'target'), join(directory, 'history.sqlite'));
    // A dangling link must also be rejected rather than followed to create its target.
    expect(() => new LocalStore(directory)).toThrow();
  });

  it('publishes only after complete snapshot and catch-up, including empty continuation pages', async () => {
    const { store, account } = connected();
    const { client, paths } = fixtureClient([
      page([upsert('old')], 'snapshot1', true),
      page([], 'catchup', true),
      page([upsert('new'), { type: 'tick.deleted', id: 'old' }], 'settled'),
    ]);
    expect(await syncLogbook(store, client, account, { maxPages: 1 })).toMatchObject({
      complete: false,
      syncing: true,
      pages: 1,
      hasMore: true,
    });
    expect(searchLogbook(store, account).ticks).toEqual([]);
    const status = await syncLogbook(store, client, account);
    expect(status).toMatchObject({ complete: true, syncing: false, pages: 2, hasMore: false });
    expect(paths).toEqual([
      '/v1/logbook/changes?limit=200',
      '/v1/logbook/changes?limit=200&cursor=snapshot1',
      '/v1/logbook/changes?limit=200&cursor=catchup',
    ]);
    expect(searchLogbook(store, account).ticks.map((entry) => entry.id)).toEqual(['new']);
    expect(store.getSyncState(account).cursor).toBe('settled');
  });

  it('applies incremental upserts and deletions exactly once', async () => {
    const { store, account } = connected();
    const { client } = fixtureClient([
      page([upsert('first'), upsert('second')], 'c1'),
      page(
        [
          upsert('first', { attempts: 7 }),
          upsert('first', { attempts: 7 }),
          { type: 'tick.deleted', id: 'second' },
          { type: 'tick.deleted', id: 'missing' },
        ],
        'c2',
      ),
    ]);
    await syncLogbook(store, client, account);
    await syncLogbook(store, client, account);
    expect(summarizeLogbook(store, account).totals).toMatchObject({ ticks: 1, attempts: 7 });
    expect(store.getSyncState(account).cursor).toBe('c2');
  });

  it('rolls back both tick changes and cursor if the transaction cannot commit', async () => {
    const { store, account } = connected();
    await syncLogbook(store, fixtureClient([page([upsert('first')], 'c1')]).client, account);
    // Read-only SQLite rejects the first mutation; the established checkpoint survives.
    store.database.pragma('query_only = ON');
    await expect(syncLogbook(store, fixtureClient([page([upsert('second')], 'c2')]).client, account)).rejects.toThrow();
    store.database.pragma('query_only = OFF');
    expect(store.getSyncState(account).cursor).toBe('c1');
    expect(searchLogbook(store, account).ticks.map((entry) => entry.id)).toEqual(['first']);
  });

  it('retains the last complete mirror during replacement and removes absent ticks on publication', async () => {
    const { store, account } = connected();
    const { client } = fixtureClient([
      page([upsert('old')], 'c1'),
      new PartnerError(410, 'cursor_expired', 'Expired'),
      page([upsert('replacement')], 'snapshot', true),
      page([], 'c2'),
    ]);
    await syncLogbook(store, client, account);
    await syncLogbook(store, client, account, { maxPages: 1 });
    expect(searchLogbook(store, account).ticks.map((entry) => entry.id)).toEqual(['old']);
    expect(store.getSyncStatus(account)).toMatchObject({ complete: true, fullSyncRequired: true });
    await syncLogbook(store, client, account);
    expect(searchLogbook(store, account).ticks.map((entry) => entry.id)).toEqual(['replacement']);
  });

  it('preserves planned yields across Store instances but restarts a dead owner snapshot', async () => {
    const { store, account } = connected();
    const { client, paths } = fixtureClient([
      page([upsert('staged')], 'snapshot', true),
      page([], 'continued', true),
      page([upsert('fresh')], 'complete'),
    ]);
    await syncLogbook(store, client, account, { maxPages: 1 });
    const reopened = openStore(store.dataDir);
    await syncLogbook(reopened, client, account, { maxPages: 1 });
    expect(paths[1]).toContain('cursor=snapshot');
    reopened.db
      .update(logbookStates)
      .set({ stagingOwner: '2147483647', inFlight: true })
      .where(eq(logbookStates.accountId, account.accountId))
      .run();
    await syncLogbook(reopened, client, account);
    expect(paths[2]).toBe('/v1/logbook/changes?limit=200');
    expect(searchLogbook(reopened, account).ticks.map((entry) => entry.id)).toEqual(['fresh']);
  });

  it('continues a clean yielded snapshot after the previous CLI process has exited', async () => {
    const { store, account } = connected();
    const { client, paths } = fixtureClient([
      page([upsert('first')], 'snapshot', true),
      page([upsert('second')], 'complete'),
    ]);
    await syncLogbook(store, client, account, { maxPages: 1 });
    expect(store.getSyncState(account).inFlight).toBe(false);
    store.db
      .update(logbookStates)
      .set({ stagingOwner: '2147483647' })
      .where(eq(logbookStates.accountId, account.accountId))
      .run();
    store.close();
    const nextProcess = openStore(store.dataDir);
    await syncLogbook(nextProcess, client, account, { maxPages: 1 });
    expect(paths[1]).toContain('cursor=snapshot');
    expect(
      searchLogbook(nextProcess, account)
        .ticks.map((entry) => entry.id)
        .sort((first, second) => String(first).localeCompare(String(second))),
    ).toEqual(['first', 'second']);
  });

  it('marks a network page dirty while awaiting, then clean after a handled failure', async () => {
    const { store, account } = connected();
    await expect(
      syncLogbook(
        store,
        fixtureClient([
          () => {
            expect(store.getSyncState(account)).toMatchObject({ inFlight: true, stagingOwner: String(process.pid) });
            throw new Error('connection interrupted');
          },
        ]).client,
        account,
      ),
    ).rejects.toThrow('connection interrupted');
    expect(store.getSyncState(account).inFlight).toBe(false);
  });

  it.each([new McpError('network_unavailable', 'Offline'), new PartnerError(429, 'rate_limited', 'Retry later', 60)])(
    'resumes committed bootstrap after a handled $code error and CLI exit',
    async (failure) => {
      const { store, account } = connected();
      const { client, paths } = fixtureClient([
        page([upsert('first')], 'snapshot', true),
        failure,
        page([upsert('second')], 'complete'),
      ]);
      await expect(syncLogbook(store, client, account)).rejects.toBe(failure);
      expect(store.getSyncState(account)).toMatchObject({ cursor: 'snapshot', inFlight: false });
      store.db
        .update(logbookStates)
        .set({ stagingOwner: '2147483647' })
        .where(eq(logbookStates.accountId, account.accountId))
        .run();
      store.close();
      const nextProcess = openStore(store.dataDir);
      await syncLogbook(nextProcess, client, account);
      expect(paths[2]).toContain('cursor=snapshot');
      expect(
        searchLogbook(nextProcess, account)
          .ticks.map((entry) => entry.id)
          .sort((first, second) => String(first).localeCompare(String(second))),
      ).toEqual(['first', 'second']);
    },
  );

  it('does not clear another profile sync marker after switching during a request', async () => {
    const { store, account } = connected();
    const replacement = profile({ accountId: 'two', subject: 'usr_two' });
    await expect(
      syncLogbook(
        store,
        fixtureClient([
          () => {
            store.setProfile(replacement);
            store.beginSync(replacement);
            throw new McpError('profile_changed', 'Account changed');
          },
        ]).client,
        account,
      ),
    ).rejects.toThrow('Account changed');
    expect(store.getSyncState(replacement).inFlight).toBe(true);
  });

  it('opens read-only cache without initializing missing storage or allowing mutations', async () => {
    const { store, account } = connected();
    await syncLogbook(store, fixtureClient([page([upsert('cached')], 'c1')]).client, account);
    const reader = new LocalStore(store.dataDir, undefined, { readOnly: true });
    stores.push(reader);
    expect(reader.database.readonly).toBe(true);
    expect(searchLogbook(reader, account).ticks.map((entry) => entry.id)).toEqual(['cached']);
    expect(() => reader.setProfile(account)).toThrow('read-only');
    expect(() => reader.resetSync(account)).toThrow('read-only');
    expect(() => reader.beginSync(account)).toThrow('read-only');
    const missing = join(store.dataDir, 'not-created');
    expect(() => new LocalStore(missing, undefined, { readOnly: true })).toThrow('No local history');
    expect(existsSync(missing)).toBe(false);
  });

  it('pins profile and history reads in one SQLite snapshot and observes revocation next time', async () => {
    const { store, account } = connected();
    await syncLogbook(store, fixtureClient([page([upsert('cached')], 'c1')]).client, account);
    const reader = new LocalStore(store.dataDir, undefined, { readOnly: true });
    stores.push(reader);
    reader.db.transaction(() => {
      expect(reader.getProfile()?.authStatus).toBe('connected');
      store.setProfile({ ...account, authStatus: 'logged_out' });
      expect(searchLogbook(reader, account).ticks.map((entry) => entry.id)).toEqual(['cached']);
    });
    expect(() => reader.db.transaction(() => searchLogbook(reader, account))).toThrow('login');
  });

  it('bounds empty hasMore pages and cursor-expiry restarts', async () => {
    const { store, account } = connected();
    const { client, paths } = fixtureClient(Array.from({ length: 10 }, (_, index) => page([], `s${index}`, true)));
    expect(await syncLogbook(store, client, account)).toMatchObject({ pages: 10, hasMore: true });
    expect(paths).toHaveLength(10);
    const expired = fixtureClient([
      new PartnerError(410, 'cursor_expired', 'Expired'),
      new PartnerError(410, 'cursor_expired', 'Expired'),
    ]);
    await expect(syncLogbook(store, expired.client, account)).rejects.toThrow('Expired');
    expect(expired.paths).toHaveLength(2);
    expect(store.getSyncState(account)).toMatchObject({ fullSyncRequired: true, cursor: null, stagingVersion: null });
  });

  it('ignores new event types and accepts additive tick fields, unknown boards and statuses', async () => {
    const { store, account } = connected();
    const novel = tick('new', {
      status: 'future-status',
      extra: 'ignored',
      climb: { ...tick('new').climb, extra: true, board: { type: 'new-board', layout: 'New', extra: 'ignored' } },
    });
    await syncLogbook(
      store,
      fixtureClient([
        page(
          [
            { type: 'future.event', future: true },
            { type: 'tick', tick: novel },
          ],
          'c1',
        ),
      ]).client,
      account,
    );
    expect(searchLogbook(store, account).ticks[0]).toMatchObject({
      status: 'attempt',
      climb: { board: { type: 'new-board' } },
    });
    expect(searchLogbook(store, account).ticks[0]).not.toHaveProperty('extra');
  });

  it('keeps offline reads after network failure but blocks confirmed revocation across processes', async () => {
    const { store, account } = connected();
    await syncLogbook(store, fixtureClient([page([upsert('first')], 'c1')]).client, account);
    await expect(syncLogbook(store, fixtureClient([new Error('offline')]).client, account)).rejects.toThrow('offline');
    expect(searchLogbook(store, account)).toMatchObject({ complete: true, lastSyncedAt: expect.any(String) });
    openStore(store.dataDir).setProfile({ ...account, authStatus: 'reconnect_required' });
    expect(() => searchLogbook(store, account)).toThrow('login');
  });

  it('fences account switches, narrowed scopes, and compromised locks before publishing', async () => {
    const { store, account } = connected();
    const changed = fixtureClient([
      () => {
        store.setProfile(profile({ accountId: 'account-two', subject: 'usr_two' }));
        return page([upsert('private')], 'c1');
      },
    ]);
    await expect(syncLogbook(store, changed.client, account)).rejects.toThrow('account changed');
    expect(store.db.select().from(logbookTicks).all()).toHaveLength(0);
    store.setProfile(account);
    const narrowed = fixtureClient([
      () => {
        store.setProfile({ ...account, scopes: ['workouts:read'] });
        return page([upsert('private')], 'c1');
      },
    ]);
    await expect(syncLogbook(store, narrowed.client, account)).rejects.toThrow('logbook:read');
    let compromised = false;
    const guarded = openStore(undefined, () => {
      if (compromised) throw new McpError('lock_lost', 'Lock lost');
    });
    guarded.setProfile(account);
    const lost = fixtureClient([
      () => {
        compromised = true;
        return page([upsert('private')], 'c1');
      },
    ]);
    await expect(syncLogbook(guarded, lost.client, account)).rejects.toThrow('Lock lost');
    expect(guarded.db.select().from(logbookTicks).all()).toHaveLength(0);
  });

  it('paginates equal timestamps and binds cursors to filters and account generation', async () => {
    const { store, account } = connected();
    const instant = new Date().toISOString();
    await syncLogbook(
      store,
      fixtureClient([
        page(
          ['a', 'b', 'c'].map((id) => upsert(id, { climbedAt: instant })),
          'c1',
        ),
      ]).client,
      account,
    );
    const first = searchLogbook(store, account, { limit: 2 });
    expect(first.ticks.map((entry) => entry.id)).toEqual(['c', 'b']);
    const second = searchLogbook(store, account, { limit: 2, cursor: first.cursor! });
    expect(second.ticks.map((entry) => entry.id)).toEqual(['a']);
    expect(() => searchLogbook(store, account, { cursor: first.cursor!, board: 'tension' })).toThrow('filters changed');
    const reconnected = { ...account, generation: randomUUID() };
    store.setProfile(reconnected);
    expect(() => searchLogbook(store, reconnected, { cursor: first.cursor! })).toThrow('account');
  });

  it('filters literal text without SQL interpretation and aggregates boards separately', async () => {
    const { store, account } = connected();
    await syncLogbook(
      store,
      fixtureClient([
        page(
          [
            upsert('one', { comment: "100% '_; SELECT" }),
            upsert('two', {
              status: 'flash',
              attempts: 1,
              climb: { ...tick('two').climb, board: { type: 'tension', layout: 'TB2' } },
            }),
          ],
          'c1',
        ),
      ]).client,
      account,
    );
    expect(searchLogbook(store, account, { text: '%' }).ticks.map((entry) => entry.id)).toEqual(['one']);
    expect(searchLogbook(store, account, { text: "'; DROP TABLE logbook_ticks;--" }).ticks).toEqual([]);
    const summary = summarizeLogbook(store, account);
    expect(summary.totals).toMatchObject({ ticks: 2, attempts: 4, flashes: 1, sends: 1 });
    expect(summary.groups.map((group) => group.board)).toEqual(['kilter', 'tension']);
    expect(summarizeLogbook(store, account, { board: 'tension' }).totals?.ticks).toBe(1);
  });

  it('normalizes human board names for searches, summaries and cursor filters', async () => {
    const { store, account } = connected();
    await syncLogbook(store, fixtureClient([page([upsert('one'), upsert('two')], 'c1')]).client, account);
    const first = searchLogbook(store, account, { board: ' Kilter ', limit: 1 });
    expect(first.ticks).toHaveLength(1);
    expect(first.filters.board).toBe('kilter');
    expect(searchLogbook(store, account, { board: 'KILTER', cursor: first.cursor!, limit: 1 }).ticks).toHaveLength(1);
    expect(summarizeLogbook(store, account, { board: 'Kilter' }).totals?.ticks).toBe(2);
    expect(() => searchLogbook(store, account, { board: 'kiltre' })).toThrow();
  });

  it('drops other accounts history on login but keeps the current account mirror', async () => {
    const { store, account } = connected();
    await syncLogbook(store, fixtureClient([page([upsert('private-one')], 'c1')]).client, account);
    const other = profile({ accountId: 'two', subject: 'usr_two' });
    store.setProfile(other);
    await syncLogbook(store, fixtureClient([page([upsert('private-two')], 'c2')]).client, other);
    const reconnected = { ...other, generation: randomUUID() };
    store.activateProfile(reconnected);
    expect(store.getProfile()).toEqual(reconnected);
    expect(
      store.db
        .select()
        .from(logbookTicks)
        .all()
        .map((row) => row.tickId),
    ).toEqual(['private-two']);
    expect(
      store.db
        .select()
        .from(logbookStates)
        .all()
        .map((row) => row.accountId),
    ).toEqual(['two']);
    store.activateProfile({ ...account, generation: randomUUID() });
    expect(store.db.select().from(logbookTicks).all()).toEqual([]);
    expect(store.getSyncStatus(store.getProfile()!).complete).toBe(false);
  });

  it('rolls back profile publication and account cleanup when login sync reset fails', async () => {
    const { store, account } = connected();
    await syncLogbook(store, fixtureClient([page([upsert('keep-private-one')], 'c1')]).client, account);
    store.database.exec(`CREATE TRIGGER reject_sync_state BEFORE INSERT ON logbook_states
      BEGIN SELECT RAISE(ABORT, 'injected storage failure'); END`);
    const replacement = profile({ accountId: 'two', subject: 'usr_two' });
    expect(() => store.activateProfile(replacement)).toThrow('injected storage failure');
    expect(store.getProfile()).toEqual(account);
    expect(searchLogbook(store, account).ticks.map((entry) => entry.id)).toEqual(['keep-private-one']);
    expect(store.getSyncState(account).cursor).toBe('c1');
  });

  it('binds drafts to account and generation and preserves immutable create identity', () => {
    const { store, account } = connected();
    const draft = {
      id: randomUUID(),
      accountId: account.accountId,
      generation: account.generation,
      body: { externalRef: 'external', title: 'Warm up', blocks: [{ type: 'freeClimbing' as const }] },
      idempotencyKey: randomUUID(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    };
    store.putDraft(draft);
    expect(store.getDraft(draft.id, account)).toEqual(draft);
    store.saveDraftResult(draft.id, account, { id: 'wk_one' });
    expect(store.getDraft(draft.id, account)).toMatchObject({ ...draft, result: { id: 'wk_one' } });
    const switched = profile({ accountId: 'account-two', subject: 'usr_two' });
    store.setProfile(switched);
    expect(store.getDraft(draft.id, switched)).toBeUndefined();
    expect(() => store.saveDraftResult(draft.id, switched, {})).toThrow('unavailable');
  });
});
