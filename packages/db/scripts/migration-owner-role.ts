import type postgres from 'postgres';

const SIMPLE_POSTGRES_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

export interface MigrationOwnerContract {
  databaseName: string;
  loginRole: string;
  ownerRole: string;
  snapshotFenceOwnerRole?: string;
  subscriberRole?: string;
  subscriptionName?: string;
}

export interface MigrationOwnerSession {
  client: postgres.ReservedSql;
  close: () => Promise<void>;
}

export interface MigrationExecutionContract {
  owner: MigrationOwnerContract;
  runtimeRole: string;
  runtimeSchemas: string[];
}

type ReservedTransactionCallback = (transactionClient: postgres.TransactionSql) => Promise<unknown>;

/**
 * postgres-js 3.x declares `options` and `begin` on ReservedSql, but its runtime
 * reserve() object exposes neither. Drizzle needs both. Install the missing
 * pieces on the reserved connection itself so SET ROLE, DDL, the Drizzle
 * transaction, and the ledger write cannot escape to another pool checkout.
 */
function makeReservedClientDrizzleCompatible(connectionPool: postgres.Sql, client: postgres.ReservedSql): void {
  if (!Object.hasOwn(client, 'options')) {
    Object.defineProperty(client, 'options', {
      configurable: true,
      value: connectionPool.options,
    });
  }
  if (!Object.hasOwn(client, 'parameters')) {
    Object.defineProperty(client, 'parameters', {
      configurable: true,
      get: () => connectionPool.parameters,
    });
  }
  if (typeof client.begin === 'function') {
    return;
  }

  const begin = async (
    optionsOrCallback: string | ReservedTransactionCallback,
    optionalCallback?: ReservedTransactionCallback,
  ): Promise<unknown> => {
    const transactionOptions = typeof optionsOrCallback === 'string' ? optionsOrCallback : '';
    const callback = typeof optionsOrCallback === 'function' ? optionsOrCallback : optionalCallback;
    if (!callback) {
      throw new Error('reserved transaction callback is required');
    }
    if (!/^[A-Za-z ]*$/.test(transactionOptions)) {
      throw new Error('reserved transaction options contain unsupported characters');
    }

    await client.unsafe(`BEGIN ${transactionOptions}`.trimEnd());
    try {
      const result = await callback(client as unknown as postgres.TransactionSql);
      await client.unsafe('COMMIT');
      return result;
    } catch (error) {
      await client.unsafe('ROLLBACK').catch(() => {});
      throw error;
    }
  };
  Object.defineProperty(client, 'begin', { configurable: true, value: begin });
}

/**
 * Build the only dynamic statement used to enter the NOLOGIN application owner.
 * PostgreSQL cannot parameterize an identifier, so reject everything outside
 * the deliberately narrow role-name contract before quoting it.
 */
export function migrationOwnerRoleStatement(roleName: string): string {
  if (!SIMPLE_POSTGRES_IDENTIFIER.test(roleName)) {
    throw new Error('MIGRATION_OWNER_ROLE must be a simple PostgreSQL identifier');
  }
  return `SET ROLE "${roleName}"`;
}

/**
 * Read the production migration role contract as one atomic environment
 * boundary. The optional subscriber allowance is meaningful only while the
 * full owner/runtime contract is active; accepting it in the local fallback
 * path would silently skip every catalog check below.
 */
