import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import type { PoolInstance } from '@boardsesh/db/client';

const dependencies = vi.hoisted(() => ({ createPool: vi.fn() }));
vi.mock('@boardsesh/db/client', () => ({ createDedicatedPoolFromUrl: dependencies.createPool }));
import { assertSameCredentialDatabaseTarget } from '../../credential-database-identity';

interface TargetRow {
  readonly role: string;
  readonly sessionRole: string;
  readonly database: string;
  readonly databaseOid: string;
  readonly address: string | null;
  readonly port: number | null;
  readonly postmasterEpoch: string;
  readonly serverVersion: string;
  readonly recovery: boolean;
  readonly readOnly: string;
}
const contentUrl = 'postgresql://boardsesh_runtime:owned-probe-secret@127.0.0.1:55480/owned_probe';
const expected = Object.freeze({
  writerRole: 'boardsesh_identity_writer',
  contentRole: 'boardsesh_runtime',
  database: 'owned_probe',
});
const endpoint = Object.freeze({
  database: expected.database,
  databaseOid: '16384',
  address: '127.0.0.1',
  port: 5432,
  postmasterEpoch: '1771000000.123456',
  serverVersion: '180006',
  recovery: false,
  readOnly: 'off',
});
const writerTarget: TargetRow = Object.freeze({
  ...endpoint,
  role: expected.writerRole,
  sessionRole: expected.writerRole,
});
const contentTarget: TargetRow = Object.freeze({
  ...endpoint,
  role: expected.contentRole,
  sessionRole: expected.contentRole,
});

function ownedPool(target: TargetRow) {
  const query = vi.fn(async (): Promise<TargetRow[]> => [target]);
  const end = vi.fn(async (_options?: { timeout?: number }) => {});
  return { query, end, pool: Object.assign(query, { end }) as unknown as PoolInstance };
}
let writer: ReturnType<typeof ownedPool>;
let content: ReturnType<typeof ownedPool>;

const mismatches: { name: string; side: 'writer' | 'content'; patch: Partial<TargetRow> }[] = [
  { name: 'different writer current role', side: 'writer', patch: { role: 'unexpected_writer' } },
  { name: 'writer authenticated through another login', side: 'writer', patch: { sessionRole: 'unexpected_login' } },
  { name: 'different content current role', side: 'content', patch: { role: 'unexpected_content' } },
  { name: 'content authenticated through another login', side: 'content', patch: { sessionRole: 'unexpected_login' } },
  { name: 'wrong writer database name', side: 'writer', patch: { database: 'another_database' } },
  { name: 'wrong content database name', side: 'content', patch: { database: 'another_database' } },
  { name: 'same name with another database OID', side: 'content', patch: { databaseOid: '24576' } },
  { name: 'another server address', side: 'content', patch: { address: '127.0.0.2' } },
  { name: 'another server listener', side: 'content', patch: { port: 6432 } },
  { name: 'another server startup', side: 'content', patch: { postmasterEpoch: '1771000001.123456' } },
  { name: 'another server version', side: 'content', patch: { serverVersion: '180005' } },
  { name: 'writer connected to a standby', side: 'writer', patch: { recovery: true } },
  { name: 'content connected to a standby', side: 'content', patch: { recovery: true } },
  { name: 'read-only writer session', side: 'writer', patch: { readOnly: 'on' } },
  { name: 'read-only content session', side: 'content', patch: { readOnly: 'on' } },
];

