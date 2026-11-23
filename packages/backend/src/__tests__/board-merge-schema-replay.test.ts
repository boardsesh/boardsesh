import { describe, expect, it } from 'vite-plus/test';
import postgres from 'postgres';
import { schemaSQL } from './schema-sql';
import { getWorkerDatabaseUrl } from './worker-db';

describe('board merge test schema', () => {
  it('recreates merge tables when an existing test worker database is hydrated again', async () => {
    // The setup file has already applied schemaSQL once to this disposable worker.
    const client = postgres(getWorkerDatabaseUrl(), { max: 1, onnotice: () => {} });
    try {
      await client.unsafe(schemaSQL);
      const tables = await client<
        { table_name: string }[]
      >`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name LIKE 'board_merge_%' ORDER BY table_name`;
      expect(tables.map((table) => table.table_name)).toEqual([
        'board_merge_audit',
        'board_merge_reports',
        'board_merge_requests',
      ]);
    } finally {
      await client.end();
    }
  });
});