export function migrationExecutionContractFromEnvironment(
  environment: Readonly<Record<string, string | undefined>>,
): MigrationExecutionContract | undefined {
  const ownerRole = environment.MIGRATION_OWNER_ROLE;
  const loginRole = environment.MIGRATION_LOGIN_ROLE;
  const databaseName = environment.EXPECTED_MIGRATION_DATABASE;
  const runtimeRole = environment.MIGRATION_RUNTIME_ROLE;
  const runtimeSchemas = environment.MIGRATION_RUNTIME_SCHEMAS;
  const subscriberRole = environment.MIGRATION_SUBSCRIBER_ROLE;
  const subscriptionName = environment.MIGRATION_SUBSCRIPTION_NAME;
  const coreValues = [ownerRole, loginRole, databaseName, runtimeRole, runtimeSchemas];

  if (Boolean(subscriberRole) !== Boolean(subscriptionName)) {
    throw new Error('MIGRATION_SUBSCRIBER_ROLE and MIGRATION_SUBSCRIPTION_NAME must be set together');
  }
  if (coreValues.some(Boolean) && !coreValues.every(Boolean)) {
    throw new Error(
      'MIGRATION_OWNER_ROLE, MIGRATION_LOGIN_ROLE, EXPECTED_MIGRATION_DATABASE, MIGRATION_RUNTIME_ROLE, and MIGRATION_RUNTIME_SCHEMAS must be set together',
    );
  }
  if (subscriberRole && !ownerRole) {
    throw new Error(
      'MIGRATION_SUBSCRIBER_ROLE and MIGRATION_SUBSCRIPTION_NAME require the full migration owner contract',
    );
  }
  if (!ownerRole) {
    return undefined;
  }
  const parsedRuntimeSchemas = runtimeSchemas!.split(/\s+/).filter(Boolean);
  if (!SIMPLE_POSTGRES_IDENTIFIER.test(runtimeRole!)) {
    throw new Error('MIGRATION_RUNTIME_ROLE must be a simple PostgreSQL identifier');
  }
  if (parsedRuntimeSchemas.length === 0) {
    throw new Error('MIGRATION_RUNTIME_SCHEMAS must list at least one schema');
  }
  if (parsedRuntimeSchemas.some((schema) => !SIMPLE_POSTGRES_IDENTIFIER.test(schema))) {
    throw new Error('MIGRATION_RUNTIME_SCHEMAS must contain only simple PostgreSQL identifiers');
  }
  if (new Set(parsedRuntimeSchemas).size !== parsedRuntimeSchemas.length) {
    throw new Error('MIGRATION_RUNTIME_SCHEMAS must not contain duplicates');
  }

  return {
    owner: {
      databaseName: databaseName!,
      loginRole: loginRole!,
      ownerRole,
      subscriberRole,
      subscriptionName,
    },
    runtimeRole: runtimeRole!,
    runtimeSchemas: parsedRuntimeSchemas,
  };
}

