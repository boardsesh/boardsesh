/// <reference types="node" />

import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const WORKFLOWS_DIR = '.github/workflows';

/**
 * File-text guard for #4211.
 *
 * `Dockerfile.dev-db` applies the migration journal in a psql loop and writes
 * drizzle's ledger by hand. It used to stamp `created_at` with the image's build
 * clock, which becomes a high-water mark that only ever moves up — so every
 * journal entry with an earlier `when` that the image did not itself apply (a
 * branch's migration, written before the image was built) is silently skipped on
 * that database, for good.
 *
 * Building the image to check this takes tens of minutes and hits the network
 * hard (six APK downloads, pgloader, the MoonBoard import), so the practical
 * coverage is this text guard plus the in-build assertion it requires: the
 * ledger's high-water mark must equal the journal's newest `when`.
 */
const DOCKERFILE_PATH = 'packages/db/docker/Dockerfile.dev-db';
const dockerfileSource = readFileSync(DOCKERFILE_PATH, 'utf8');

/** Non-comment lines only — the `date +%s` ban must not be satisfiable by a comment. */
const executableLines = dockerfileSource
  .split('\n')
  .filter((line) => !line.trimStart().startsWith('#'))
  .join('\n');

describe('dev-db image migration ledger', () => {
  it('never stamps ledger rows with the build clock', () => {
    const ledgerInserts = executableLines
      .split('\n')
      .filter((line) => line.includes('INSERT INTO') && line.includes('__drizzle_migrations'));
    expect(ledgerInserts.length).toBeGreaterThan(0);
    for (const insert of ledgerInserts) {
      expect(insert).not.toContain('date +%s');
      expect(insert).toContain('$when');
    }
  });

  it('reads the when of each entry out of the journal', () => {
    expect(executableLines).toContain(`jq -r '.entries[] | "\\(.tag) \\(.when)"' /drizzle/meta/_journal.json`);
    expect(executableLines).toContain('while read -r tag when; do');
  });

  it('fails the build when the ledger high-water mark is not the newest journal when', () => {
    expect(executableLines).toContain(
      'ledger_max=$(gosu postgres psql -h /var/run/postgresql main -t -A -c "SELECT COALESCE(max(created_at), 0) FROM drizzle.\\"__drizzle_migrations\\"")',
    );
    expect(executableLines).toContain(`journal_max=$(jq -r '[.entries[].when] | max' /drizzle/meta/_journal.json)`);
    expect(executableLines).toContain('if [ "$ledger_max" != "$journal_max" ]; then');
  });
});

/**
 * `vp run db:up` repairs the container it just started — and only that one.
 *
 * `getScriptDatabaseUrl()` reads `DB_URL || DATABASE_URL || POSTGRES_URL`, and
 * its dotenv chain fills whichever of the three the caller leaves unset from
 * `.env.local` / `packages/web/.env.local`. A `DB_URL` naming a remote or
 * production database is a normal thing to have there (docs/db-migrations.md's
 * own `db:verify-journal` example is invoked with `DB_URL`), and it would beat a
 * lone `DATABASE_URL=…localhost` on the normaliser's own command line: `db:up`
 * would then either die on the non-local guard under `set -e`, or — for the
 * tailnet MagicDNS/CGNAT hosts `isLocalDatabaseUrl` deliberately accepts —
 * quietly rewrite some other database's ledger.
 */
describe('dev-db-up.sh ledger normalisation target', () => {
  const devDbUpSource = readFileSync('scripts/dev-db-up.sh', 'utf8');
  const normalizeFunction = devDbUpSource.slice(
    devDbUpSource.indexOf('normalize_ledger_timestamps() {'),
    devDbUpSource.indexOf('prepare_docker_postgres() {'),
  );

  it('pins every name getScriptDatabaseUrl reads to the local container', () => {
    expect(normalizeFunction).toContain('db:normalize-ledger');
    for (const envName of ['DB_URL', 'DATABASE_URL', 'POSTGRES_URL']) {
      expect(normalizeFunction).toContain(`${envName}="$dev_db_ledger_url"`);
    }
    expect(normalizeFunction).toContain('dev_db_ledger_url="postgresql://postgres:password@localhost:5432/main"');
  });

  it('runs the repair before the pending-migration apply', () => {
    // After the apply the repair is useless: the migrations it would have
    // unblocked have already been skipped, and the ledger only moves up.
    const prepare = devDbUpSource.slice(devDbUpSource.indexOf('prepare_docker_postgres() {'));
    const normalizeIndex = prepare.indexOf('normalize_ledger_timestamps');
    const applyIndex = prepare.indexOf('run_pending_drizzle_sql_migrations');
    expect(normalizeIndex).toBeGreaterThan(-1);
    expect(applyIndex).toBeGreaterThan(normalizeIndex);
  });
});

