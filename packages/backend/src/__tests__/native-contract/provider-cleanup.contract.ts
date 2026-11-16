import { describe, expect, it } from 'vite-plus/test';
import { recordings } from './recordings';
import { callRecorded, createReleasedClient } from './released-client';
import { createReleasedProvider, USER_TABLES } from './released-provider';

/** Exact callback ranges run together; only React setters and platform/cache I/O are injected. */
describe('frozen 2.2 provider cleanup distinguishes a warm session from initial false', () => {
  for (const release of recordings.releases.filter((entry) => entry.version.startsWith('2.2.'))) {
    for (const initiallyAuthenticated of [true, false]) {
      it(`${release.tag}: ${initiallyAuthenticated ? 'warm' : 'cold'} expiring refresh failure`, async () => {
        const client = await createReleasedClient(release, {
          fetch: async () => Response.json({ error: 'Synthetic unavailable' }, { status: 503 }),
        });
        await callRecorded(
          client.store,
          'storeTokens',
          'existing-access',
          'existing-refresh',
          new Date(Date.now() + 60_000).toISOString(),
        );
        const local = await createReleasedProvider(client, release, initiallyAuthenticated);
        try {
          await callRecorded(local.provider, 'checkAuth');
          expect(local.state.authenticated).toBe(false);
          expect(local.state.loading).toBe(false);
          expect(local.effects).toContain('session-id');
          expect(local.effects).toContain('active-board');
          expect(local.effects).toContain('analytics');
          expect(local.effects.includes('query-cache')).toBe(initiallyAuthenticated);
          expect(local.effects.includes('websocket')).toBe(initiallyAuthenticated);
          expect(local.effects.includes('syncEnabledBoards')).toBe(initiallyAuthenticated);

          expect(local.effects).not.toContain('error');
          expect(local.clearedTables.filter((sql) => !sql.includes('sync_meta'))).toEqual(
            initiallyAuthenticated ? USER_TABLES.map((table) => `DELETE FROM ${table}`) : [],
          );
          for (const table of USER_TABLES) expect(local.rowCount(table)).toBe(initiallyAuthenticated ? 0 : 1);
          for (const table of local.boardTables) expect(local.rowCount(table)).toBe(1);
          expect(local.syncMetaKeys()).toEqual(
            [...(initiallyAuthenticated ? local.boardCheckpointKeys : local.checkpointKeys)].sort(),
          );
        } finally {
          local.close();
        }
      });
    }
  }
});