describe('actual credential/content target probe contract', () => {
  beforeEach(() => {
    writer = ownedPool(writerTarget);
    content = ownedPool(contentTarget);
    dependencies.createPool.mockReset().mockReturnValue(content.pool);
    vi.stubEnv('DATABASE_URL', 'postgresql://unused:unused@127.0.0.1:1/unused');
  });
  afterEach(() => vi.unstubAllEnvs());

  it('accepts matching authenticated primary targets and closes only its transient pool', async () => {
    await expect(assertSameCredentialDatabaseTarget(writer.pool, contentUrl, expected)).resolves.toBeUndefined();
    expect(dependencies.createPool).toHaveBeenCalledExactlyOnceWith(contentUrl, 1, {
      connect_timeout: 2,
      connection: { application_name: 'boardsesh-credential-target-probe', statement_timeout: 5000 },
    });
    expect(writer.query).toHaveBeenCalledOnce();
    expect(content.query).toHaveBeenCalledOnce();
    expect(content.end).toHaveBeenCalledExactlyOnceWith({ timeout: 3 });
    expect(writer.end).not.toHaveBeenCalled();
    expect(process.env.DATABASE_URL).toBe('postgresql://unused:unused@127.0.0.1:1/unused');
  });

  it.each(mismatches)('refuses $name and still closes the transient pool', async ({ side, patch }) => {
    if (side === 'writer') writer.query.mockResolvedValue([{ ...writerTarget, ...patch }]);
    else content.query.mockResolvedValue([{ ...contentTarget, ...patch }]);
    await expect(assertSameCredentialDatabaseTarget(writer.pool, contentUrl, expected)).rejects.toThrow(
      'CREDENTIAL_DATABASE_TARGET_MISMATCH',
    );
    expect(content.end).toHaveBeenCalledExactlyOnceWith({ timeout: 3 });
    expect(writer.end).not.toHaveBeenCalled();
  });

  it.each(['writer', 'content'] as const)(
    'refuses missing %s metadata without transferring pool ownership',
    async (side) => {
      (side === 'writer' ? writer : content).query.mockResolvedValue([]);
      await expect(assertSameCredentialDatabaseTarget(writer.pool, contentUrl, expected)).rejects.toThrow(
        'CREDENTIAL_DATABASE_TARGET_UNAVAILABLE',
      );
      expect(content.end).toHaveBeenCalledExactlyOnceWith({ timeout: 3 });
      expect(writer.end).not.toHaveBeenCalled();
    },
  );

  it.each(['writer', 'content'] as const)('closes its pool when the %s metadata query rejects', async (side) => {
    const failure = new Error('Owned target query failure');
    (side === 'writer' ? writer : content).query.mockRejectedValue(failure);
    await expect(assertSameCredentialDatabaseTarget(writer.pool, contentUrl, expected)).rejects.toBe(failure);
    expect(content.end).toHaveBeenCalledExactlyOnceWith({ timeout: 3 });
    expect(writer.end).not.toHaveBeenCalled();
  });

  it('does not report acceptance when transient pool cleanup fails', async () => {
    const failure = new Error('Owned transient cleanup failure');
    content.end.mockRejectedValue(failure);
    await expect(assertSameCredentialDatabaseTarget(writer.pool, contentUrl, expected)).rejects.toBe(failure);
    expect(content.end).toHaveBeenCalledOnce();
    expect(writer.end).not.toHaveBeenCalled();
  });

  it('leaves the caller pool owned by its caller if content pool construction fails', async () => {
    const failure = new Error('Owned content constructor failure');
    dependencies.createPool.mockImplementation(() => {
      throw failure;
    });
    await expect(assertSameCredentialDatabaseTarget(writer.pool, contentUrl, expected)).rejects.toBe(failure);
    expect(writer.query).not.toHaveBeenCalled();
    expect(writer.end).not.toHaveBeenCalled();
    expect(content.end).not.toHaveBeenCalled();
  });

  it.each(['', '?sslmode=require', '?sslmode=disable'])(
    'pins verified TLS for a remote content probe, previous=%s',
    async (suffix) => {
      const remote = contentUrl.replace('127.0.0.1:55480', 'owned-db.example.test') + suffix;
      await assertSameCredentialDatabaseTarget(writer.pool, remote, expected);
      const target = new URL(dependencies.createPool.mock.calls[0][0] as string);
      expect(target.hostname).toBe('owned-db.example.test');
      expect(target.searchParams.getAll('sslmode')).toEqual(['verify-full']);
      expect(content.end).toHaveBeenCalledOnce();
    },
  );
});
