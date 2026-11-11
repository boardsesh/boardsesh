import { sql } from 'drizzle-orm';
import type { ConsolidationTransaction } from './executor';
import { ConsolidationError } from './planner';

/**
 * Strong operator-window guard: ordinary writer roles must be unable to open
 * connections, and their pre-existing sessions must have drained. Merely
 * stopping one service or passing a boolean cannot satisfy this check.
 * This function reads catalog state only; it never changes roles or sessions.
 */
export async function verifyPostgresMaintenanceFence(transaction: ConsolidationTransaction): Promise<void> {
  const [state] = await transaction.execute<{
    recovery: boolean;
    operator: boolean;
    unsafeRoles: number;
    unsafeConnections: number;
  }>(sql`
    WITH target_tables AS (
      SELECT oid FROM pg_catalog.pg_class WHERE relnamespace='public'::pg_catalog.regnamespace
        AND relkind IN ('r','p')
    ), capable_roles AS (
      SELECT login_role.oid,login_role.rolname,login_role.rolcanlogin
      FROM pg_catalog.pg_roles login_role
      WHERE login_role.rolname<>session_user AND (
        login_role.rolsuper OR login_role.rolcreaterole OR
        EXISTS(SELECT 1 FROM pg_catalog.pg_roles effective_role CROSS JOIN target_tables
          WHERE pg_catalog.pg_has_role(login_role.oid,effective_role.oid,'MEMBER')
          AND (pg_catalog.has_table_privilege(effective_role.oid,target_tables.oid,'INSERT,UPDATE,DELETE,TRUNCATE')
            OR pg_catalog.has_any_column_privilege(effective_role.oid,target_tables.oid,'INSERT,UPDATE'))) OR
        EXISTS(SELECT 1 FROM pg_catalog.pg_proc routine
          JOIN pg_catalog.pg_namespace namespace ON namespace.oid=routine.pronamespace
          WHERE routine.prosecdef AND namespace.nspname NOT IN ('pg_catalog','information_schema')
          AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_depend dependency
            WHERE dependency.classid='pg_catalog.pg_proc'::pg_catalog.regclass AND dependency.objid=routine.oid AND dependency.deptype='e')
          AND pg_catalog.has_function_privilege(login_role.oid,routine.oid,'EXECUTE'))
      )
    ) SELECT pg_catalog.pg_is_in_recovery() AS recovery,
      (session_user='boardsesh_consolidation_operator' AND current_user=session_user) AS operator,
      (SELECT count(*)::integer FROM capable_roles WHERE rolcanlogin) AS "unsafeRoles",
      (SELECT count(*)::integer FROM pg_catalog.pg_stat_activity activity
        WHERE activity.datname=pg_catalog.current_database() AND activity.pid<>pg_catalog.pg_backend_pid()
          AND activity.backend_type <> 'autovacuum worker'
        ) AS "unsafeConnections"`);
  if (!state || !state.operator || state.recovery || state.unsafeRoles !== 0 || state.unsafeConnections !== 0)
    throw new ConsolidationError('UNSAFE_PLAN');
}
