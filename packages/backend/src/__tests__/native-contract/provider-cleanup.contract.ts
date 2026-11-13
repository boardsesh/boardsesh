import { posix } from 'node:path';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { describe, expect, it } from 'vite-plus/test';
import { recordings, recordedSource } from './recordings';
import { callRecorded, createReleasedClient } from './released-client';

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
        const clearedTables: string[] = [];
        const effects: string[] = [];
        let authenticated = initiallyAuthenticated;
        let loading = true;
        const providerSource = recordedSource(release, release.evidence.providerPath);
        const declarations = Object.entries(release.evidence.callbacks)
          .map(([, range]) => providerSource.slice(range.start, range.end))
          .join('\n');
        const connectionSource = recordedSource(release, release.evidence.connectionPath);
        const tablesRange = release.evidence.clearTables;
        const functionRange = release.evidence.clearFunction;
        if (!tablesRange || !functionRange) throw new Error('Frozen SQLite cleanup source missing');
        const checkpointPath = release.evidence.checkpointPath;
        const checkpointRange = release.evidence.clearCheckpointFunction;
        if (!checkpointPath || !checkpointRange) throw new Error('Frozen checkpoint cleanup source missing');
        const checkpointCleanup = await client.load(checkpointPath);
        const cleanup = await client.evaluateFragment(
          `${connectionSource.slice(tablesRange.start, tablesRange.end)}\n${connectionSource.slice(functionRange.start, functionRange.end)}`,
          {
            deleteUserCheckpoints: checkpointCleanup.deleteUserCheckpoints,
          },
        );
        const userTables = [
          'boardsesh_ticks',
          'playlists',
          'playlist_climbs',
          'user_favorites',
          'user_follows',
          'setter_follows',
          'playlist_follows',
          'pending_mutations',
        ];
        const tableConfigPath = posix.join(posix.dirname(checkpointPath), 'table-config.ts');
        const configuredTables = release.modules[tableConfigPath]
          ? (await client.load(tableConfigPath)).BOARD_DATA_TABLES
          : ['board_climbs', 'board_climb_stats'];
        if (
          !Array.isArray(configuredTables) ||
          configuredTables.some((table) => typeof table !== 'string' || !/^[a-z_]+$/.test(table))
        )
          throw new Error('Recorded board tables invalid');
        const boardTables = configuredTables as string[];
        const localDatabase = new DatabaseSync(':memory:');
        for (const table of [...userTables, ...boardTables]) {
          localDatabase.exec(
            `CREATE TABLE ${table} (id TEXT PRIMARY KEY); INSERT INTO ${table} VALUES ('synthetic-existing-row')`,
          );
        }
        localDatabase.exec('CREATE TABLE sync_meta (key TEXT PRIMARY KEY, value TEXT)');
        const boardCheckpointKeys = boardTables.map((table) => `checkpoint:${table}:fixture`);
        const checkpointKeys = [
          ...boardCheckpointKeys,
          'checkpoint:boardsesh_ticks:fixture',
          'checkpoint:deletions:fixture',
        ];
        for (const key of checkpointKeys)
          localDatabase.prepare('INSERT INTO sync_meta VALUES (?, ?)').run(key, 'synthetic-checkpoint');
        const sqlite = {
          async withExclusiveTransactionAsync(
            callback: (transaction: {
              runAsync: (sql: string, parameters?: SQLInputValue[]) => Promise<void>;
            }) => Promise<void>,
          ) {
            localDatabase.exec('BEGIN');
            try {
              await callback({
                async runAsync(sql: string, parameters: SQLInputValue[] = []) {
                  clearedTables.push(sql);
                  localDatabase.prepare(sql).run(...parameters);
                },
              });
              localDatabase.exec('COMMIT');
            } catch (error) {
              localDatabase.exec('ROLLBACK');
              throw error;
            }
          },
        };
        const provider = await client.evaluateFragment(`${declarations}\nexport { checkAuth };`, {
          useCallback: (callback: unknown) => callback,
          authStateRef: { current: { isAuthenticated: initiallyAuthenticated, isLoading: true } },
          getAuthToken: client.store.getAuthToken,
          isTokenExpiringSoon: client.store.isTokenExpiringSoon,
          resetAnalytics: () => {
            effects.push('analytics');
          },
          stopTokenManagement: async () => {
            effects.push('token-management');
          },
          clearStoredSessionId: async () => {
            effects.push('session-id');
          },
          clearStoredActiveBoard: async () => {
            effects.push('active-board');
          },
          getDatabaseHandle: () => sqlite,
          clearUserData: cleanup.clearUserData,
          setSigningOut: (signingOut: boolean) => {
            effects.push(`signing-out:${signingOut}`);
          },
          setSetting: (name: string) => {
            effects.push(name);
          },
          ACTIVE_BOARD_QUERY_KEY: ['active-board'],
          queryClient: {
            removeQueries() {
              effects.push('remove-active-board');
            },
            clear() {
              effects.push('query-cache');
            },
          },
          resetHttpClient: () => {
            effects.push('http');
          },
          disposeWsClient: () => {
            effects.push('websocket');
          },
          setIsAuthenticated: (next: boolean) => {
            authenticated = next;
          },
          setIsLoading: (next: boolean) => {
            loading = next;
          },
          reportError: () => {
            effects.push('error');
          },
        });
        try {
          await callRecorded(provider, 'checkAuth');
          expect(authenticated).toBe(false);
          expect(loading).toBe(false);
          expect(effects).toContain('session-id');
          expect(effects).toContain('active-board');
          expect(effects).toContain('analytics');
          expect(effects.includes('query-cache')).toBe(initiallyAuthenticated);
          expect(effects.includes('websocket')).toBe(initiallyAuthenticated);
          expect(effects.includes('syncEnabledBoards')).toBe(initiallyAuthenticated);

          expect(effects).not.toContain('error');
          expect(clearedTables.filter((sql) => !sql.includes('sync_meta'))).toEqual(
            initiallyAuthenticated
              ? [
                  'DELETE FROM boardsesh_ticks',
                  'DELETE FROM playlists',
                  'DELETE FROM playlist_climbs',
                  'DELETE FROM user_favorites',
                  'DELETE FROM user_follows',
                  'DELETE FROM setter_follows',
                  'DELETE FROM playlist_follows',
                  'DELETE FROM pending_mutations',
                ]
              : [],
          );
          for (const table of userTables)
            expect(localDatabase.prepare(`SELECT count(*) AS count FROM ${table}`).get()?.count).toBe(
              initiallyAuthenticated ? 0 : 1,
            );
          for (const table of boardTables)
            expect(localDatabase.prepare(`SELECT count(*) AS count FROM ${table}`).get()?.count).toBe(1);
          const remainingKeys = localDatabase
            .prepare('SELECT key FROM sync_meta ORDER BY key')
            .all()
            .map((row) => row.key);
          expect(remainingKeys).toEqual([...(initiallyAuthenticated ? boardCheckpointKeys : checkpointKeys)].sort());
        } finally {
          localDatabase.close();
        }
      });
    }
  }
});