export async function reserveMigrationOwnerSession(
  connectionPool: postgres.Sql,
  contract: MigrationOwnerContract,
): Promise<MigrationOwnerSession> {
  const setRoleStatement = migrationOwnerRoleStatement(contract.ownerRole);
  migrationOwnerRoleStatement(contract.loginRole);
  const snapshotFenceOwnerRole = contract.snapshotFenceOwnerRole ?? 'boardsesh_snapshot_fence_owner';
  migrationOwnerRoleStatement(snapshotFenceOwnerRole);
  const subscriberRole = contract.subscriberRole ?? '';
  const subscriptionName = contract.subscriptionName ?? '';
  const subscriberExpected = subscriberRole !== '';
  if (subscriberExpected !== (subscriptionName !== '')) {
    throw new Error('subscriberRole and subscriptionName must be set together');
  }
  if (subscriberExpected) {
    migrationOwnerRoleStatement(subscriberRole);
    migrationOwnerRoleStatement(subscriptionName);
  }
  if (!SIMPLE_POSTGRES_IDENTIFIER.test(contract.databaseName)) {
    throw new Error('EXPECTED_MIGRATION_DATABASE must be a simple PostgreSQL identifier');
  }

  const client = await connectionPool.reserve();
  makeReservedClientDrizzleCompatible(connectionPool, client);
  let roleWasSet = false;
  try {
    const [catalogContract] = await client<
      {
        databaseName: string;
        fenceAclBoundaryMatches: boolean;
        fenceHasNoDatabaseCreate: boolean;
        fenceHasNoSchemaCreateOutsideOps: boolean;
        fenceDatabaseAclBoundaryMatches: boolean;
        fenceControlAclMatches: boolean;
        fenceIncomingMembershipMatches: boolean;
        fenceObjectOwnershipMatches: boolean;
        fenceOutgoingMembershipMatches: boolean;
        fenceOwnedFunctionsMatch: boolean;
        fenceRoleMatches: boolean;
        fenceSchemaAclBoundaryMatches: boolean;
        fenceTypeAndRelationAclBoundaryMatches: boolean;
        loginDoesNotOwnDatabase: boolean;
        loginHasNoDatabaseCreate: boolean;
        loginHasNoIncomingMemberships: boolean;
        loginHasNoOwnership: boolean;
        loginHasNoSchemaCreate: boolean;
        loginMembershipCount: number;
        loginRole: string;
        loginRoleMatches: boolean;
        ownerDoesNotOwnDatabase: boolean;
        ownerIncomingMembershipsMatch: boolean;
        ownerCreateGrantMatches: boolean;
        ownerMembershipMatches: boolean;
        ownerRoleMatches: boolean;
        setEdgeMatches: boolean;
        subscriberContractMatches: boolean;
      }[]
    >`
      WITH login_role AS (
        SELECT * FROM pg_catalog.pg_roles WHERE rolname = ${contract.loginRole}
      ), owner_role AS (
        SELECT * FROM pg_catalog.pg_roles WHERE rolname = ${contract.ownerRole}
      ), fence_owner AS (
        SELECT * FROM pg_catalog.pg_roles WHERE rolname = ${snapshotFenceOwnerRole}
      ), subscriber_role AS (
        SELECT * FROM pg_catalog.pg_roles WHERE rolname = ${subscriberRole}
      ), stats_role AS (
        SELECT oid FROM pg_catalog.pg_roles WHERE rolname = 'pg_read_all_stats'
      ), create_subscription_role AS (
        SELECT oid FROM pg_catalog.pg_roles WHERE rolname = 'pg_create_subscription'
      ), allowed_fence_functions(function_oid) AS (
        VALUES
          ('pg_catalog.pg_control_system()'::pg_catalog.regprocedure),
          ('pg_catalog.pg_control_checkpoint()'::pg_catalog.regprocedure)
        UNION ALL
        SELECT procedure.oid
        FROM pg_catalog.pg_proc AS procedure
        JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = procedure.pronamespace
        WHERE namespace.nspname = 'ops'
          AND procedure.prokind = 'f'
          AND (
            (procedure.proname = 'board_snapshot_cluster_identity'
             AND pg_catalog.oidvectortypes(procedure.proargtypes) = '')
            OR
            (procedure.proname = 'acquire_board_snapshot_fence'
             AND pg_catalog.oidvectortypes(procedure.proargtypes) = 'integer')
          )
      )
      SELECT current_database() AS "databaseName",
             current_user AS "loginRole",
             EXISTS (
               SELECT 1 FROM login_role
               WHERE rolname = current_user
                 AND rolcanlogin AND NOT rolsuper AND NOT rolcreatedb
                 AND NOT rolcreaterole AND rolinherit AND NOT rolreplication
                 AND NOT rolbypassrls
             ) AS "loginRoleMatches",
             NOT EXISTS (
               SELECT 1 FROM pg_catalog.pg_database AS database, login_role
               WHERE database.datdba = login_role.oid
             ) AS "loginDoesNotOwnDatabase",
             NOT pg_catalog.has_database_privilege(
               (SELECT oid FROM login_role), current_database(), 'CREATE'
             ) AS "loginHasNoDatabaseCreate",
             NOT EXISTS (
               SELECT 1
               FROM pg_catalog.pg_namespace AS namespace, login_role
               WHERE namespace.nspname <> 'information_schema'
                 AND namespace.nspname !~ '^pg_'
                 AND pg_catalog.has_schema_privilege(login_role.oid, namespace.oid, 'CREATE')
             ) AS "loginHasNoSchemaCreate",
             EXISTS (
               SELECT 1 FROM owner_role
               WHERE NOT rolcanlogin AND NOT rolsuper AND NOT rolcreatedb
                 AND NOT rolcreaterole AND rolinherit AND NOT rolreplication
                 AND NOT rolbypassrls
             ) AS "ownerRoleMatches",
             NOT EXISTS (
               SELECT 1 FROM pg_catalog.pg_database AS database, owner_role
               WHERE database.datdba = owner_role.oid
             ) AS "ownerDoesNotOwnDatabase",
             (
               SELECT count(*) = 1
               FROM pg_catalog.pg_auth_members AS membership
               CROSS JOIN login_role
               CROSS JOIN owner_role
               WHERE membership.member = login_role.oid
                 AND membership.roleid = owner_role.oid
                 AND NOT membership.admin_option
                 AND NOT membership.inherit_option
                 AND membership.set_option
             ) AS "setEdgeMatches",
             (
               SELECT count(*)::integer FROM pg_catalog.pg_auth_members AS membership
               CROSS JOIN login_role
               WHERE membership.member = login_role.oid
             ) AS "loginMembershipCount",
             NOT EXISTS (
               SELECT 1 FROM pg_catalog.pg_auth_members AS membership, login_role
               WHERE membership.roleid = login_role.oid
             ) AS "loginHasNoIncomingMemberships",
             NOT EXISTS (
               SELECT 1
               FROM pg_catalog.pg_shdepend AS dependency, login_role
               WHERE dependency.refclassid = 'pg_catalog.pg_authid'::pg_catalog.regclass
                 AND dependency.refobjid = login_role.oid
                 AND dependency.deptype = 'o'
             ) AS "loginHasNoOwnership",
             (
               SELECT count(*) = 1
                 AND pg_catalog.bool_and(
                   privilege.privilege_type = 'CREATE'
                   AND NOT privilege.is_grantable
                 )
               FROM pg_catalog.pg_database AS database
               CROSS JOIN owner_role
               CROSS JOIN LATERAL pg_catalog.aclexplode(database.datacl) AS privilege
               WHERE database.datname = current_database()
                 AND privilege.grantee = owner_role.oid
             ) AS "ownerCreateGrantMatches",
             (
               SELECT count(*) = 1
                 AND pg_catalog.bool_and(
                   granted_role.rolname = ${snapshotFenceOwnerRole}
                   AND NOT membership.admin_option
                   AND NOT membership.inherit_option
                   AND membership.set_option
                 )
               FROM pg_catalog.pg_auth_members AS membership
               JOIN owner_role ON membership.member = owner_role.oid
               JOIN pg_catalog.pg_roles AS granted_role ON granted_role.oid = membership.roleid
             ) AS "ownerMembershipMatches"
             ,(
               SELECT count(*) = CASE WHEN ${subscriberExpected} THEN 2 ELSE 1 END
                      AND count(*) FILTER (
                        WHERE member_role.rolname = ${contract.loginRole}
                          AND NOT membership.admin_option
                          AND NOT membership.inherit_option
                          AND membership.set_option
                      ) = 1
                      AND count(*) FILTER (
                        WHERE ${subscriberExpected}
                          AND member_role.rolname = ${subscriberRole}
                          AND NOT membership.admin_option
                          AND NOT membership.inherit_option
                          AND membership.set_option
                      ) = CASE WHEN ${subscriberExpected} THEN 1 ELSE 0 END
                      AND coalesce(pg_catalog.bool_and(
                        NOT membership.admin_option
                        AND NOT membership.inherit_option
                        AND membership.set_option
                        AND (
                          member_role.rolname = ${contract.loginRole}
                          OR (${subscriberExpected} AND member_role.rolname = ${subscriberRole})
                        )
                      ), false)
               FROM pg_catalog.pg_auth_members AS membership
               JOIN owner_role ON owner_role.oid = membership.roleid
               JOIN pg_catalog.pg_roles AS member_role ON member_role.oid = membership.member
             ) AS "ownerIncomingMembershipsMatch",
             -- This reserved-session guard authorizes only the temporary role
             -- edge and one enabled, named subscription owned by it. The
            -- operator audit remains the authority for password absence,
            -- publication, slot, options, and canonical password-redacted
            -- conninfo. PostgreSQL deliberately masks every pg_roles password
            -- as ******** from this restricted migration login.
             NOT ${subscriberExpected} OR (
               EXISTS (
                 SELECT 1 FROM subscriber_role
                 WHERE rolcanlogin AND NOT rolsuper AND NOT rolcreatedb
                   AND NOT rolcreaterole AND rolinherit AND NOT rolreplication
                   AND NOT rolbypassrls
               )
               AND (
                 SELECT count(*) = 2 AND coalesce(pg_catalog.bool_and(
                          (
                            granted_role.rolname = ${contract.ownerRole}
                            AND NOT membership.admin_option
                            AND NOT membership.inherit_option
                            AND membership.set_option
                          ) OR (
                            granted_role.rolname = 'pg_create_subscription'
                            AND NOT membership.admin_option
                            AND membership.inherit_option
                            AND NOT membership.set_option
                          )
                        ), false)
                 FROM pg_catalog.pg_auth_members AS membership
                 CROSS JOIN subscriber_role
                 JOIN pg_catalog.pg_roles AS granted_role ON granted_role.oid = membership.roleid
                 WHERE membership.member = subscriber_role.oid
               )
               AND NOT EXISTS (
                 SELECT 1 FROM pg_catalog.pg_auth_members AS membership, subscriber_role
                 WHERE membership.roleid = subscriber_role.oid
               )
               AND (
                 SELECT count(*) = 1 AND coalesce(pg_catalog.bool_and(
                          privilege.privilege_type = 'CREATE'
                          AND NOT privilege.is_grantable
                        ), false)
                 FROM pg_catalog.pg_database AS database
                 CROSS JOIN subscriber_role
                 CROSS JOIN LATERAL pg_catalog.aclexplode(database.datacl) AS privilege
                 WHERE database.datname = current_database()
                   AND privilege.grantee = subscriber_role.oid
               )
               AND NOT EXISTS (
                 SELECT 1 FROM pg_catalog.pg_database AS database, subscriber_role
                 WHERE database.datdba = subscriber_role.oid
               )
               AND NOT EXISTS (
                 SELECT 1 FROM pg_catalog.pg_namespace AS namespace, subscriber_role
                 WHERE namespace.nspname <> 'information_schema'
                   AND namespace.nspname !~ '^pg_'
                   AND pg_catalog.has_schema_privilege(subscriber_role.oid, namespace.oid, 'CREATE')
               )
               AND NOT EXISTS (
                 SELECT 1
                 FROM pg_catalog.pg_class AS relation
                 JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
                 CROSS JOIN subscriber_role
                 WHERE relation.relkind IN ('r', 'p', 'v', 'm', 'S')
                   AND namespace.nspname <> 'information_schema'
                   AND namespace.nspname !~ '^pg_'
                   AND (
                     pg_catalog.has_table_privilege(subscriber_role.oid, relation.oid, 'INSERT')
                     OR pg_catalog.has_table_privilege(subscriber_role.oid, relation.oid, 'UPDATE')
                     OR pg_catalog.has_table_privilege(subscriber_role.oid, relation.oid, 'DELETE')
                     OR pg_catalog.has_table_privilege(subscriber_role.oid, relation.oid, 'TRUNCATE')
                     OR pg_catalog.has_table_privilege(subscriber_role.oid, relation.oid, 'REFERENCES')
                     OR pg_catalog.has_table_privilege(subscriber_role.oid, relation.oid, 'TRIGGER')
                   )
               )
               AND (
                 SELECT count(*) = 1 AND coalesce(pg_catalog.bool_and(
                          subscription.subname = ${subscriptionName}
                          AND subscription.subenabled
                        ), false)
                 FROM pg_catalog.pg_subscription AS subscription, subscriber_role
                 WHERE subscription.subowner = subscriber_role.oid
               )
               AND NOT EXISTS (
                 SELECT 1
                 FROM subscriber_role
                 JOIN pg_catalog.pg_shdepend AS dependency
                   ON dependency.refclassid = 'pg_catalog.pg_authid'::pg_catalog.regclass
                  AND dependency.refobjid = subscriber_role.oid
                  AND dependency.deptype = 'o'
                 WHERE NOT (
                   dependency.classid = 'pg_catalog.pg_subscription'::pg_catalog.regclass
                   AND EXISTS (
                     SELECT 1 FROM pg_catalog.pg_subscription AS subscription
                     WHERE subscription.oid = dependency.objid
                       AND subscription.subname = ${subscriptionName}
                       AND subscription.subowner = subscriber_role.oid
                       AND subscription.subenabled
                   )
                 )
               )
             ) AS "subscriberContractMatches",
             EXISTS (
               SELECT 1 FROM fence_owner
               WHERE NOT rolcanlogin AND NOT rolsuper AND NOT rolcreatedb
                 AND NOT rolcreaterole AND rolinherit AND NOT rolreplication
                 AND NOT rolbypassrls
             ) AS "fenceRoleMatches",
             (
               SELECT count(*) = 1 AND pg_catalog.bool_and(
                        membership.roleid = stats_role.oid
                        AND NOT membership.admin_option
                        AND membership.inherit_option
                        AND NOT membership.set_option
                      )
               FROM pg_catalog.pg_auth_members AS membership, fence_owner, stats_role
               WHERE membership.member = fence_owner.oid
             ) AS "fenceOutgoingMembershipMatches",
             (
               SELECT count(*) = 1 AND pg_catalog.bool_and(
                        membership.member = owner_role.oid
                        AND NOT membership.admin_option
                        AND NOT membership.inherit_option
                        AND membership.set_option
                      )
               FROM pg_catalog.pg_auth_members AS membership, fence_owner, owner_role
               WHERE membership.roleid = fence_owner.oid
             ) AS "fenceIncomingMembershipMatches",
             (
               SELECT count(*) = (
                        SELECT count(*) FROM allowed_fence_functions WHERE function_oid IS NOT NULL
                      ) AND pg_catalog.bool_and(
                        per_function.direct_execute_count = 1
                        AND per_function.non_grantable_execute_count = 1
                        AND per_function.public_execute_count = 0
                      )
               FROM (
                 SELECT allowed.function_oid,
                        count(*) FILTER (
                          WHERE privilege.grantee = fence_owner.oid
                            AND privilege.privilege_type = 'EXECUTE'
                        ) AS direct_execute_count,
                        count(*) FILTER (
                          WHERE privilege.grantee = fence_owner.oid
                            AND privilege.privilege_type = 'EXECUTE'
                            AND NOT privilege.is_grantable
                        ) AS non_grantable_execute_count,
                        count(*) FILTER (
                          WHERE privilege.grantee = 0
                            AND privilege.privilege_type = 'EXECUTE'
                        ) AS public_execute_count
                 FROM allowed_fence_functions AS allowed
                 JOIN pg_catalog.pg_proc AS procedure ON procedure.oid = allowed.function_oid
                 CROSS JOIN fence_owner
                 LEFT JOIN LATERAL pg_catalog.aclexplode(
                   coalesce(procedure.proacl, pg_catalog.acldefault('f', procedure.proowner))
                 ) AS privilege ON true
                 GROUP BY allowed.function_oid
               ) AS per_function
             ) AS "fenceControlAclMatches",
             NOT EXISTS (
               SELECT 1
               FROM fence_owner
               CROSS JOIN pg_catalog.pg_proc AS procedure
               CROSS JOIN LATERAL pg_catalog.aclexplode(procedure.proacl) AS privilege
               WHERE privilege.grantee = fence_owner.oid
                 AND privilege.privilege_type = 'EXECUTE'
                 AND NOT EXISTS (
                   SELECT 1 FROM allowed_fence_functions AS allowed
                   WHERE allowed.function_oid = procedure.oid
                 )
             ) AS "fenceAclBoundaryMatches",
             NOT pg_catalog.has_database_privilege(
               (SELECT oid FROM fence_owner), current_database(), 'CREATE'
             ) AS "fenceHasNoDatabaseCreate",
             NOT EXISTS (
               SELECT 1
               FROM pg_catalog.pg_namespace AS namespace, fence_owner
               WHERE namespace.nspname <> 'ops'
                 AND namespace.nspname <> 'information_schema'
                 AND namespace.nspname !~ '^pg_'
                 AND pg_catalog.has_schema_privilege(fence_owner.oid, namespace.oid, 'CREATE')
             ) AS "fenceHasNoSchemaCreateOutsideOps",
             NOT EXISTS (
               SELECT 1
               FROM pg_catalog.pg_database AS database
               CROSS JOIN fence_owner
               CROSS JOIN LATERAL pg_catalog.aclexplode(database.datacl) AS privilege
               WHERE privilege.grantee = fence_owner.oid
             ) AS "fenceDatabaseAclBoundaryMatches",
             NOT EXISTS (
               SELECT 1
               FROM pg_catalog.pg_namespace AS namespace
               CROSS JOIN fence_owner
               CROSS JOIN LATERAL pg_catalog.aclexplode(namespace.nspacl) AS privilege
               WHERE privilege.grantee = fence_owner.oid
                 AND NOT (
                   namespace.nspname = 'ops'
                   AND privilege.privilege_type IN ('USAGE', 'CREATE')
                   AND NOT privilege.is_grantable
                 )
             )
             AND (
               SELECT count(*) = CASE
                        WHEN pg_catalog.to_regnamespace('ops') IS NULL THEN 0 ELSE 2
                      END
                      AND coalesce(pg_catalog.bool_and(
                        privilege.privilege_type IN ('USAGE', 'CREATE')
                        AND NOT privilege.is_grantable
                      ), true)
               FROM pg_catalog.pg_namespace AS namespace
               CROSS JOIN fence_owner
               CROSS JOIN LATERAL pg_catalog.aclexplode(namespace.nspacl) AS privilege
               WHERE namespace.nspname = 'ops'
                 AND privilege.grantee = fence_owner.oid
             ) AS "fenceSchemaAclBoundaryMatches",
             NOT EXISTS (
               SELECT 1
               FROM fence_owner
               JOIN pg_catalog.pg_shdepend AS dependency
                 ON dependency.refclassid = 'pg_catalog.pg_authid'::pg_catalog.regclass
                AND dependency.refobjid = fence_owner.oid
                AND dependency.deptype = 'o'
               WHERE NOT (
                 dependency.classid = 'pg_catalog.pg_proc'::pg_catalog.regclass
                 AND dependency.objid IN (
                   SELECT allowed.function_oid
                   FROM allowed_fence_functions AS allowed
                   WHERE allowed.function_oid NOT IN (
                     'pg_catalog.pg_control_system()'::pg_catalog.regprocedure,
                     'pg_catalog.pg_control_checkpoint()'::pg_catalog.regprocedure
                   )
                 )
               )
             ) AS "fenceObjectOwnershipMatches",
             NOT EXISTS (
               SELECT 1
               FROM fence_owner
               JOIN pg_catalog.pg_class AS relation ON true
               CROSS JOIN LATERAL pg_catalog.aclexplode(relation.relacl) AS privilege
               WHERE privilege.grantee = fence_owner.oid
             )
             AND NOT EXISTS (
               SELECT 1
               FROM fence_owner
               JOIN pg_catalog.pg_type AS type_row ON true
               CROSS JOIN LATERAL pg_catalog.aclexplode(type_row.typacl) AS privilege
               WHERE privilege.grantee = fence_owner.oid
             )
             AND NOT EXISTS (
               SELECT 1
               FROM fence_owner
               JOIN pg_catalog.pg_attribute AS attribute ON attribute.attnum > 0
                                                         AND NOT attribute.attisdropped
               CROSS JOIN LATERAL pg_catalog.aclexplode(attribute.attacl) AS privilege
               WHERE privilege.grantee = fence_owner.oid
             ) AS "fenceTypeAndRelationAclBoundaryMatches",
             NOT EXISTS (
               SELECT 1
               FROM allowed_fence_functions AS allowed
               JOIN pg_catalog.pg_proc AS procedure ON procedure.oid = allowed.function_oid
               CROSS JOIN fence_owner
               WHERE allowed.function_oid NOT IN (
                   'pg_catalog.pg_control_system()'::pg_catalog.regprocedure,
                   'pg_catalog.pg_control_checkpoint()'::pg_catalog.regprocedure
                 )
                 AND procedure.proowner <> fence_owner.oid
             ) AS "fenceOwnedFunctionsMatch"
    `;

    if (!catalogContract) {
      throw new Error('migration role catalog contract returned no row');
    }
    if (catalogContract.databaseName !== contract.databaseName) {
      throw new Error(
        `migration database is ${catalogContract.databaseName}; expected canonical database ${contract.databaseName}`,
      );
    }
    if (
      catalogContract.loginRole !== contract.loginRole ||
      !catalogContract.loginRoleMatches ||
      !catalogContract.loginDoesNotOwnDatabase ||
      !catalogContract.loginHasNoDatabaseCreate ||
      !catalogContract.loginHasNoIncomingMemberships ||
      !catalogContract.loginHasNoOwnership ||
      !catalogContract.loginHasNoSchemaCreate
    ) {
      throw new Error(`migration credential must be the exact restricted LOGIN role ${contract.loginRole}`);
    }
    if (
      !catalogContract.ownerRoleMatches ||
      !catalogContract.ownerDoesNotOwnDatabase ||
      !catalogContract.ownerCreateGrantMatches ||
      !catalogContract.ownerMembershipMatches ||
      !catalogContract.ownerIncomingMembershipsMatch ||
      !catalogContract.subscriberContractMatches ||
      !catalogContract.fenceRoleMatches ||
      !catalogContract.fenceOutgoingMembershipMatches ||
      !catalogContract.fenceIncomingMembershipMatches ||
      !catalogContract.fenceControlAclMatches ||
      !catalogContract.fenceAclBoundaryMatches ||
      !catalogContract.fenceHasNoDatabaseCreate ||
      !catalogContract.fenceHasNoSchemaCreateOutsideOps ||
      !catalogContract.fenceDatabaseAclBoundaryMatches ||
      !catalogContract.fenceSchemaAclBoundaryMatches ||
      !catalogContract.fenceObjectOwnershipMatches ||
      !catalogContract.fenceTypeAndRelationAclBoundaryMatches ||
      !catalogContract.fenceOwnedFunctionsMatch
    ) {
      const failedChecks = Object.entries({
        ownerRoleMatches: catalogContract.ownerRoleMatches,
        ownerDoesNotOwnDatabase: catalogContract.ownerDoesNotOwnDatabase,
        ownerCreateGrantMatches: catalogContract.ownerCreateGrantMatches,
        ownerMembershipMatches: catalogContract.ownerMembershipMatches,
        ownerIncomingMembershipsMatch: catalogContract.ownerIncomingMembershipsMatch,
        subscriberContractMatches: catalogContract.subscriberContractMatches,
        fenceRoleMatches: catalogContract.fenceRoleMatches,
        fenceOutgoingMembershipMatches: catalogContract.fenceOutgoingMembershipMatches,
        fenceIncomingMembershipMatches: catalogContract.fenceIncomingMembershipMatches,
        fenceControlAclMatches: catalogContract.fenceControlAclMatches,
        fenceAclBoundaryMatches: catalogContract.fenceAclBoundaryMatches,
        fenceHasNoDatabaseCreate: catalogContract.fenceHasNoDatabaseCreate,
        fenceHasNoSchemaCreateOutsideOps: catalogContract.fenceHasNoSchemaCreateOutsideOps,
        fenceDatabaseAclBoundaryMatches: catalogContract.fenceDatabaseAclBoundaryMatches,
        fenceSchemaAclBoundaryMatches: catalogContract.fenceSchemaAclBoundaryMatches,
        fenceObjectOwnershipMatches: catalogContract.fenceObjectOwnershipMatches,
        fenceTypeAndRelationAclBoundaryMatches: catalogContract.fenceTypeAndRelationAclBoundaryMatches,
        fenceOwnedFunctionsMatch: catalogContract.fenceOwnedFunctionsMatch,
      })
        .filter(([, matches]) => !matches)
        .map(([check]) => check)
        .join(', ');
      throw new Error(
        `migration owner ${contract.ownerRole} does not match the restricted owner contract: ${failedChecks}`,
      );
    }
    if (!catalogContract.setEdgeMatches || catalogContract.loginMembershipCount !== 1) {
      throw new Error(
        `migration credential needs exactly one direct no-admin INHERIT-false SET-only edge to ${contract.ownerRole}`,
      );
    }

    await client.unsafe(setRoleStatement);
    roleWasSet = true;
    const [activeRole] = await client<{ currentRole: string; sessionRole: string }[]>`
      SELECT current_user AS "currentRole", session_user AS "sessionRole"
    `;
    if (activeRole?.currentRole !== contract.ownerRole || activeRole.sessionRole !== contract.loginRole) {
      throw new Error(`failed to enter migration owner role ${contract.ownerRole}`);
    }

    return {
      client,
      close: async () => {
        try {
          await client.unsafe('RESET ROLE');
        } finally {
          client.release();
        }
      },
    };
  } catch (error) {
    try {
      if (roleWasSet) {
        await client.unsafe('RESET ROLE');
      }
    } finally {
      client.release();
    }
    throw error;
  }
}
