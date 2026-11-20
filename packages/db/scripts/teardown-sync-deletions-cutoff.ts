/// <reference types="node" />
import { readFile } from 'node:fs/promises';
import postgres from 'postgres';

// Removes what bootstrap-sync-deletions-cutoff.ts installed: the
// sync_deletions_safe_cutoff helper and its NOLOGIN owner role. Run it only
// after migrations 0274 and 0275 have dropped every object that used them
// (docs/data/sync-deletions-cutoff.md).
//
// Plan by default. With SYNC_CUTOFF_ADMIN_DATABASE_URL set, the plan inspects
// that database in a read-only transaction and prints what --apply would do.
// --apply needs a superuser URL and runs everything in one transaction: any
// refusal rolls back before a single object is dropped. DATABASE_URL is never
// read, so an administrator always names the target.
//
// Fresh databases still replay 0272, which needs the helper, so the bootstrap
// and its development adapter stay. This script is for a database that has
// already applied the cleanup migrations.

const OWNER_ROLE = 'boardsesh_sync_cutoff_owner';
const HELPER = 'public.sync_deletions_safe_cutoff(double precision)';
// md5(prosrc) of the reviewed helper body, the value 0272 and the contract pin.
const HELPER_BODY_MD5 = '7485e158858f85717c5c7a83ee259fa7';

const adminUrl = process.env.SYNC_CUTOFF_ADMIN_DATABASE_URL || undefined;
const runtimeRole = process.env.SYNC_CUTOFF_RUNTIME_ROLE ?? 'boardsesh_runtime';
if (!/^[a-z_][a-z0-9_]*$/.test(runtimeRole)) {
  throw new Error('SYNC_CUTOFF_RUNTIME_ROLE must be a simple PostgreSQL role name');
}
const contractSql = (
  await readFile(new URL('./sync-deletions-cutoff-contract.sql', import.meta.url), 'utf8')
).replaceAll('__SYNC_RUNTIME_ROLE__', runtimeRole);

type Inspection = {
  helperOid: number | null;
  ownerOid: number | null;
  blockers: string[];
};

async function inspect(transaction: postgres.TransactionSql): Promise<Inspection> {
  const blockers: string[] = [];

  const [cleanup] = await transaction<{ columns: boolean; triggers: boolean; functions: boolean }[]>`
    SELECT
      EXISTS (
        SELECT 1 FROM pg_catalog.pg_attribute
        WHERE attrelid = pg_catalog.to_regclass('public.sync_deletions')
          AND attname IN ('stream_at', 'is_membership_withdrawal') AND NOT attisdropped
      ) AS columns,
      EXISTS (
        SELECT 1 FROM pg_catalog.pg_trigger
        WHERE tgname IN ('trg_sync_deletion_stream_at', 'trg_board_climbs_reference_membership')
          AND NOT tgisinternal
      ) AS triggers,
      pg_catalog.to_regprocedure('public.stamp_sync_deletion_stream_at()') IS NOT NULL
        OR pg_catalog.to_regprocedure('public.sync_board_climb_reference_membership()') IS NOT NULL AS functions
  `;
  if (cleanup.columns || cleanup.triggers || cleanup.functions) {
    // The migration ACL preflight accepts a missing helper only once stream_at
    // is gone, so removing it first would fail the next production migrate.
    blockers.push('migrations 0274/0275 have not run here: #6339 stream objects still exist');
  }

  const [ids] = await transaction<{ helperOid: number | null; ownerOid: number | null }[]>`
    SELECT pg_catalog.to_regprocedure(${HELPER})::oid AS "helperOid",
           (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = ${OWNER_ROLE}) AS "ownerOid"
  `;
  const { helperOid, ownerOid } = ids;

  if (helperOid !== null) {
    const [helper] = await transaction<{ ownedByCutoffOwner: boolean; canonicalBody: boolean }[]>`
      SELECT helper.proowner IS NOT DISTINCT FROM ${ownerOid}::oid AS "ownedByCutoffOwner",
             pg_catalog.md5(helper.prosrc) = ${HELPER_BODY_MD5} AS "canonicalBody"
      FROM pg_catalog.pg_proc AS helper WHERE helper.oid = ${helperOid}
    `;
    if (!helper.ownedByCutoffOwner || !helper.canonicalBody) {
      blockers.push(`${HELPER} is not the reviewed helper owned by ${OWNER_ROLE}; inspect it by hand`);
    }
    const dependants = await transaction<{ dependant: string }[]>`
      SELECT pg_catalog.pg_describe_object(classid, objid, objsubid) AS dependant
      FROM pg_catalog.pg_depend
      WHERE refclassid = 'pg_catalog.pg_proc'::pg_catalog.regclass AND refobjid = ${helperOid}
    `;
    // plpgsql bodies record no dependency, so look for callers by name too.
    const callers = await transaction<{ dependant: string }[]>`
      SELECT procedure.oid::pg_catalog.regprocedure::text AS dependant
      FROM pg_catalog.pg_proc AS procedure
      WHERE procedure.oid <> ${helperOid} AND procedure.prosrc LIKE '%sync_deletions_safe_cutoff%'
    `;
    for (const { dependant } of [...dependants, ...callers]) blockers.push(`${HELPER} is used by ${dependant}`);
  }

  if (ownerOid !== null) {
    // Every database's owned objects and privileges, except the helper itself.
    const ownerships = await transaction<{ dependant: string }[]>`
      SELECT coalesce(database.datname, '(cluster)') || ': ' ||
             CASE WHEN dependency.dbid = (SELECT oid FROM pg_catalog.pg_database WHERE datname = pg_catalog.current_database())
                  THEN pg_catalog.pg_describe_object(dependency.classid, dependency.objid, dependency.objsubid)
                  ELSE dependency.classid::pg_catalog.regclass::text || ' ' || dependency.objid::text
             END || ' (' || dependency.deptype::text || ')' AS dependant
      FROM pg_catalog.pg_shdepend AS dependency
      LEFT JOIN pg_catalog.pg_database AS database ON database.oid = dependency.dbid
      WHERE dependency.refclassid = 'pg_catalog.pg_authid'::pg_catalog.regclass
        AND dependency.refobjid = ${ownerOid}
        AND NOT (
          dependency.classid = 'pg_catalog.pg_proc'::pg_catalog.regclass
          AND dependency.objid = ${helperOid ?? 0}::oid
          AND dependency.dbid = (SELECT oid FROM pg_catalog.pg_database WHERE datname = pg_catalog.current_database())
        )
    `;
    for (const { dependant } of ownerships) blockers.push(`${OWNER_ROLE} still owns or holds ${dependant}`);

    const memberships = await transaction<{ granted: string; member: string }[]>`
      SELECT granted.rolname AS granted, member.rolname AS member
      FROM pg_catalog.pg_auth_members AS membership
      JOIN pg_catalog.pg_roles AS granted ON granted.oid = membership.roleid
      JOIN pg_catalog.pg_roles AS member ON member.oid = membership.member
      WHERE membership.roleid = ${ownerOid}
         OR (membership.member = ${ownerOid} AND granted.rolname <> 'pg_read_all_stats')
    `;
    for (const { granted, member } of memberships) blockers.push(`role membership ${member} -> ${granted}`);
  }

  return { helperOid, ownerOid, blockers };
}

