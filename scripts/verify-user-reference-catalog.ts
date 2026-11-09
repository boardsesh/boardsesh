/// <reference types="node" />
import { closeSync, existsSync, fchmodSync, fsyncSync, openSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  CatalogCommandFailure,
  digest,
  OwnedCatalogPostgres,
  regularFile,
  requireCatalog,
  requireCatalogSourceHead,
  snapshotCatalogSource,
  savePrivateJson,
} from './lib/owned-catalog-postgres';
import type { UserReferenceCatalog } from '../packages/db/src/user-reference-catalog';

export interface CatalogOptions {
  sourceRoot: string;
  sourceHead: string;
  harnessHead: string;
  output: string;
  image: string;
}

export function parseCatalogOptions(arguments_: readonly string[]): CatalogOptions | null {
  if (arguments_.length === 0 || (arguments_.length === 1 && arguments_[0] === '--plan')) return null;
  // vp preserves its forwarding separator after the task's fixed --run flag.
  const runArguments =
    arguments_[0] === '--run' && arguments_[1] === '--' ? [arguments_[0], ...arguments_.slice(2)] : arguments_;
  requireCatalog(runArguments[0] === '--run' && runArguments.length === 11 && !runArguments.includes('--'));
  const allowed = ['--source-root', '--source-head', '--harness-head', '--out', '--image'];
  const selected = new Map<string, string>();
  for (let index = 1; index < runArguments.length; index += 2) {
    const option = runArguments[index],
      contents = runArguments[index + 1];
    requireCatalog(allowed.includes(option) && contents && !selected.has(option));
    selected.set(option, contents);
  }
  const sourceHead = selected.get('--source-head')!,
    harnessHead = selected.get('--harness-head')!;
  requireCatalog(/^[a-f0-9]{40}$/.test(sourceHead) && /^[a-f0-9]{40}$/.test(harnessHead));
  const image = selected.get('--image')!;
  requireCatalog(/^sha256:[a-f0-9]{64}$/.test(image));
  return {
    sourceRoot: resolve(selected.get('--source-root')!),
    sourceHead,
    harnessHead,
    image,
    output: resolve(selected.get('--out')!),
  };
}

