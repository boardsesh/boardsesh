import { describe, expect, it, vi } from 'vitest';
import type { SQLiteDatabase } from 'expo-sqlite';
import { SchemaNewerThanAppError } from '@boardsesh/offline-sync';
import { refuseDatabase } from '../refused-database';

const DOWNGRADE = { storedVersion: 11, supportedVersion: 10 };

function createConnection() {
  const calls = {
    getAllAsync: vi.fn(async () => [{ id: 1 }]),
    getFirstAsync: vi.fn(async () => ({ id: 1 })),
    runAsync: vi.fn(async () => ({ lastInsertRowId: 1, changes: 1 })),
    execAsync: vi.fn(async () => undefined),
    withExclusiveTransactionAsync: vi.fn(async (task: () => Promise<void>) => task()),
    runSync: vi.fn(() => ({ lastInsertRowId: 1, changes: 1 })),
    execSync: vi.fn(() => undefined),
  };
  const connection = { ...calls, databasePath: '/data/boardsesh.db' } as unknown as SQLiteDatabase;
  return { connection, calls };
}

describe('refuseDatabase', () => {
  it('rejects every async call with the typed error and never reaches SQLite', async () => {
    const { connection, calls } = createConnection();
    const refused = refuseDatabase(connection, DOWNGRADE);

    await expect(refused.getAllAsync('SELECT * FROM pending_mutations')).rejects.toBeInstanceOf(
      SchemaNewerThanAppError,
    );
    await expect(refused.getFirstAsync('SELECT 1')).rejects.toBeInstanceOf(SchemaNewerThanAppError);
    await expect(refused.runAsync('DELETE FROM pending_mutations')).rejects.toBeInstanceOf(SchemaNewerThanAppError);
    await expect(refused.execAsync('VACUUM')).rejects.toBeInstanceOf(SchemaNewerThanAppError);

    for (const call of Object.values(calls)) expect(call).not.toHaveBeenCalled();
  });

  it('refuses a transaction before its task runs', async () => {
    const { connection, calls } = createConnection();
    const refused = refuseDatabase(connection, DOWNGRADE);
    const task = vi.fn(async () => undefined);

    await expect(refused.withExclusiveTransactionAsync(task)).rejects.toBeInstanceOf(SchemaNewerThanAppError);

    expect(task).not.toHaveBeenCalled();
    expect(calls.withExclusiveTransactionAsync).not.toHaveBeenCalled();
  });

  it('throws from a synchronous call, which cannot await a rejection', () => {
    const { connection, calls } = createConnection();
    const refused = refuseDatabase(connection, DOWNGRADE);

    expect(() => refused.runSync('DELETE FROM pending_mutations')).toThrow(SchemaNewerThanAppError);
    expect(() => refused.execSync('VACUUM')).toThrow(SchemaNewerThanAppError);
    expect(calls.runSync).not.toHaveBeenCalled();
    expect(calls.execSync).not.toHaveBeenCalled();
  });

  it('carries both versions on the error', async () => {
    const { connection } = createConnection();
    const refused = refuseDatabase(connection, DOWNGRADE);

    await expect(refused.getFirstAsync('SELECT 1')).rejects.toMatchObject({
      storedVersion: 11,
      supportedVersion: 10,
    });
  });

  it('passes through members that describe the connection without touching the file', () => {
    const { connection } = createConnection();

    expect(refuseDatabase(connection, DOWNGRADE).databasePath).toBe('/data/boardsesh.db');
  });

  it('hands back one stand-in per connection, so effect deps stay stable', () => {
    const { connection } = createConnection();
    const { connection: other } = createConnection();

    expect(refuseDatabase(connection, DOWNGRADE)).toBe(refuseDatabase(connection, DOWNGRADE));
    expect(refuseDatabase(other, DOWNGRADE)).not.toBe(refuseDatabase(connection, DOWNGRADE));
  });

  it('never throws on a property read, only on a call', () => {
    const { connection } = createConnection();
    const refused = refuseDatabase(connection, DOWNGRADE);

    expect(() => Reflect.get(refused, 'runSync')).not.toThrow();
    expect(() => Reflect.get(refused, 'getAllAsync')).not.toThrow();
    expect(() => Reflect.get(refused, 'noSuchMember')).not.toThrow();
  });

  it('leaves symbol-keyed members alone, so the runtime\u2019s own probes behave as on the connection', () => {
    const describe = () => 'SQLiteDatabase';
    const connection = {
      getAllAsync: vi.fn(async () => []),
      [Symbol.toPrimitive]: describe,
      [Symbol.toStringTag]: 'SQLiteDatabase',
    } as unknown as SQLiteDatabase;
    const refused = refuseDatabase(connection, DOWNGRADE);

    expect(Reflect.get(refused, Symbol.toPrimitive)).toBe(describe);
    expect(Object.prototype.toString.call(refused)).toBe('[object SQLiteDatabase]');
    expect(Reflect.get(refused, Symbol.iterator)).toBeUndefined();
  });

  it('is not a thenable: awaiting it resolves to the stand-in instead of rejecting', async () => {
    const { connection } = createConnection();
    const refused = refuseDatabase(connection, DOWNGRADE);

    expect(Reflect.get(refused, 'then')).toBeUndefined();
    await expect(Promise.resolve(refused)).resolves.toBe(refused);
  });
});
