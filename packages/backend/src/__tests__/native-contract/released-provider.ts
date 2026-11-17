import { posix } from 'node:path';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { parseSync } from 'vite-plus';
import { recordedSource, type ReleasedClient } from './recordings';
import type { createReleasedClient } from './released-client';

type Client = Awaited<ReturnType<typeof createReleasedClient>>;

/** The unsynced, account-owned tables every 2.2 release wipes on a signed-out cleanup. */
export const USER_TABLES = [
  'boardsesh_ticks',
  'playlists',
  'playlist_climbs',
  'user_favorites',
  'user_follows',
  'setter_follows',
  'playlist_follows',
  'pending_mutations',
] as const;

/**
 * The recorded 2.2 AuthProvider sign-out callbacks over real in-memory SQLite.
 * The callback ranges and the SQLite clear run exactly as recorded; React
 * setters, query cache, clients and analytics are observed at the I/O boundary.
 * With `forcedSignOut`, the provider's recorded effect that registers its
 * handler with the interceptor's setOnForcedSignOut runs too, so a 401 the
 * frozen interceptor cannot recover from drives the provider's own cleanup.
 */
export async function createReleasedProvider(
  client: Client,
  release: ReleasedClient,
  initiallyAuthenticated: boolean,
  { forcedSignOut = false }: { forcedSignOut?: boolean } = {},
) {
  const clearedTables: string[] = [];
  const effects: string[] = [];
  const state = { authenticated: initiallyAuthenticated, loading: true };
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
    { deleteUserCheckpoints: checkpointCleanup.deleteUserCheckpoints },
  );
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
  const database = new DatabaseSync(':memory:');
  for (const table of [...USER_TABLES, ...boardTables]) {
    database.exec(
      `CREATE TABLE ${table} (id TEXT PRIMARY KEY); INSERT INTO ${table} VALUES ('synthetic-existing-row')`,
    );
  }
  database.exec('CREATE TABLE sync_meta (key TEXT PRIMARY KEY, value TEXT)');
  const boardCheckpointKeys = boardTables.map((table) => `checkpoint:${table}:fixture`);
  const checkpointKeys = [...boardCheckpointKeys, 'checkpoint:boardsesh_ticks:fixture', 'checkpoint:deletions:fixture'];
  for (const key of checkpointKeys)
    database.prepare('INSERT INTO sync_meta VALUES (?, ?)').run(key, 'synthetic-checkpoint');
  const sqlite = {
    async withExclusiveTransactionAsync(
      callback: (transaction: {
        runAsync: (sql: string, parameters?: SQLInputValue[]) => Promise<void>;
      }) => Promise<void>,
    ) {
      database.exec('BEGIN');
      try {
        await callback({
          async runAsync(sql: string, parameters: SQLInputValue[] = []) {
            clearedTables.push(sql);
            database.prepare(sql).run(...parameters);
          },
        });
        database.exec('COMMIT');
      } catch (error) {
        database.exec('ROLLBACK');
        throw error;
      }
    },
  };
  let effectSource = '';
  if (forcedSignOut) {
    const parsed = parseSync(release.evidence.providerPath, providerSource);
    const provider = parsed.program.body.find(
      (node) =>
        node.type === 'ExportNamedDeclaration' &&
        node.declaration?.type === 'FunctionDeclaration' &&
        node.declaration.id?.name === 'AuthProvider',
    );
    const body =
      provider?.type === 'ExportNamedDeclaration' && provider.declaration?.type === 'FunctionDeclaration'
        ? (provider.declaration.body?.body ?? [])
        : [];
    const registrations = body.filter(
      (statement) =>
        statement.type === 'ExpressionStatement' &&
        providerSource.slice(statement.start, statement.end).includes('setOnForcedSignOut('),
    );
    if (registrations.length !== 1) throw new Error('Recorded forced sign-out registration missing');
    effectSource = providerSource.slice(registrations[0].start, registrations[0].end);
  }
  const provider = await client.evaluateFragment(`${declarations}\n${effectSource}\nexport { checkAuth };`, {
    useCallback: (callback: unknown) => callback,
    useEffect: (effect: () => unknown) => {
      effect();
    },
    authStateRef: { current: { isAuthenticated: initiallyAuthenticated, isLoading: true } },
    getAuthToken: client.store.getAuthToken,
    isTokenExpiringSoon: client.store.isTokenExpiringSoon,
    setOnForcedSignOut: client.interceptor.setOnForcedSignOut,
    track: (event: string) => {
      effects.push(`track:${event}`);
    },
    SHARED_EVENTS: new Proxy({}, { get: (_target, name) => String(name) }),
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
      state.authenticated = next;
    },
    setIsLoading: (next: boolean) => {
      state.loading = next;
    },
    reportError: () => {
      effects.push('error');
    },
  });
  const rowCount = (table: string) => database.prepare(`SELECT count(*) AS count FROM ${table}`).get()?.count;
  return {
    provider,
    state,
    effects,
    clearedTables,
    database,
    boardTables,
    boardCheckpointKeys,
    checkpointKeys,
    rowCount,
    syncMetaKeys: () =>
      database
        .prepare('SELECT key FROM sync_meta ORDER BY key')
        .all()
        .map((row) => row.key),
    close: () => database.close(),
  };
}
