import { createHash } from 'node:crypto';

export const WORKER_DATABASE_PREFIX = 'boardsesh_backend_test';
const POOL_ID_PATTERN = /^(0|[1-9][0-9]{0,15})$/;
const NAMESPACE_PATTERN = /^[a-f0-9]{12}$/;

type WorkerDatabaseNamespaceOptions = {
  checkoutRoot: string;
  ci: boolean;
  salt?: string;
};

/** Pure: callers provide their environment, without importing worker-db's URL rewrites. */
export function createWorkerDatabaseNamespace({ checkoutRoot, ci, salt }: WorkerDatabaseNamespaceOptions): string {
  const explicitSalt = salt?.trim();
  // CI services are isolated already. Preserve their existing database names unless overridden.
  if (ci && !explicitSalt) return '';
  const namespaceSeed = explicitSalt ? `salt:${explicitSalt}` : `checkout:${checkoutRoot}`;
  return createHash('sha256').update(namespaceSeed).digest('hex').slice(0, 12);
}

function validateNamespace(namespace: string): void {
  if (namespace !== '' && (namespace.length !== 12 || !NAMESPACE_PATTERN.test(namespace))) {
    throw new Error('Backend test database namespace must be empty or twelve lowercase hex characters');
  }
}

export function createWorkerDatabaseName({
  poolId,
  namespace,
  prefix = WORKER_DATABASE_PREFIX,
}: {
  poolId: string;
  namespace: string;
  prefix?: string;
}): string {
  if (!POOL_ID_PATTERN.test(poolId) || !Number.isSafeInteger(Number(poolId)) || String(Number(poolId)) !== poolId) {
    throw new Error('Backend test database pool ID must be a nonnegative safe integer');
  }
  if (!prefix || !/^[a-z]/.test(prefix) || /[^a-z0-9_]/.test(prefix)) {
    throw new Error('Backend test database prefix must be a lowercase SQL identifier');
  }
  validateNamespace(namespace);
  const databaseName = `${prefix}_w${poolId}${namespace ? `_${namespace}` : ''}`;
  // PostgreSQL truncates longer identifiers, which would silently undo namespace isolation.
  if (databaseName.length > 63) throw new Error('Backend test database name exceeds 63 characters');
  return databaseName;
}

/** PostgreSQL-compatible anchored regex; CI's legacy pattern never matches a salted checkout. */
export function workerDatabaseCleanupPattern(namespace: string): string {
  validateNamespace(namespace);
  return `^${WORKER_DATABASE_PREFIX}_w(0|[1-9][0-9]{0,15})${namespace ? `_${namespace}` : ''}$`;
}

/** Apply the same safety boundary again before interpolating catalog names in DROP DATABASE. */
export function selectWorkerDatabasesForCleanup(databaseNames: string[], namespace: string): string[] {
  const namespacePattern = new RegExp(workerDatabaseCleanupPattern(namespace));
  return databaseNames.filter((databaseName) => {
    const match = namespacePattern.exec(databaseName);
    if (!match || match[0] !== databaseName) return false;
    return Number.isSafeInteger(Number(match[1])) && databaseName.length <= 63;
  });
}
