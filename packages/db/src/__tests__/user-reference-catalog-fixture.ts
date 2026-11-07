import assert from 'node:assert/strict';
import type postgres from 'postgres';
import {
  collectUserReferenceCatalog,
  compareUserReferences,
  MANUAL_USER_REFERENCES,
  referenceIdentity,
  type UserReference,
  type UserReferenceCatalog,
} from '../user-reference-catalog';

/** Invoked only by the maintained command after its new fixture passes the baseline contract. */
export async function exerciseUserReferenceCatalog(
  client: postgres.Sql,
  expected: readonly UserReference[],
  baseline: UserReferenceCatalog,
  assertLedger: (catalog: UserReferenceCatalog) => void,
): Promise<{ passed: string[]; fixtureIntentionallyChanged: true }> {
  const [physical] = await client<{ database: string; oid: number; system: string; address: string | null }[]>`
    SELECT pg_catalog.current_database() AS database,
      (SELECT oid::integer FROM pg_catalog.pg_database WHERE datname = pg_catalog.current_database()) AS oid,
      (SELECT system_identifier::text FROM pg_catalog.pg_control_system()) AS system,
      pg_catalog.inet_client_addr()::text AS address`;
  assert.match(physical.database, /^boardsesh_catalog_[a-f0-9]{32}$/);
  assert.equal(physical.database, baseline.physical.database);
  assert.equal(physical.oid, baseline.physical.databaseOid);
  assert.equal(physical.system, baseline.physical.systemIdentifier);
  assert.equal(physical.address, null);
  assert.deepEqual(compareUserReferences(expected, baseline.references), []);
  assertLedger(baseline);
  const passed: string[] = [];
  const manualIdentity = referenceIdentity(MANUAL_USER_REFERENCES[0]);
  const manualDifference = async () =>
    compareUserReferences(expected, (await collectUserReferenceCatalog(client)).references).find(
      (difference) => difference.identity === manualIdentity,
    );

  await client.unsafe(`CREATE TABLE public.catalog_proof_extra_user_reference (
    user_id text REFERENCES public.users(id)
  )`);
  const extra = compareUserReferences(expected, (await collectUserReferenceCatalog(client)).references);
  assert.ok(
    extra.some(
      (difference) =>
        difference.kind === 'unexpected' && difference.observed?.table === 'catalog_proof_extra_user_reference',
    ),
  );
  passed.push('extra-users-foreign-key-rejected');

  await client.unsafe(`ALTER TABLE public.board_beta_links DROP CONSTRAINT board_beta_links_created_by_user_id_fkey`);
  assert.equal((await manualDifference())?.kind, 'missing');
  passed.push('missing-migration-managed-foreign-key-rejected');

  await client.unsafe(`ALTER TABLE public.board_beta_links
    ADD CONSTRAINT board_beta_links_created_by_user_id_fkey FOREIGN KEY (created_by_user_id)
    REFERENCES public.users(id) ON DELETE SET NULL NOT VALID`);
  const unvalidated = await manualDifference();
  assert.equal(unvalidated?.kind, 'different');
  assert.equal(unvalidated.observed?.validated, false);
  assert.equal(unvalidated.observed?.onDelete, 'set null');
  passed.push('unvalidated-foreign-key-rejected');

  await client.unsafe(`ALTER TABLE public.board_beta_links DROP CONSTRAINT board_beta_links_created_by_user_id_fkey`);
  await client.unsafe(`ALTER TABLE public.board_beta_links
    ADD CONSTRAINT board_beta_links_created_by_user_id_fkey FOREIGN KEY (created_by_user_id)
    REFERENCES public.users(id) ON DELETE CASCADE`);
  const alteredAction = await manualDifference();
  assert.equal(alteredAction?.kind, 'different');
  assert.equal(alteredAction.observed?.onDelete, 'cascade');
  assert.equal(alteredAction.observed?.validated, true);
  passed.push('changed-delete-action-rejected');

  // Controlled ASCII fixture text, never user input. The routine is declared, not called.
  await client.unsafe(`CREATE FUNCTION public.catalog_proof_oversized() RETURNS text
    LANGUAGE sql AS $catalog_proof$ SELECT '${'x'.repeat(70 * 1024)}'::text $catalog_proof$`);
  await assert.rejects(() => collectUserReferenceCatalog(client), /Catalog row exceeds text budget/);
  passed.push('oversized-routine-rejected-before-client-text-allocation');
  await client.unsafe('DROP FUNCTION public.catalog_proof_oversized()');

  await assert.rejects(() => collectUserReferenceCatalog(client, { maximumRows: 1 }), /Catalog budget exceeded/);
  passed.push('aggregate-row-budget-rejected');
  await assert.rejects(() => collectUserReferenceCatalog(client, { maximumBytes: 1 }), /Catalog budget exceeded/);
  passed.push('aggregate-byte-budget-rejected');

  await client.unsafe(`CREATE ROLE catalog_proof_reader NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE
    INHERIT NOREPLICATION NOBYPASSRLS`);
  try {
    await client.unsafe('SET ROLE catalog_proof_reader');
    await assert.rejects(
      () => collectUserReferenceCatalog(client),
      (failure: unknown) =>
        typeof failure === 'object' && failure !== null && 'code' in failure && failure.code === '42501',
    );
    passed.push('insufficient-catalog-visibility-rejected');
  } finally {
    await client.unsafe('RESET ROLE');
  }

  await client.unsafe(`UPDATE public.__drizzle_migrations SET hash = 'catalog_proof_invalid_ledger_hash'
    WHERE id = (SELECT min(id) FROM public.__drizzle_migrations)`);
  const incompleteLedger = await collectUserReferenceCatalog(client);
  assert.throws(() => assertLedger(incompleteLedger));
  passed.push('incomplete-migration-ledger-rejected');
  return { passed, fixtureIntentionallyChanged: true };
}
