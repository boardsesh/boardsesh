import type postgres from 'postgres';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { decideMigrationTarget, loadMigrationJournal, prepareMigrations } from '../dev-db-discover';

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

type TrackerState = { hasDrizzle: boolean; hasPublic: boolean; drizzleLast: number; publicLast: number };

// Stub postgres.Sql: records every statement and answers only the read-only
// tracker probes. Anything else is DDL or a write and shows up in `statements`.
function createStubClient(tracker: TrackerState) {
  const statements: string[] = [];
  const answer = (sqlText: string): unknown[] => {
    if (sqlText.includes('has_drizzle')) {
      return [{ has_drizzle: tracker.hasDrizzle, has_public: tracker.hasPublic }];
    }
    if (sqlText.includes('FROM drizzle."__drizzle_migrations" ORDER BY')) return [{ created_at: tracker.drizzleLast }];
    if (sqlText.includes('FROM public."__drizzle_migrations" ORDER BY')) return [{ created_at: tracker.publicLast }];
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

const isWrite = (statement: string) => /\b(CREATE|INSERT|BEGIN|ALTER|DROP)\b/i.test(statement);
const behind: TrackerState = { hasDrizzle: true, hasPublic: false, drizzleLast: 1, publicLast: 0 };
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
    const journal = loadMigrationJournal();
    const cutoffEntry = journal.entries.find((entry) => entry.tag.includes('sync_deletions_cutoff'));
    if (!cutoffEntry) throw new Error('cutoff migration missing from journal');
    const { client, statements } = createStubClient({ ...behind, drizzleLast: cutoffEntry.when - 1 });
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
      drizzleLast: 0,
      publicLast: Number.MAX_SAFE_INTEGER,
    });
    const usable = await prepareMigrations({ ...remote, source: 'tailscale' }, { client });
    expect(usable).toBe(true);
    expect(statements.filter(isWrite)).toEqual([]);
  });
});