/** Admission rejects unbound loader configuration; it cannot undo earlier tsx startup reads. */
export function requireCatalogInvocation(
  harnessRoot: string,
  environmentNames: readonly string[],
  nodeArguments: readonly string[],
  cwd: string,
): void {
  requireCatalog(realpathSync(cwd) === realpathSync(harnessRoot));
  requireCatalog(
    JSON.stringify(nodeArguments) === JSON.stringify(['--import', 'tsx']) ||
      JSON.stringify(nodeArguments) === JSON.stringify(['--import=tsx']),
  );
  requireCatalog(
    !environmentNames.some((name) =>
      /^(?:NODE_OPTIONS|NODE_PATH|TSX_.*|ESBUILD_.*)$|^(?:PG|DATABASE_|POSTGRES_|DB_URL$|READ_REPLICA_|REDIS_|MIGRATOR_DATABASE_|ADMIN_DATABASE_|SYNC_CUTOFF_)/.test(
        name,
      ),
    ),
  );
  // The supported standalone entrypoint currently has no default root config.
  // A future tracked root tsconfig needs an explicit reviewed resolution contract.
  let directory = realpathSync(cwd);
  for (;;) {
    requireCatalog(!existsSync(join(directory, 'tsconfig.json')));
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
}

interface Migration {
  tag: string;
  when: number;
  hash: string;
  sql: string;
}

export function readCatalogMigrations(sourceRoot: string): Migration[] {
  const journal = JSON.parse(regularFile(join(sourceRoot, 'packages/db/drizzle/meta/_journal.json')).toString()) as {
    entries?: unknown;
  };
  requireCatalog(Array.isArray(journal.entries) && journal.entries.length > 0 && journal.entries.length < 10_000);
  const names = new Set<string>();
  return journal.entries.map((entry: unknown) => {
    requireCatalog(typeof entry === 'object' && entry !== null && 'tag' in entry && 'when' in entry);
    const { tag, when } = entry;
    requireCatalog(typeof tag === 'string' && /^[A-Za-z0-9_.-]+$/.test(tag) && !names.has(tag));
    requireCatalog(typeof when === 'number' && Number.isSafeInteger(when) && when > 0);
    names.add(tag);
    const bytes = regularFile(join(sourceRoot, `packages/db/drizzle/${tag}.sql`));
    const sql = bytes.toString('utf8');
    requireCatalog(Buffer.from(sql).equals(bytes));
    return { tag, when, hash: digest(bytes), sql };
  });
}

function requireLiteral(source: string, literal: string): void {
  requireCatalog(source.split(literal).length === 2);
}

/** Only reviewed literal clauses are extracted; no imported dotenv/CLI or edited migration body. */
export function cutoffBootstrapSql(sourceRoot: string): string {
  const development = regularFile(
    join(sourceRoot, 'packages/db/scripts/bootstrap-sync-deletions-cutoff-development.ts'),
  ).toString();
  const bootstrap = regularFile(join(sourceRoot, 'packages/db/scripts/bootstrap-sync-deletions-cutoff.ts')).toString();
  requireLiteral(development, "const runtimeRole = process.env.SYNC_CUTOFF_RUNTIME_ROLE ?? 'boardsesh_runtime';");
  requireLiteral(bootstrap, "const OWNER_ROLE = 'boardsesh_sync_cutoff_owner';");
  const runtime = 'LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT NOREPLICATION NOBYPASSRLS';
  const owner = 'NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT NOREPLICATION NOBYPASSRLS';
  requireLiteral(development, `CREATE ROLE "\${runtimeRole}" ${runtime}`);
  requireLiteral(bootstrap, `CREATE ROLE \${OWNER_ROLE} ${owner}`);
  requireLiteral(bootstrap, 'GRANT pg_read_all_stats TO ${OWNER_ROLE} WITH ADMIN FALSE, INHERIT TRUE, SET FALSE');
  requireLiteral(
    bootstrap,
    'ALTER FUNCTION public.sync_deletions_safe_cutoff(double precision) OWNER TO ${OWNER_ROLE}',
  );
  requireLiteral(
    bootstrap,
    'GRANT EXECUTE ON FUNCTION public.sync_deletions_safe_cutoff(double precision) TO "${runtimeRole}"',
  );
  const functionSql = regularFile(
    join(sourceRoot, 'packages/db/scripts/sync-deletions-cutoff-function.sql'),
  ).toString();
  const contract = regularFile(join(sourceRoot, 'packages/db/scripts/sync-deletions-cutoff-contract.sql')).toString();
  const contractSql = contract.replaceAll('__SYNC_RUNTIME_ROLE__', 'boardsesh_runtime').trim().replace(/;$/, '');
  requireCatalog(contractSql.endsWith('AS matches'));
  return `BEGIN;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname IN ('boardsesh_runtime','boardsesh_sync_cutoff_owner')) THEN
    RAISE EXCEPTION 'Fresh cutoff role prerequisite failed';
  END IF;
END $$;
CREATE ROLE boardsesh_runtime ${runtime};
CREATE ROLE boardsesh_sync_cutoff_owner ${owner};
GRANT pg_read_all_stats TO boardsesh_sync_cutoff_owner WITH ADMIN FALSE, INHERIT TRUE, SET FALSE;
${functionSql}
ALTER FUNCTION public.sync_deletions_safe_cutoff(double precision) OWNER TO boardsesh_sync_cutoff_owner;
GRANT EXECUTE ON FUNCTION public.sync_deletions_safe_cutoff(double precision) TO boardsesh_runtime;
CREATE TEMP TABLE owned_cutoff_contract ON COMMIT DROP AS ${contractSql};
DO $$ BEGIN
  IF (SELECT matches FROM owned_cutoff_contract) IS DISTINCT FROM true THEN RAISE EXCEPTION 'Cutoff contract failed'; END IF;
END $$;
COMMIT;`;
}

function requireLedgers(catalog: UserReferenceCatalog, migrations: readonly Migration[]): void {
  const expected = migrations.map((migration) => `${migration.hash}:${migration.when}`).sort();
  for (const ledger of [catalog.ledgers.public, catalog.ledgers.drizzle]) {
    const observed = ledger.map((entry) => `${entry.hash}:${entry.createdAt}`).sort();
    requireCatalog(JSON.stringify(observed) === JSON.stringify(expected));
  }
}

export async function runUserReferenceCatalog(options: CatalogOptions): Promise<Record<string, unknown>> {
  const harnessRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  requireCatalogInvocation(harnessRoot, Object.keys(process.env), process.execArgv, process.cwd());
  let phase = 'source-manifests';
  const controller = new AbortController();
  const expiresAt = performance.now() + 600_000;
  const abort = () => controller.abort();
  process.once('SIGINT', abort);
  process.once('SIGTERM', abort);
  const deadline = setTimeout(abort, 600_000);
  let descriptor: number | undefined;
  let owned: OwnedCatalogPostgres | undefined;
  const progress: Record<string, unknown> = { kind: 'detail-only', completed: false };
  try {
    const source = await snapshotCatalogSource(options.sourceRoot, options.sourceHead);
    const harness = await snapshotCatalogSource(harnessRoot, options.harnessHead);
    const checkpoint = async () => {
      requireCatalog(!controller.signal.aborted && performance.now() < expiresAt);
      await requireCatalogSourceHead(source);
      await requireCatalogSourceHead(harness);
      requireCatalog(!controller.signal.aborted && performance.now() < expiresAt);
    };
    progress.source = source;
    progress.harness = harness;
    await checkpoint();
    const migrations = readCatalogMigrations(source.root);
    const bootstrapSql = cutoffBootstrapSql(source.root);
    descriptor = openSync(options.output, 'wx', 0o600);
    fchmodSync(descriptor, 0o600);
    owned = new OwnedCatalogPostgres(controller.signal, source.root, options.image);
    savePrivateJson(`${options.output}.claim.json`, {
      kind: 'detail-only',
      sourceHead: source.head,
      harnessHead: harness.head,
      resources: owned.resourceEvidence(),
    });
    const collector = (await import(
      pathToFileURL(join(harnessRoot, 'packages/db/src/user-reference-catalog.ts')).href
    )) as typeof import('../packages/db/src/user-reference-catalog');
    const schemaExports = (await import(
      pathToFileURL(join(source.root, 'packages/db/src/schema/index.ts')).href
    )) as Record<string, unknown>;
    const initializer = (await import(
      pathToFileURL(join(source.root, 'packages/db/src/job-queue-schema.ts')).href
    )) as typeof import('../packages/db/src/job-queue-schema');
    const drizzleModule = (await import(
      pathToFileURL(join(source.root, 'packages/db/node_modules/drizzle-orm/postgres-js/index.js')).href
    )) as typeof import('../packages/db/node_modules/drizzle-orm/postgres-js');
    await checkpoint();
    const expected = collector.readExpectedUserReferences(schemaExports);
    phase = 'fresh-cluster';
    const identity = await owned.start();
    progress.identity = identity;
    await checkpoint();
    phase = 'prerequisites';
    await owned.psql(
      regularFile(join(source.root, 'packages/db/docker/legacy-aurora-schema-stub.sql')).toString(),
      true,
    );
    await owned.psql(
      `\\set boardsesh_dev_role_bootstrap true\n${regularFile(join(source.root, 'packages/db/docker/bootstrap-pg18-development-roles.sql')).toString()}`,
    );
    await owned.psql(bootstrapSql);
    const imageLoop = regularFile(join(source.root, 'packages/db/docker/apply-drizzle-migrations.sh')).toString();
    const ledgerStatements = [...imageLoop.matchAll(/-c '([^']+)'/g)].map((match) => match[1]);
    requireCatalog(
      ledgerStatements.length === 3 && ledgerStatements.every((statement) => statement.startsWith('CREATE ')),
    );
    await owned.psql(ledgerStatements.join(';\n'), true);
    phase = 'journal';
    for (const [index, migration] of migrations.entries()) {
      requireCatalog(!controller.signal.aborted && performance.now() < expiresAt);
      requireCatalog(
        digest(regularFile(join(source.root, `packages/db/drizzle/${migration.tag}.sql`))) === migration.hash,
      );
      progress.currentMigration = { tag: migration.tag, index, hash: migration.hash };
      await owned.psql(
        `${migration.sql}\nINSERT INTO public."__drizzle_migrations" (hash,created_at) VALUES ('${migration.hash}',${migration.when});\nINSERT INTO drizzle."__drizzle_migrations" (hash,created_at) VALUES ('${migration.hash}',${migration.when});`,
        true,
      );
      progress.lastAcknowledgedMigration = { tag: migration.tag, count: index + 1, hash: migration.hash };
    }
    await checkpoint();
    phase = 'journal-and-runtime-catalog';
    const catalogs = await owned.withClient(async (client) => {
      await checkpoint();
      const journal = await collector.collectUserReferenceCatalog(client);
      progress.journalCatalog = journal;
      requireLedgers(journal, migrations);
      const journalDifferences = collector.compareUserReferences(expected, journal.references);
      progress.journalDifferences = journalDifferences.slice(0, 100);
      progress.omittedJournalDifferences = Math.max(0, journalDifferences.length - 100);
      requireCatalog(journalDifferences.length === 0);
      await checkpoint();
      await initializer.initializeJobQueueSchema(drizzleModule.drizzle(client));
      progress.runtimeJobSchemaInitialized = true;
      await checkpoint();
      const runtime = await collector.collectUserReferenceCatalog(client);
      progress.runtimeCatalog = runtime;
      requireLedgers(runtime, migrations);
      const runtimeDifferences = collector.compareUserReferences(expected, runtime.references);
      progress.runtimeDifferences = runtimeDifferences.slice(0, 100);
      progress.omittedRuntimeDifferences = Math.max(0, runtimeDifferences.length - 100);
      requireCatalog(runtimeDifferences.length === 0);
      requireCatalog(
        runtime.physical.systemIdentifier === identity.systemIdentifier &&
          runtime.physical.databaseOid === identity.databaseOid,
      );
      requireCatalog(
        runtime.extensions.some((extension) => extension.name === 'postgis' && extension.version === '3.6.4'),
      );
      requireCatalog(
        ['uuid-ossp', 'pg_trgm'].every((name) => runtime.extensions.some((extension) => extension.name === name)),
      );
      await checkpoint();
      const fixtures = (await import(
        pathToFileURL(join(harnessRoot, 'packages/db/src/__tests__/user-reference-catalog-fixture.ts')).href
      )) as typeof import('../packages/db/src/__tests__/user-reference-catalog-fixture');
      await checkpoint();
      const negatives = await fixtures.exerciseUserReferenceCatalog(client, expected, runtime, (catalog) =>
        requireLedgers(catalog, migrations),
      );
      progress.negativeProof = negatives;
      await checkpoint();
      return { journal, runtime, negatives };
    });
    phase = 'closure';
    await owned.stop();
    await checkpoint();
    const detail = {
      kind: 'detail-only',
      source,
      harness,
      nodeVersion: process.version,
      identity,
      expected,
      migrations: migrations.map(({ sql: _sql, ...migration }) => migration),
      catalogs,
    };
    const bytes = Buffer.from(`${JSON.stringify(detail, null, 2)}\n`);
    requireCatalog(bytes.length <= 64 * 1024 * 1024);
    writeFileSync(descriptor, bytes);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    await checkpoint();
    return {
      status: 'complete',
      sourceHead: source.head,
      harnessHead: harness.head,
      migrationCount: migrations.length,
      userReferenceCount: expected.length,
      journalAppliedCompletely: true,
      runtimeJobSchemaInitialized: true,
      negativeCasesPassed: catalogs.negatives.passed,
      retainedFixtureIntentionallyChanged: catalogs.negatives.fixtureIntentionallyChanged,
      catalogScope:
        'Inbound public.users foreign keys plus observed application catalog routines, triggers, dependencies and metadata; no production role overlay or lock-order claim.',
      connectionClosed: true,
      containerStopped: true,
      fixtureRetained: true,
      detailSha256: digest(bytes),
      detailBytes: bytes.length,
      portableCatalogSha256: collector.portableCatalogDigest(catalogs.runtime),
      output: options.output,
    };
  } catch (error) {
    progress.error =
      error instanceof CatalogCommandFailure
        ? {
            category: 'command-failure',
            sqlState: error.sqlState,
            exitCode: error.exitCode,
            childCloseObserved: true,
            groupDrained: error.groupDrained,
          }
        : {
            category:
              error instanceof Error && ['Error', 'TypeError', 'SyntaxError', 'RangeError'].includes(error.name)
                ? error.name
                : 'rejected',
          };
    let containerStopObserved = false;
    try {
      await owned?.stop();
      containerStopObserved = Boolean(owned?.resourceEvidence().containerStopped);
    } catch {
      /* Incomplete cleanup stays explicit. */
    }
    if (descriptor !== undefined) {
      const failure = Buffer.from(
        `${JSON.stringify({ ...progress, phase, resources: owned?.resourceEvidence() ?? null, containerStopObserved }, null, 2)}\n`,
      );
      requireCatalog(failure.length <= 64 * 1024 * 1024);
      writeFileSync(descriptor, failure);
      fsyncSync(descriptor);
      closeSync(descriptor);
      descriptor = undefined;
    }
    throw new Error(`Owned catalog proof incomplete during ${phase}.`);
  } finally {
    clearTimeout(deadline);
    process.removeListener('SIGINT', abort);
    process.removeListener('SIGTERM', abort);
    try {
      await owned?.stop();
    } finally {
      if (descriptor !== undefined) closeSync(descriptor);
    }
  }
}

async function main(): Promise<void> {
  try {
    const options = parseCatalogOptions(process.argv.slice(2));
    if (!options)
      console.info(
        JSON.stringify({
          action: 'plan',
          createsFreshOfflineCluster: true,
          existingDatabaseOrCredentialsAccepted: false,
          fixturesRetained: true,
          execution:
            '--run --source-root PATH --source-head SHA --harness-head SHA --image sha256:LOCAL_IMAGE_ID --out NEW_JSON',
        }),
      );
    else console.info(JSON.stringify(await runUserReferenceCatalog(options)));
  } catch (error) {
    const phase =
      error instanceof Error
        ? (/^Owned catalog proof incomplete during ([a-z-]+)\.$/.exec(error.message)?.[1] ?? 'input')
        : 'input';
    console.error(JSON.stringify({ status: 'incomplete', phase, completed: false, fixtureDeletionPerformed: false }));
    process.exitCode = 1;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) void main();
