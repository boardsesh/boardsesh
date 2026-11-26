import { EwallsApiClient, type EwallsScope } from '@boardsesh/quantum-sync';
import { db, type Database } from '../db/client';
import { loadEwallsCatalogState } from './ewalls-catalog-state';
import { prepareEwallsCatalog } from './ewalls-catalog-mapping';
import { RELEASED_EWALLS_BOARD_TYPES, validateEwallsScopes } from './ewalls-catalog-scope';
import { quantumCatalogSyncFlag } from './quantum-catalog-sync-flag';
import {
  importPreparedEwallsCatalog,
  type QuantumCatalogBatchRunner,
  type QuantumCatalogImportResult,
} from './quantum-catalog-import';

type CatalogClient = Pick<EwallsApiClient, 'currentUser' | 'bootstrap' | 'delta'>;
export type QuantumCatalogSyncOptions = Readonly<{
  database?: Database;
  transaction?: QuantumCatalogBatchRunner;
  environment?: Readonly<Record<string, string | undefined>>;
  signal?: AbortSignal;
  now?: () => Date;
  log?: (message: string) => void;
  client?: CatalogClient;
  scopes?: readonly EwallsScope[];
}>;
export type QuantumCatalogSyncResult = Readonly<{
  source: 'ewalls-api';
  scopes: readonly Readonly<{ scope: EwallsScope; checkpoint: string; importResult: QuantumCatalogImportResult }>[];
}>;

/** A shared catalogue credential is explicit configuration. A climber's token
 * must never silently promote account-scoped collections into public rows. */
export async function syncQuantumCatalogOnce(
  options: QuantumCatalogSyncOptions = {},
): Promise<QuantumCatalogSyncResult> {
  const environment = options.environment ?? process.env;
  const scopes =
    options.scopes ??
    RELEASED_EWALLS_BOARD_TYPES.map((forcedType) => ({
      board: environment.QUANTUM_API_BOARD_NAME ?? '',
      forcedType,
    }));
  validateEwallsScopes(scopes);
  if (scopes.length === 0 || !(await quantumCatalogSyncFlag.isEnabled(environment))) {
    return Object.freeze({ source: 'ewalls-api', scopes: Object.freeze([]) });
  }
  if (
    !environment.QUANTUM_API_TOKEN ||
    !environment.QUANTUM_API_ACCOUNT_ID ||
    environment.QUANTUM_API_CATALOG_VISIBILITY !== 'public'
  ) {
    throw new Error(
      'Configure a shared eWalls catalogue token, account identity, and QUANTUM_API_CATALOG_VISIBILITY=public before enabling catalogue sync.',
    );
  }
  const database = options.database ?? db;
  const client =
    options.client ?? new EwallsApiClient({ token: environment.QUANTUM_API_TOKEN, includeAccountCollections: false });
  const account = await client.currentUser(options.signal);
  if (environment.QUANTUM_API_ACCOUNT_ID && account.id !== environment.QUANTUM_API_ACCOUNT_ID) {
    throw new Error('The eWalls catalogue credential belongs to a different configured account.');
  }
  const results: Array<QuantumCatalogSyncResult['scopes'][number]> = [];
  for (const scope of scopes) {
    options.signal?.throwIfAborted();
    const state = await loadEwallsCatalogState(database, scope, account.id);
    const batch = state
      ? await client.delta(scope, state.checkpoint, options.signal)
      : await client.bootstrap(scope, options.signal);
    const prepared = prepareEwallsCatalog(batch, state?.diodes, (options.now ?? (() => new Date()))());
    const importResult = await importPreparedEwallsCatalog(
      {
        batch,
        catalog: prepared.catalog,
        diodes: prepared.diodes,
        withdrawals: prepared.withdrawals,
        upstreamAccountId: account.id,
        expectedCheckpoint: state?.checkpoint ?? null,
      },
      {
        database,
        transaction: options.transaction,
        signal: options.signal,
        now: options.now,
      },
    );
    results.push({ scope, checkpoint: batch.checkpoint, importResult });
    options.log?.(
      `[QuantumSync] eWalls ${scope.forcedType}: ${batch.kind}, ${importResult.climbsUpserted} route updates`,
    );
  }
  return Object.freeze({ source: 'ewalls-api', scopes: Object.freeze(results) });
}