function describePlan({ helperOid, ownerOid }: Inspection): string[] {
  const steps: string[] = [];
  if (helperOid !== null) steps.push(`DROP FUNCTION ${HELPER}`);
  if (ownerOid !== null) {
    steps.push(`REVOKE pg_read_all_stats FROM ${OWNER_ROLE}`, `DROP ROLE ${OWNER_ROLE}`);
  }
  return steps;
}

if (!adminUrl) {
  if (process.argv.includes('--apply')) throw new Error('SYNC_CUTOFF_ADMIN_DATABASE_URL is required with --apply');
  console.log(`Plan: drop ${HELPER}, revoke pg_read_all_stats from ${OWNER_ROLE}, then drop ${OWNER_ROLE}.`);
  console.log('Set SYNC_CUTOFF_ADMIN_DATABASE_URL to inspect a database; add --apply to remove them.');
} else {
  const apply = process.argv.includes('--apply');
  const admin = postgres(adminUrl, { max: 1, onnotice: () => {} });
  try {
    const outcome = await admin.begin(apply ? 'read write' : 'read only', async (transaction) => {
      const inspection = await inspect(transaction);
      const steps = describePlan(inspection);
      if (inspection.blockers.length > 0) {
        throw new Error(`Refusing to remove the cutoff helper:\n  - ${inspection.blockers.join('\n  - ')}`);
      }
      if (steps.length === 0) return { steps, applied: false };
      if (!apply) return { steps, applied: false };

      const [privileges] = await transaction<{ superuser: boolean }[]>`
        SELECT rolsuper AS superuser FROM pg_catalog.pg_roles WHERE rolname = current_user
      `;
      if (!privileges.superuser) throw new Error('Teardown requires a superuser, like the bootstrap');

      if (inspection.helperOid !== null) await transaction.unsafe(`DROP FUNCTION ${HELPER}`);
      if (inspection.ownerOid !== null) {
        await transaction.unsafe(`REVOKE pg_read_all_stats FROM ${OWNER_ROLE}`);
        await transaction.unsafe(`DROP ROLE ${OWNER_ROLE}`);
      }

      // The contract the migration ACL preflight runs: with no helper it
      // passes only when stream_at is gone too.
      const [contract] = await transaction.unsafe<{ matches: boolean }[]>(contractSql);
      if (!contract.matches) throw new Error('Cutoff contract does not hold after teardown; rolled back');
      return { steps, applied: true };
    });
    if (outcome.steps.length === 0) {
      console.log('Nothing to remove: the cutoff helper and its owner role are already gone.');
    } else if (outcome.applied) {
      console.log(`Removed:\n  ${outcome.steps.join('\n  ')}`);
    } else {
      console.log(`Plan (no blockers found):\n  ${outcome.steps.join('\n  ')}\nRe-run with --apply to remove them.`);
    }
  } finally {
    await admin.end();
  }
}
