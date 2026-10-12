/// <reference types="node" />
import { readFile } from 'node:fs/promises';
import postgres from 'postgres';

const OWNER_ROLE = 'boardsesh_sync_cutoff_owner';
const runtimeRole = process.env.SYNC_CUTOFF_RUNTIME_ROLE ?? 'boardsesh_runtime';
if (!/^[a-z_][a-z0-9_]*$/.test(runtimeRole)) {
  throw new Error('SYNC_CUTOFF_RUNTIME_ROLE must be a simple PostgreSQL role name');
}
const functionSql = await readFile(new URL('./sync-deletions-cutoff-function.sql', import.meta.url), 'utf8');
const contractSql = (
  await readFile(new URL('./sync-deletions-cutoff-contract.sql', import.meta.url), 'utf8')
).replaceAll('__SYNC_RUNTIME_ROLE__', runtimeRole);

// No implicit DATABASE_URL: an administrator chooses the target explicitly.
if (!process.argv.includes('--apply')) {
  console.log(`Plan: install one timestamp-only helper owned by ${OWNER_ROLE}; grant EXECUTE to ${runtimeRole}.`);
  console.log('Apply with SYNC_CUTOFF_ADMIN_DATABASE_URL and --apply. No application tables are changed.');
} else {
  const adminUrl = process.env.SYNC_CUTOFF_ADMIN_DATABASE_URL;
  if (!adminUrl) throw new Error('SYNC_CUTOFF_ADMIN_DATABASE_URL is required with --apply');
  const admin = postgres(adminUrl, { max: 1, onnotice: () => {} });
  try {
    await admin.begin(async (transaction) => {
      const [privileges] = await transaction<{ admin: boolean; runtimeExists: boolean; version: number }[]>`
        SELECT (SELECT rolsuper FROM pg_catalog.pg_roles WHERE rolname = current_user) AS admin,
               EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = ${runtimeRole}) AS "runtimeExists",
               current_setting('server_version_num')::integer AS version
      `;
      if (!privileges.admin || !privileges.runtimeExists) {
        throw new Error('Bootstrap requires an administrator and an existing runtime role');
      }
      const [existingHelper] = await transaction<{ exists: boolean }[]>`
        SELECT pg_catalog.to_regprocedure('public.sync_deletions_safe_cutoff(double precision)') IS NOT NULL AS exists
      `;
      if (existingHelper.exists) {
        const [existingContract] = await transaction.unsafe<{ matches: boolean }[]>(contractSql);
        if (!existingContract.matches)
          throw new Error(
            'Existing cutoff helper has unsafe body, owner, membership, or ACL; inspect it before applying',
          );
        return;
      }
      const [existingOwner] = await transaction<{ safe: boolean }[]>`
        SELECT NOT rolcanlogin AND NOT rolsuper AND NOT rolcreatedb AND NOT rolcreaterole
               AND rolinherit AND NOT rolreplication AND NOT rolbypassrls AS safe
        FROM pg_catalog.pg_roles WHERE rolname = ${OWNER_ROLE}
      `;
      if (existingOwner && !existingOwner.safe) throw new Error('Existing cutoff owner has unsafe role attributes');
      if (!existingOwner) {
        await transaction.unsafe(
          `CREATE ROLE ${OWNER_ROLE} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT NOREPLICATION NOBYPASSRLS`,
        );
      }
      const [memberships] = await transaction<{ unsafe: boolean }[]>`
        SELECT EXISTS (
          SELECT 1 FROM pg_catalog.pg_auth_members AS membership
          JOIN pg_catalog.pg_roles AS granted ON granted.oid = membership.roleid
          JOIN pg_catalog.pg_roles AS member ON member.oid = membership.member
          WHERE granted.rolname = ${OWNER_ROLE}
             OR (member.rolname = ${OWNER_ROLE} AND granted.rolname <> 'pg_read_all_stats')
        ) AS unsafe
      `;
      if (memberships.unsafe) throw new Error('Cutoff owner must have no login/owner-role membership edges');
      await transaction.unsafe(
        privileges.version >= 160000
          ? `GRANT pg_read_all_stats TO ${OWNER_ROLE} WITH ADMIN FALSE, INHERIT TRUE, SET FALSE`
          : `GRANT pg_read_all_stats TO ${OWNER_ROLE}`,
      );
      await transaction.unsafe(functionSql);
      await transaction.unsafe(
        `ALTER FUNCTION public.sync_deletions_safe_cutoff(double precision) OWNER TO ${OWNER_ROLE}`,
      );
      await transaction.unsafe(
        `GRANT EXECUTE ON FUNCTION public.sync_deletions_safe_cutoff(double precision) TO "${runtimeRole}"`,
      );
      const [runtimeAccess] = await transaction<{ hasStats: boolean }[]>`
        SELECT pg_catalog.pg_has_role(${runtimeRole}, 'pg_read_all_stats', 'USAGE') AS "hasStats"
      `;
      if (runtimeAccess.hasStats) throw new Error('Runtime role must not inherit pg_read_all_stats');
      const [installedContract] = await transaction.unsafe<{ matches: boolean }[]>(contractSql);
      if (!installedContract.matches)
        throw new Error('Installed cutoff helper does not satisfy its exact privilege contract');
    });
    console.log('Installed the cutoff helper; runtime has EXECUTE without activity visibility.');
  } finally {
    await admin.end();
  }
}
