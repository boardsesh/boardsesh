import { describe, expect, it } from 'vitest';
import {
  createWorkerDatabaseName,
  createWorkerDatabaseNamespace,
  selectWorkerDatabasesForCleanup,
  workerDatabaseCleanupPattern,
  WORKER_DATABASE_PREFIX,
} from './worker-db-namespace';

const checkoutRoot = '/boardsesh/worktree-a/';
const otherCheckoutRoot = '/boardsesh/worktree-b/';
const namespace = '0123456789ab';
const otherNamespace = 'abcdef012345';

function databaseName(poolId: string, databaseNamespace = namespace): string {
  return createWorkerDatabaseName({ poolId, namespace: databaseNamespace });
}

describe('backend test database namespaces', () => {
  it('keeps repeated calls in one checkout stable while separating equal pool IDs in other checkouts', () => {
    const first = createWorkerDatabaseNamespace({ checkoutRoot, ci: false });
    const repeated = createWorkerDatabaseNamespace({ checkoutRoot, ci: false });
    const other = createWorkerDatabaseNamespace({ checkoutRoot: otherCheckoutRoot, ci: false });
    expect(first).toMatch(/^[a-f0-9]{12}$/);
    expect(first).toBe(repeated);
    expect(first).not.toBe(other);
    expect(databaseName('1', first)).not.toBe(databaseName('1', other));
  });

  it.each([undefined, '', '   '])('preserves unsuffixed CI database names without an explicit salt: %s', (salt) => {
    expect(createWorkerDatabaseNamespace({ checkoutRoot, ci: true, salt })).toBe('');
    expect(databaseName('1', '')).toBe('boardsesh_backend_test_w1');
  });

  it.each([false, true])('honors explicit salts independently of checkout and CI=%s', (ci) => {
    const first = createWorkerDatabaseNamespace({ checkoutRoot, ci, salt: 'run-one' });
    const other = createWorkerDatabaseNamespace({ checkoutRoot: otherCheckoutRoot, ci, salt: 'run-one' });
    const distinct = createWorkerDatabaseNamespace({ checkoutRoot, ci, salt: 'run-two' });
    expect(first).toBe(other);
    expect(first).not.toBe(distinct);
    expect(first).toMatch(/^[a-f0-9]{12}$/);
  });

  it('hashes arbitrary explicit salts instead of interpolating them into SQL identifiers', () => {
    const hashed = createWorkerDatabaseNamespace({ checkoutRoot, ci: false, salt: 'worker"; -- / ☃' });
    expect(databaseName('1', hashed)).toMatch(/^boardsesh_backend_test_w1_[a-f0-9]{12}$/);
  });
});

describe('validated PostgreSQL test database names', () => {
  it.each([WORKER_DATABASE_PREFIX, 'bs_dedup_replay', 'bs_moonboard_dedup_replay', 'bs_moonboard_residual_replay'])(
    'names standard and replay databases in the same namespace: %s',
    (prefix) => {
      expect(createWorkerDatabaseName({ poolId: '1', namespace, prefix })).toBe(`${prefix}_w1_${namespace}`);
      expect(createWorkerDatabaseName({ poolId: '1', namespace: '', prefix })).toBe(`${prefix}_w1`);
    },
  );

  it('preserves the worker-database safety prefix and accepts pool zero', () => {
    expect(databaseName('0').startsWith('boardsesh_backend_test_w')).toBe(true);
    expect(databaseName('0')).toBe(`boardsesh_backend_test_w0_${namespace}`);
  });

  it.each(['', '-1', '1.2', '01', '1e2', '1\n', 'NaN', '1";DROP DATABASE postgres;--', '9007199254740992'])(
    'rejects unsafe or ambiguous pool IDs before constructing a database name: %s',
    (poolId) => {
      expect(() => databaseName(poolId)).toThrow(/pool ID/);
    },
  );

  it.each(['UPPERCASE', 'has-dash', 'bad";drop', 'trailing\n', '☃'])(
    'rejects unsafe database prefixes: %s',
    (prefix) => {
      expect(() => createWorkerDatabaseName({ poolId: '1', namespace, prefix })).toThrow(/prefix/);
    },
  );

  it.each(['legacy', 'ABCDEF012345', '0123456789ab.*', '0123456789ab\n', '0123456789ab"'])(
    'rejects unsafe namespaces: %s',
    (invalidNamespace) => {
      expect(() => databaseName('1', invalidNamespace)).toThrow(/namespace/);
      expect(() => workerDatabaseCleanupPattern(invalidNamespace)).toThrow(/namespace/);
    },
  );

  it('rejects identifiers PostgreSQL would truncate and merge into another namespace', () => {
    expect(createWorkerDatabaseName({ poolId: '1', namespace, prefix: 'a'.repeat(47) })).toHaveLength(63);
    expect(() => createWorkerDatabaseName({ poolId: '1', namespace, prefix: 'a'.repeat(48) })).toThrow(/63/);
  });
});

describe('stale worker database cleanup selection without PostgreSQL connections', () => {
  const owned = [databaseName('0'), databaseName('1'), databaseName('12')];
  const foreign = [
    databaseName('1', otherNamespace),
    databaseName('1', ''),
    `${databaseName('1')}_backup`,
    `${databaseName('1')}\n`,
    `prefix_${databaseName('1')}`,
    `boardseshXbackendYtest_w1_${namespace}`,
    `boardsesh_backend_test_w01_${namespace}`,
    `boardsesh_backend_test_w9007199254740992_${namespace}`,
    `boardsesh_backend_test_w1_${namespace}";DROP DATABASE postgres;--`,
    'postgres',
  ];

  it('selects only the current checkout or explicit salt, never another run or a lookalike name', () => {
    expect(selectWorkerDatabasesForCleanup([...owned, ...foreign], namespace)).toEqual(owned);
  });

  it('uses an anchored namespace-specific catalog query before the identifier safety filter', () => {
    const pattern = new RegExp(workerDatabaseCleanupPattern(namespace));
    expect(owned.every((name) => pattern.test(name))).toBe(true);
    for (const name of foreign.filter((name) => !name.includes('9007199254740992') && !name.endsWith('\n'))) {
      expect(pattern.test(name), name).toBe(false);
    }
  });

  it('keeps legacy CI cleanup separate from every salted local or CI namespace', () => {
    const legacy = [databaseName('0', ''), databaseName('1', '')];
    expect(selectWorkerDatabasesForCleanup([...legacy, ...owned, databaseName('1', otherNamespace)], '')).toEqual(
      legacy,
    );
    const legacyPattern = new RegExp(workerDatabaseCleanupPattern(''));
    expect(owned.every((name) => !legacyPattern.test(name))).toBe(true);
  });

  it('does not treat custom migration replay databases as stale standard worker databases', () => {
    const replay = createWorkerDatabaseName({ poolId: '1', namespace, prefix: 'bs_moonboard_dedup_replay' });
    expect(selectWorkerDatabasesForCleanup([replay], namespace)).toEqual([]);
  });
});