/**
 * The repair has to be wired into *every* CI job that boots the image and then
 * applies migrations — three of them today, and the next one is easy to add
 * without noticing this exists. `ci-location-sync-workflow.test.ts` pins the
 * ordering for its own job only, so this sweeps the rest.
 *
 * The exemption below is the one case that is genuinely safe, and it is listed
 * rather than skipped so that a reviewer sees the reasoning instead of the gap.
 */
const RENUMBER_EXEMPTION = { workflow: 'db-migration-renumber.yml', job: 'renumber' };

/** Job bodies keyed `<workflow file>#<job name>`, split on the 2-space job keys under `jobs:`. */
function readWorkflowJobs(): Map<string, string> {
  const jobs = new Map<string, string>();
  for (const fileName of readdirSync(WORKFLOWS_DIR).filter((name) => name.endsWith('.yml'))) {
    const lines = readFileSync(path.join(WORKFLOWS_DIR, fileName), 'utf8').split('\n');
    const jobsIndex = lines.findIndex((line) => line === 'jobs:');
    if (jobsIndex < 0) continue;

    let currentJob: string | null = null;
    let currentStart = 0;
    const flush = (endIndex: number) => {
      if (currentJob) jobs.set(`${fileName}#${currentJob}`, lines.slice(currentStart, endIndex).join('\n'));
    };
    for (let index = jobsIndex + 1; index < lines.length; index += 1) {
      const jobKey = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(lines[index]);
      if (jobKey) {
        flush(index);
        currentJob = jobKey[1];
        currentStart = index;
      }
    }
    flush(lines.length);
  }
  return jobs;
}

describe('CI jobs that boot the dev-db image', () => {
  // `db:migrate` and `bunx drizzle-kit migrate` are the same applier; both read
  // max(created_at) once, so both are blocked by a build-clock high-water mark.
  const MIGRATE_INVOCATIONS = ['db:migrate', 'drizzle-kit migrate'];

  // The steps here are commented, and those comments name the very commands this
  // guard orders — "Must stay ahead of db:migrate" sits *above* the normalise
  // step. Ordering on the raw text would read that comment as the migrate step
  // and fail every correctly-wired job.
  function withoutComments(body: string): string {
    return body
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('#'))
      .join('\n');
  }

  it('normalize the ledger before applying migrations', () => {
    const jobsBootingTheImage = [...readWorkflowJobs()]
      .map(([id, body]) => [id, withoutComments(body)] as const)
      .filter(
        ([, body]) => body.includes('boardsesh-dev-db') && MIGRATE_INVOCATIONS.some((step) => body.includes(step)),
      );
    // If this drops to zero the sweep has stopped sweeping — most likely the job
    // key regex stopped matching after a workflow reformat.
    expect(jobsBootingTheImage.length).toBeGreaterThanOrEqual(3);

    const unrepaired = jobsBootingTheImage
      .filter(([id]) => id !== `${RENUMBER_EXEMPTION.workflow}#${RENUMBER_EXEMPTION.job}`)
      .filter(([, body]) => {
        const normalizeIndex = body.indexOf('db:normalize-ledger');
        const migrateIndex = Math.min(
          ...MIGRATE_INVOCATIONS.map((step) => body.indexOf(step)).filter((index) => index >= 0),
        );
        return normalizeIndex < 0 || normalizeIndex > migrateIndex;
      })
      .map(([id]) => id);
    expect(unrepaired).toEqual([]);
  });

  it('exempts only the renumber job, which writes its own fresh `when`', () => {
    // `scripts/db-renumber-migration.ts` stamps the migration it moves with
    // `nextWhen(maxWhen(mainJournal), Date.now())` — a value taken at workflow
    // run time, so it is always above the build clock of an image built earlier.
    // Nothing there can land under the mark, which is why this job alone needs no
    // repair. Change that script's `when` derivation and this exemption dies.
    const renumberSource = readFileSync('scripts/db-renumber-migration.ts', 'utf8');
    expect(renumberSource).toContain('nextWhen(maxWhen(mainJournal), Date.now())');
    expect(readWorkflowJobs().has(`${RENUMBER_EXEMPTION.workflow}#${RENUMBER_EXEMPTION.job}`)).toBe(true);
  });
});
