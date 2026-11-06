import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type postgres from 'postgres';

const checkoutRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../../../..');

export async function hydrateAccountsFixtureSchema(writer: postgres.Sql): Promise<void> {
  // The backend worker schema omits NextAuth's accounts table. Hydrate only
  // its generated table and foreign key in the current disposable worker.
  const accountsTablePattern = /^CREATE TABLE IF NOT EXISTS "accounts" \(/;
  const accountsForeignKeyPattern =
    /^DO \$\$ BEGIN\s+ALTER TABLE "accounts" ADD CONSTRAINT "accounts_userId_users_id_fk" FOREIGN KEY/;
  const accountsStatements = readFileSync(join(checkoutRoot, 'packages/db/drizzle/0016_exotic_valkyrie.sql'), 'utf8')
    .split('--> statement-breakpoint')
    .map((statement) => statement.trim())
    .filter((statement) => accountsTablePattern.test(statement) || accountsForeignKeyPattern.test(statement));
  if (
    accountsStatements.length !== 2 ||
    !accountsTablePattern.test(accountsStatements[0] ?? '') ||
    !accountsForeignKeyPattern.test(accountsStatements[1] ?? '')
  )
    throw new Error('Generated accounts fixture migration is unavailable.');
  for (const statement of accountsStatements) await writer.unsafe(statement);
}
