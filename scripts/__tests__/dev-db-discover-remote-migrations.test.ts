import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type postgres from 'postgres';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { decideMigrationTarget, prepareMigrations } from '../dev-db-discover';
import { readJournalMigrations } from '../lib/dev-db-pending-migrations';

// Regression coverage for https://github.com/boardsesh/boardsesh/issues/6497:
// the discover script migrated a Tailscale peer's database, then failed at
// 0272 and left it half-migrated.
const pending = ['0265_first', '0272_sync_deletions_cutoff_guard'];

describe('decideMigrationTarget', () => {
  it('refuses to migrate a Tailscale peer and names it', () => {
    const decision = decideMigrationTarget(
      { source: 'tailscale', host: '100.64.0.7', label: 'vibetunnel-dev-1' },
      pending,
    );
    expect(decision.action).toBe('skip-remote');
    if (decision.action !== 'skip-remote') return;
    expect(decision.message).toContain('vibetunnel-dev-1');
    expect(decision.message).toContain('100.64.0.7');
    expect(decision.message).toContain('0272_sync_deletions_cutoff_guard');
  });

  it('refuses to migrate an env-provided host', () => {
    const decision = decideMigrationTarget({ source: 'env', host: 'db.example', label: 'env' }, pending);
    expect(decision.action).toBe('skip-remote');
  });

  it('migrates a database on this machine', () => {
    const decision = decideMigrationTarget({ source: 'local-standalone', host: 'localhost', label: 'local' }, pending);
    expect(decision).toEqual({ action: 'migrate' });
  });

  it('uses an up-to-date remote database as is', () => {
    const decision = decideMigrationTarget({ source: 'tailscale', host: '100.64.0.7', label: 'peer' }, []);
    expect(decision).toEqual({ action: 'use' });
  });
});

type TrackerState = { hasDrizzle: boolean; hasPublic: boolean; drizzleHashes: string[]; publicHashes: string[] };

// Stub postgres.Sql: records every statement and answers only the read-only
// tracker probes. Anything else is DDL or a write and shows up in `statements`.
function createStubClient(tracker: TrackerState) {
  const statements: string[] = [];
  const answer = (sqlText: string): unknown[] => {
    if (sqlText.includes('has_drizzle')) {
      return [{ has_drizzle: tracker.hasDrizzle, has_public: tracker.hasPublic }];
    }
    if (sqlText.includes('SELECT hash FROM drizzle."__drizzle_migrations"')) {
      return tracker.drizzleHashes.map((hash) => ({ hash }));
    }
    if (sqlText.includes('SELECT hash FROM public."__drizzle_migrations"')) {
      return tracker.publicHashes.map((hash) => ({ hash }));
    }
    if (sqlText.includes('public_tracker_exists')) return [{ public_tracker_exists: tracker.hasPublic }];
    return [];
  };
  const client = Object.assign(
    (strings: TemplateStringsArray) => {
      const sqlText = strings.join('?');
      statements.push(sqlText);
      return Promise.resolve(answer(sqlText));
    },
    {
      unsafe: (sqlText: string) => {
        statements.push(sqlText);
        return Promise.resolve([]);
      },
      end: () => Promise.resolve(),
    },
  ) as unknown as postgres.Sql;
  return { client, statements };
}

const journal = readJournalMigrations(join(dirname(fileURLToPath(import.meta.url)), '../../packages/db/drizzle'));
const journalHashes = journal.map((migration) => migration.hash);
const isWrite = (statement: string) => /\b(CREATE|INSERT|BEGIN|ALTER|DROP)\b/i.test(statement);
// A verified prefix of the journal, so the selector returns the rest as pending.
const behind: TrackerState = {
  hasDrizzle: true,
  hasPublic: false,
  drizzleHashes: journalHashes.slice(0, 1),
  publicHashes: [],
};
const remote = { host: '100.64.0.7', label: 'peer', connectionString: 'postgres://unused' };

