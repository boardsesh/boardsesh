import { expect, it } from 'vite-plus/test';
import postgres from 'postgres';
import { schemaSQL } from './schema-sql';
import { getWorkerDatabaseUrl } from './worker-db';

it('rebuilds the fixture when durable climb receipts already exist', async () => {
  // The backend setup has already installed the schema in this worker's
  // disposable database. CI reuses worker pool IDs across processes, and
  // worker-db reapplies the fixture when that database already exists. A
  // migration's CREATE TABLE must therefore have a matching fixture DROP.
  const client = postgres(getWorkerDatabaseUrl(), { max: 1, onnotice: () => {} });
  try {
    for (let reset = 0; reset < 2; reset += 1) {
      await client`INSERT INTO climb_mutation_receipts (operation_key, climb_uuid, board_type)
        VALUES ('create:fixture-climb', 'fixture-climb', 'spray')`;
      await client.unsafe(schemaSQL);
      const [remaining] = await client<{ total: number }[]>`SELECT count(*)::int AS total FROM climb_mutation_receipts`;
      expect(remaining.total).toBe(0);
    }
    await client`INSERT INTO climb_mutation_receipts (operation_key, climb_uuid, board_type)
      VALUES ('create:fixture-climb', 'fixture-climb', 'spray')`;
    const [receipt] = await client<{ climb_uuid: string }[]>`SELECT climb_uuid FROM climb_mutation_receipts`;
    expect(receipt.climb_uuid).toBe('fixture-climb');
  } finally {
    await client.end();
  }
});