describe('prepareMigrations', () => {
  beforeEach(() => {
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each(['tailscale', 'env'] as const)('issues no DDL or INSERT against a behind %s database', async (source) => {
    const { client, statements } = createStubClient(behind);
    const installCutoffHelper = vi.fn();
    const usable = await prepareMigrations({ ...remote, source }, { client, installCutoffHelper });
    expect(usable).toBe(false);
    expect(statements.filter(isWrite)).toEqual([]);
    expect(installCutoffHelper).not.toHaveBeenCalled();
  });

  it('installs the cutoff helper before the first migration on a local database', async () => {
    // Start just below the cutoff migration so only the last few .sql files are read.
    const cutoffIndex = journal.findIndex((migration) => migration.tag.includes('sync_deletions_cutoff'));
    if (cutoffIndex < 1) throw new Error('cutoff migration missing from journal');
    const { client, statements } = createStubClient({ ...behind, drizzleHashes: journalHashes.slice(0, cutoffIndex) });
    const order: string[] = [];
    const installCutoffHelper = vi.fn(() => {
      order.push(`helper after ${statements.filter(isWrite).length} writes`);
    });
    const usable = await prepareMigrations(
      { ...remote, source: 'local-standalone', host: 'localhost' },
      { client, installCutoffHelper },
    );
    expect(usable).toBe(true);
    expect(order).toEqual(['helper after 0 writes']);
  });

  it('counts public tracker rows when the drizzle tracker is empty', async () => {
    // Everything applied per public: nothing may be pending on the remote.
    const { client, statements } = createStubClient({
      hasDrizzle: true,
      hasPublic: true,
      drizzleHashes: [],
      publicHashes: journalHashes,
    });
    const usable = await prepareMigrations({ ...remote, source: 'tailscale' }, { client });
    expect(usable).toBe(true);
    expect(statements.filter(isWrite)).toEqual([]);
  });

  it('uses a remote that is ahead of this checkout without writing to it', async () => {
    const { client, statements } = createStubClient({
      ...behind,
      drizzleHashes: [...journalHashes, 'f'.repeat(64)],
    });
    const usable = await prepareMigrations({ ...remote, source: 'tailscale' }, { client });
    expect(usable).toBe(true);
    expect(statements.filter(isWrite)).toEqual([]);
  });

  // #3979's fail-closed ledger check meets #6497's never-touch-a-remote rule:
  // a peer whose history cannot be verified is skipped, not migrated or fatal.
  it.each<[string, TrackerState]>([
    ['has no tracker at all', { hasDrizzle: false, hasPublic: false, drizzleHashes: [], publicHashes: [] }],
    ['has a ledger hole', { ...behind, drizzleHashes: [journalHashes[0], journalHashes[2]] }],
    ['has an unknown ledger row', { ...behind, drizzleHashes: ['0'.repeat(64)] }],
  ])('skips a remote that %s and writes nothing', async (_label, tracker) => {
    const { client, statements } = createStubClient(tracker);
    const installCutoffHelper = vi.fn();
    const usable = await prepareMigrations({ ...remote, source: 'tailscale' }, { client, installCutoffHelper });
    expect(usable).toBe(false);
    expect(statements.filter(isWrite)).toEqual([]);
    expect(installCutoffHelper).not.toHaveBeenCalled();
  });

  it('refuses a local database with a ledger hole before any SQL runs', async () => {
    const { client, statements } = createStubClient({ ...behind, drizzleHashes: [journalHashes[0], journalHashes[2]] });
    const installCutoffHelper = vi.fn();
    await expect(
      prepareMigrations({ ...remote, source: 'local-standalone', host: 'localhost' }, { client, installCutoffHelper }),
    ).rejects.toThrow(/historical gap/);
    expect(statements.filter(isWrite)).toEqual([]);
    expect(installCutoffHelper).not.toHaveBeenCalled();
  });
});
