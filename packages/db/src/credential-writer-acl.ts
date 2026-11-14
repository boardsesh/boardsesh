import { createHash } from 'node:crypto';
import type postgres from 'postgres';
import reviewedPrivateWebRelationShapes from './credential-writer-private-web-v1';
import reviewedBrowserRelationShapes from './credential-writer-private-browser-v1';
import reviewedProviderRelationShapes from './credential-writer-private-provider-v1';
import reviewedFirstPasswordRelationShapes from './credential-writer-private-first-password-v1';
import reviewedBrowserRenewalRelationShapes from './credential-writer-private-browser-renewal-v1';

export const CREDENTIAL_WRITER_ROLE = 'boardsesh_identity_writer';
export type CredentialWriterContract =
  | 'private-web-v1'
  | 'private-browser-v1'
  | 'private-provider-v1'
  | 'private-first-password-v1'
  | 'private-native-handoff-v1'
  | 'private-browser-renewal-v1';
export type CredentialPrivilege = 'SELECT' | 'INSERT' | 'UPDATE' | 'DELETE';
export type CredentialColumnPrivilege = 'SELECT' | 'INSERT' | 'UPDATE' | 'REFERENCES';

/** The three private web commands only. Provisioning is deliberately separate. */
export const PRIVATE_WEB_CREDENTIAL_CAPABILITIES: Readonly<Record<string, readonly CredentialPrivilege[]>> =
  Object.freeze({
    users: ['SELECT', 'INSERT', 'UPDATE'],
    accounts: ['SELECT', 'INSERT', 'UPDATE', 'DELETE'],
    user_credentials: ['SELECT', 'INSERT', 'UPDATE'],
    user_profiles: ['INSERT'],
    verificationTokens: ['SELECT', 'INSERT', 'UPDATE', 'DELETE'],
    mobile_refresh_tokens: ['SELECT', 'UPDATE'],
    auth_account: ['SELECT', 'INSERT', 'UPDATE', 'DELETE'],
    auth_session: ['SELECT', 'INSERT', 'UPDATE', 'DELETE'],
    auth_credential_lineage: ['SELECT', 'INSERT', 'UPDATE'],
    auth_session_denials: ['SELECT', 'INSERT', 'UPDATE'],
    auth_email_projection: ['SELECT'],
    auth_email_reservations: ['SELECT', 'INSERT', 'UPDATE'],
    auth_email_reservation_members: ['SELECT', 'INSERT'],
    auth_subject_cutoffs: ['SELECT', 'INSERT', 'UPDATE'],
    auth_security_mutation_events: ['SELECT', 'INSERT'],
    auth_password_recovery_state: ['SELECT', 'INSERT', 'UPDATE'],
    auth_password_recovery_tokens: ['SELECT', 'INSERT', 'UPDATE'],
    auth_email_verification_state: ['SELECT', 'INSERT', 'UPDATE'],
    auth_email_verification_tokens: ['SELECT', 'INSERT', 'UPDATE'],
    auth_web_oauth_intents: ['SELECT', 'INSERT', 'UPDATE'],
    auth_web_oauth_commands: ['SELECT', 'INSERT'],
  });
for (const privileges of Object.values(PRIVATE_WEB_CREDENTIAL_CAPABILITIES)) Object.freeze(privileges);

/** Browser correlation/intent commands share the credential LOGIN. Expiry
 * maintenance is a separate principal: no browser table DELETE is granted. */
export const PRIVATE_BROWSER_CREDENTIAL_CAPABILITIES: Readonly<Record<string, readonly CredentialPrivilege[]>> =
  Object.freeze({
    ...PRIVATE_WEB_CREDENTIAL_CAPABILITIES,
    auth_browser_bindings: Object.freeze(['SELECT', 'INSERT', 'UPDATE'] as const),
    auth_browser_intents: Object.freeze(['SELECT', 'INSERT', 'UPDATE'] as const),
  });

/** PostgreSQL row locks require UPDATE on at least one column. Keep member
 * identity keys immutable: only its observation timestamp gets that capability. */
export const PRIVATE_WEB_CREDENTIAL_COLUMN_CAPABILITIES: Readonly<
  Record<string, Readonly<Record<string, readonly CredentialColumnPrivilege[]>>>
> = Object.freeze({
  auth_email_reservation_members: Object.freeze({ observed_at: Object.freeze(['UPDATE'] as const) }),
});

/** Explicit provider security commands may revoke existing partner credentials.
 * They cannot mint grants/tokens, read token contents, or delete connections. */
export const PRIVATE_PROVIDER_CREDENTIAL_CAPABILITIES: Readonly<Record<string, readonly CredentialPrivilege[]>> =
  Object.freeze({
    ...PRIVATE_BROWSER_CREDENTIAL_CAPABILITIES,
    auth_provider_security_intents: Object.freeze(['SELECT', 'INSERT', 'UPDATE'] as const),
    auth_provider_reauthentication_receipts: Object.freeze(['SELECT', 'INSERT', 'UPDATE'] as const),
    oauth_verification: Object.freeze(['DELETE'] as const),
    oauth_grants: Object.freeze(['DELETE'] as const),
    oauth_access_token: Object.freeze(['DELETE'] as const),
    oauth_refresh_token: Object.freeze(['DELETE'] as const),
    oauth_consent: Object.freeze(['DELETE'] as const),
    oauth_refresh_ancestors: Object.freeze(['DELETE'] as const),
    oauth_consent_interactions: Object.freeze(['DELETE'] as const),
    oauth_session: Object.freeze(['DELETE'] as const),
  });
const selectOnly = Object.freeze(['SELECT'] as const);
const updateOnly = Object.freeze(['UPDATE'] as const);
const selectAndUpdate = Object.freeze(['SELECT', 'UPDATE'] as const);
export const PRIVATE_PROVIDER_CREDENTIAL_COLUMN_CAPABILITIES: Readonly<
  Record<string, Readonly<Record<string, readonly CredentialColumnPrivilege[]>>>
> = Object.freeze({
  ...PRIVATE_WEB_CREDENTIAL_COLUMN_CAPABILITIES,
  oauth_connections: Object.freeze({
    id: selectOnly,
    user_id: selectOnly,
    generation: selectAndUpdate,
    revoked_at: selectAndUpdate,
    revocation_reason: selectAndUpdate,
    updated_at: updateOnly,
  }),
  oauth_verification: Object.freeze({ identifier: selectOnly }),
  oauth_grants: Object.freeze({ authorization_code_id: selectOnly, connection_id: selectOnly }),
  oauth_access_token: Object.freeze({ user_id: selectOnly }),
  oauth_refresh_token: Object.freeze({ user_id: selectOnly }),
  oauth_consent: Object.freeze({ user_id: selectOnly }),
  oauth_refresh_ancestors: Object.freeze({ user_id: selectOnly }),
  oauth_consent_interactions: Object.freeze({ user_id: selectOnly }),
  oauth_session: Object.freeze({ user_id: selectOnly }),
});

/** UID-bound first-password confirmation adds one hash-only receipt relation.
 * Expiry scrubbing uses its reviewed UPDATE; deletion and other maintenance
 * remain outside this credential principal. */
export const PRIVATE_FIRST_PASSWORD_CREDENTIAL_CAPABILITIES: Readonly<Record<string, readonly CredentialPrivilege[]>> =
  Object.freeze({
    ...PRIVATE_PROVIDER_CREDENTIAL_CAPABILITIES,
    auth_first_password_challenges: Object.freeze(['SELECT', 'INSERT', 'UPDATE'] as const),
  });

/** Native browser handoff adds native credential creation explicitly. Old
 * contracts continue to refuse this grant; no native DELETE is permitted. */
export const PRIVATE_NATIVE_HANDOFF_CREDENTIAL_CAPABILITIES: Readonly<Record<string, readonly CredentialPrivilege[]>> =
  Object.freeze({
    ...PRIVATE_FIRST_PASSWORD_CREDENTIAL_CAPABILITIES,
    mobile_refresh_tokens: Object.freeze(['SELECT', 'INSERT', 'UPDATE'] as const),
  });

/** Renewal records cannot be deleted or have their frozen identity/evidence
 * rewritten. Only completion fields receive column-level UPDATE permission. */
export const PRIVATE_BROWSER_RENEWAL_CREDENTIAL_CAPABILITIES: Readonly<Record<string, readonly CredentialPrivilege[]>> =
  Object.freeze({
    ...PRIVATE_NATIVE_HANDOFF_CREDENTIAL_CAPABILITIES,
    auth_browser_renewals: Object.freeze(['SELECT', 'INSERT'] as const),
  });
export const PRIVATE_BROWSER_RENEWAL_CREDENTIAL_COLUMN_CAPABILITIES: Readonly<
  Record<string, Readonly<Record<string, readonly CredentialColumnPrivilege[]>>>
> = Object.freeze({
  ...PRIVATE_PROVIDER_CREDENTIAL_COLUMN_CAPABILITIES,
  auth_browser_renewals: Object.freeze({
    candidate_hash: updateOnly,
    result_version: updateOnly,
    completed_at: updateOnly,
    acknowledge_until: updateOnly,
  }),
});

// All profiles review the existing password-trigger closure. The provider
// profile and its explicit supersets permit the pinned invoker and narrow grants.
const partnerRevocationRelations = [
  'oauth_connections',
  'oauth_verification',
  'oauth_grants',
  'oauth_access_token',
  'oauth_refresh_token',
  'oauth_consent',
  'oauth_refresh_ancestors',
  'oauth_consent_interactions',
  'oauth_session',
] as const;
export interface CredentialWriterReceipt {
  readonly contract: CredentialWriterContract;
  readonly role: typeof CREDENTIAL_WRITER_ROLE;
  readonly sessionRole: typeof CREDENTIAL_WRITER_ROLE;
  readonly database: string;
  readonly databaseOid: number;
  readonly serverVersion: string;
  readonly catalogSha256: string;
}

export class CredentialWriterQualificationError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'CredentialWriterQualificationError';
  }
}
function refuse(code: string): never {
  throw new CredentialWriterQualificationError(code);
}

/**
 * Read-only qualification of the authenticated connection, never SET ROLE.
 * This receipt does not revoke old logins, retire issuers, or activate migration.
 */
export async function qualifyCredentialWriter(
  client: postgres.Sql | postgres.TransactionSql,
  options: {
    readonly expectedRole: string;
    readonly expectedDatabase: string;
    readonly contract: CredentialWriterContract;
  },
): Promise<CredentialWriterReceipt> {
  const requested = { ...options };
  if (
    requested.expectedRole !== CREDENTIAL_WRITER_ROLE ||
    ![
      'private-web-v1',
      'private-browser-v1',
      'private-provider-v1',
      'private-first-password-v1',
      'private-native-handoff-v1',
      'private-browser-renewal-v1',
    ].includes(requested.contract) ||
    !requested.expectedDatabase
  )
    refuse('CREDENTIAL_WRITER_CONTRACT_REQUIRED');
  const browserRenewal = requested.contract === 'private-browser-renewal-v1';
  const nativeHandoff = requested.contract === 'private-native-handoff-v1' || browserRenewal;
  const firstPassword = requested.contract === 'private-first-password-v1' || nativeHandoff;
  const directPartnerRevocation = requested.contract === 'private-provider-v1' || firstPassword;
  const capabilities = browserRenewal
    ? PRIVATE_BROWSER_RENEWAL_CREDENTIAL_CAPABILITIES
    : nativeHandoff
      ? PRIVATE_NATIVE_HANDOFF_CREDENTIAL_CAPABILITIES
      : firstPassword
        ? PRIVATE_FIRST_PASSWORD_CREDENTIAL_CAPABILITIES
        : directPartnerRevocation
          ? PRIVATE_PROVIDER_CREDENTIAL_CAPABILITIES
          : requested.contract === 'private-browser-v1'
            ? PRIVATE_BROWSER_CREDENTIAL_CAPABILITIES
            : PRIVATE_WEB_CREDENTIAL_CAPABILITIES;
  const columnCapabilities = browserRenewal
    ? PRIVATE_BROWSER_RENEWAL_CREDENTIAL_COLUMN_CAPABILITIES
    : directPartnerRevocation
      ? PRIVATE_PROVIDER_CREDENTIAL_COLUMN_CAPABILITIES
      : PRIVATE_WEB_CREDENTIAL_COLUMN_CAPABILITIES;
  const closureRelations = [...new Set([...Object.keys(capabilities), ...partnerRevocationRelations])];
  const deleteSources = [
    ...Object.entries(capabilities)
      .filter(([, privileges]) => privileges.includes('DELETE'))
      .map(([table]) => table),
    ...partnerRevocationRelations.filter((table) => table !== 'oauth_connections'),
  ];
  const updateSources = [
    ...Object.entries(capabilities)
      .filter(([, privileges]) => privileges.includes('UPDATE'))
      .map(([table]) => table),
    ...Object.entries(columnCapabilities)
      .filter(([, columns]) => Object.values(columns).some((privileges) => privileges.includes('UPDATE')))
      .map(([table]) => table),
    'oauth_connections',
  ];
  const reviewedRelationShapes = directPartnerRevocation
    ? [
        ...reviewedPrivateWebRelationShapes.filter((relation) => relation.name !== 'auth_security_mutation_events'),
        ...reviewedBrowserRelationShapes,
        ...reviewedProviderRelationShapes,
        ...(firstPassword ? reviewedFirstPasswordRelationShapes : []),
        ...(browserRenewal ? reviewedBrowserRenewalRelationShapes : []),
      ].sort((left, right) => left.name.localeCompare(right.name))
    : requested.contract === 'private-browser-v1'
      ? [...reviewedPrivateWebRelationShapes, ...reviewedBrowserRelationShapes].sort((left, right) =>
          left.name.localeCompare(right.name),
        )
      : reviewedPrivateWebRelationShapes;
  const [identity] = await client<
    {
      role: string;
      sessionRole: string;
      database: string;
      databaseOid: number;
      serverVersion: string;
      schemas: string[];
      safe: boolean;
    }[]
  >`
    SELECT current_user AS role, session_user AS "sessionRole", pg_catalog.current_database() AS database,
      database.oid::integer AS "databaseOid", pg_catalog.current_setting('server_version') AS "serverVersion",
      pg_catalog.current_schemas(true) AS schemas,
      role.rolcanlogin AND NOT role.rolsuper AND NOT role.rolcreatedb AND NOT role.rolcreaterole
      AND NOT role.rolreplication AND NOT role.rolbypassrls
      AND pg_catalog.current_setting('session_replication_role')='origin'
      AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members WHERE member=role.oid OR roleid=role.oid)
      AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_shdepend WHERE refclassid='pg_catalog.pg_authid'::pg_catalog.regclass AND refobjid=role.oid AND deptype='o')
      AND NOT pg_catalog.has_database_privilege(role.oid,database.oid,'CREATE,TEMP')
      AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_namespace namespace WHERE pg_catalog.has_schema_privilege(role.oid,namespace.oid,'CREATE')) AS safe
    FROM pg_catalog.pg_roles role CROSS JOIN pg_catalog.pg_database database
    WHERE role.rolname=current_user AND database.datname=pg_catalog.current_database()`;
  if (
    !identity ||
    identity.role !== requested.expectedRole ||
    identity.sessionRole !== requested.expectedRole ||
    identity.database !== requested.expectedDatabase
  )
    refuse('CREDENTIAL_WRITER_CONNECTION_MISMATCH');
  if (!identity.safe || JSON.stringify(identity.schemas) !== JSON.stringify(['pg_catalog', 'public']))
    refuse('UNSAFE_CREDENTIAL_WRITER_ROLE');

  const relations = await client<
    {
      schema: string;
      name: string;
      kind: string;
      privileges: string[];
      columnPrivileges: { name: string; privileges: string[] }[];
      grantOption: boolean;
      publicGrant: boolean;
    }[]
  >`
    SELECT namespace.nspname AS schema, relation.relname AS name, relation.relkind AS kind,
      ARRAY(SELECT privilege FROM unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER'] || CASE WHEN current_setting('server_version_num')::integer >= 170000 THEN ARRAY['MAINTAIN'] ELSE ARRAY[]::text[] END) privilege
        WHERE has_table_privilege(current_user,relation.oid,privilege)) AS privileges,
      coalesce((SELECT json_agg(json_build_object('name',attribute.attname,'privileges',
        ARRAY(SELECT privilege FROM unnest(ARRAY['SELECT','INSERT','UPDATE','REFERENCES']) privilege
          WHERE has_column_privilege(current_user,relation.oid,attribute.attnum,privilege) ORDER BY privilege)) ORDER BY attribute.attnum)
        FROM pg_attribute attribute WHERE attribute.attrelid=relation.oid AND attribute.attnum>0 AND NOT attribute.attisdropped),'[]'::json) AS "columnPrivileges",
      EXISTS (SELECT 1 FROM aclexplode(relation.relacl) acl WHERE acl.grantee IN (0,(SELECT oid FROM pg_roles WHERE rolname=current_user)) AND acl.is_grantable)
      OR EXISTS (SELECT 1 FROM pg_attribute attribute CROSS JOIN LATERAL aclexplode(attribute.attacl) acl
        WHERE attribute.attrelid=relation.oid AND acl.grantee IN (0,(SELECT oid FROM pg_roles WHERE rolname=current_user)) AND acl.is_grantable) AS "grantOption",
      EXISTS (SELECT 1 FROM aclexplode(relation.relacl) acl WHERE acl.grantee=0)
      OR EXISTS (SELECT 1 FROM pg_attribute attribute CROSS JOIN LATERAL aclexplode(attribute.attacl) acl
        WHERE attribute.attrelid=relation.oid AND acl.grantee=0) AS "publicGrant"
    FROM pg_class relation JOIN pg_namespace namespace ON namespace.oid=relation.relnamespace
    WHERE namespace.nspname !~ '^pg_' AND namespace.nspname<>'information_schema' AND relation.relkind IN ('r','p','v','m','f') ORDER BY 1,2`;
  const required = new Set([...Object.keys(capabilities), ...Object.keys(columnCapabilities)]);
  for (const relation of relations) {
    const allowed = relation.schema === 'public' ? capabilities[relation.name] : undefined;
    const allowedColumns = relation.schema === 'public' ? columnCapabilities[relation.name] : undefined;
    if (allowed || allowedColumns) {
      required.delete(relation.name);
      if (relation.kind !== 'r' || allowed?.some((privilege) => !relation.privileges.includes(privilege)))
        refuse('CREDENTIAL_WRITER_REQUIRED_GRANT_MISSING');
      for (const [column, privileges] of Object.entries(allowedColumns ?? {})) {
        const effective = relation.columnPrivileges.find((entry) => entry.name === column)?.privileges;
        if (!effective || privileges.some((privilege) => !effective.includes(privilege)))
          refuse('CREDENTIAL_WRITER_REQUIRED_COLUMN_GRANT_MISSING');
      }
    }
    if (
      relation.grantOption ||
      (relation.publicGrant && relation.schema === 'public' && closureRelations.includes(relation.name)) ||
      relation.privileges.some((privilege) => !allowed?.includes(privilege as CredentialPrivilege)) ||
      relation.columnPrivileges.some((column) =>
        column.privileges.some(
          (privilege) =>
            !allowed?.includes(privilege as CredentialPrivilege) &&
            !allowedColumns?.[column.name]?.includes(privilege as CredentialColumnPrivilege),
        ),
      )
    )
      refuse('CREDENTIAL_WRITER_EXCESS_RELATION_GRANT');
  }
  if (required.size) refuse('CREDENTIAL_WRITER_RELATION_MISSING');

  const directRoutineGrant = directPartnerRevocation
    ? (
        await client<
          {
            executable: boolean;
            direct: boolean;
            public: boolean;
            grantOption: boolean;
            reviewedSignature: boolean;
          }[]
        >`
        SELECT has_function_privilege(current_user,routine.oid,'EXECUTE') AS executable,
          EXISTS (SELECT 1 FROM aclexplode(routine.proacl) acl
            WHERE acl.grantee=(SELECT oid FROM pg_roles WHERE rolname=current_user)
              AND acl.privilege_type='EXECUTE' AND NOT acl.is_grantable) AS direct,
          EXISTS (SELECT 1 FROM aclexplode(routine.proacl) acl
            WHERE acl.grantee=0 AND acl.privilege_type='EXECUTE') AS public,
          EXISTS (SELECT 1 FROM aclexplode(routine.proacl) acl
            WHERE acl.grantee IN (0,(SELECT oid FROM pg_roles WHERE rolname=current_user)) AND acl.is_grantable) AS "grantOption",
          routine.prokind='f' AND routine.proisstrict AND NOT routine.proretset
            AND routine.prorettype='integer'::regtype AND routine.provariadic=0
            AND routine.pronargdefaults=0 AND routine.proargmodes IS NULL
            AND routine.provolatile='v' AND routine.proparallel='u' AND NOT routine.proleakproof
            AND routine.prosupport=0
            AND NOT EXISTS (SELECT 1 FROM pg_proc overload
              WHERE overload.pronamespace=routine.pronamespace AND overload.proname=routine.proname
                AND overload.oid<>routine.oid) AS "reviewedSignature"
        FROM pg_proc routine WHERE routine.oid=to_regprocedure('public.partner_revoke_user(text)')`
      )[0]
    : undefined;
  if (directPartnerRevocation) {
    if (!directRoutineGrant?.executable) refuse('CREDENTIAL_WRITER_REQUIRED_ROUTINE_GRANT_MISSING');
    if (directRoutineGrant.public || directRoutineGrant.grantOption || !directRoutineGrant.reviewedSignature)
      refuse('CREDENTIAL_WRITER_UNREVIEWED_ROUTINE_PATH');
    if (!directRoutineGrant.direct) refuse('CREDENTIAL_WRITER_REQUIRED_ROUTINE_GRANT_MISSING');
  }

  const [paths] = await client<
    {
      sequence: boolean;
      system: boolean;
      routine: boolean;
      defaults: boolean;
      shape: boolean;
      expression: boolean;
      cascade: boolean;
      shadow: boolean;
    }[]
  >`
    WITH closure AS (SELECT relation.oid FROM pg_class relation JOIN pg_namespace namespace ON namespace.oid=relation.relnamespace
      WHERE namespace.nspname='public' AND relation.relname IN (SELECT jsonb_array_elements_text(${JSON.stringify(closureRelations)}::text::jsonb)))
    SELECT EXISTS (SELECT 1 FROM pg_class relation JOIN pg_namespace namespace ON namespace.oid=relation.relnamespace
      WHERE namespace.nspname !~ '^pg_' AND namespace.nspname<>'information_schema' AND relation.relkind='S'
      AND has_sequence_privilege(current_user,relation.oid,'USAGE,SELECT,UPDATE')) AS sequence,
    EXISTS (SELECT 1 FROM pg_class relation JOIN pg_namespace namespace ON namespace.oid=relation.relnamespace CROSS JOIN LATERAL aclexplode(relation.relacl) acl
      WHERE namespace.nspname='pg_catalog' AND (acl.grantee=(SELECT oid FROM pg_roles WHERE rolname=current_user)
        OR (acl.grantee=0 AND (acl.privilege_type<>'SELECT' OR acl.is_grantable)
          AND NOT (relation.oid='pg_catalog.pg_settings'::regclass AND acl.privilege_type='UPDATE' AND NOT acl.is_grantable))))
      OR EXISTS (SELECT 1 FROM pg_attribute attribute JOIN pg_class relation ON relation.oid=attribute.attrelid
        CROSS JOIN LATERAL aclexplode(attribute.attacl) acl WHERE relation.relnamespace='pg_catalog'::regnamespace
        AND (acl.grantee=(SELECT oid FROM pg_roles WHERE rolname=current_user) OR (acl.grantee=0 AND (acl.privilege_type<>'SELECT' OR acl.is_grantable))))
      OR EXISTS (SELECT 1 FROM pg_parameter_acl parameter CROSS JOIN LATERAL aclexplode(parameter.paracl) acl
        WHERE acl.grantee IN (0,(SELECT oid FROM pg_roles WHERE rolname=current_user))) AS system,
    EXISTS (SELECT 1 FROM pg_proc routine JOIN pg_namespace namespace ON namespace.oid=routine.pronamespace
      WHERE namespace.nspname !~ '^pg_' AND namespace.nspname<>'information_schema'
      AND has_function_privilege(current_user,routine.oid,'EXECUTE')
      AND (NOT ${directPartnerRevocation} OR routine.oid IS DISTINCT FROM to_regprocedure('public.partner_revoke_user(text)')))
      OR EXISTS (SELECT 1 FROM pg_proc routine CROSS JOIN LATERAL aclexplode(routine.proacl) acl
        WHERE routine.pronamespace='pg_catalog'::regnamespace AND acl.grantee IN (0,(SELECT oid FROM pg_roles WHERE rolname=current_user))) AS routine,
    EXISTS (SELECT 1 FROM pg_default_acl defaults CROSS JOIN LATERAL aclexplode(defaults.defaclacl) acl
      WHERE acl.grantee IN (0,(SELECT oid FROM pg_roles WHERE rolname=current_user)) AND defaults.defaclobjtype IN ('r','S','f'))
      OR EXISTS (SELECT 1 FROM (SELECT DISTINCT relation.relowner AS owner FROM pg_class relation JOIN pg_namespace namespace ON namespace.oid=relation.relnamespace
        WHERE namespace.nspname !~ '^pg_' AND namespace.nspname<>'information_schema'
        UNION SELECT DISTINCT routine.proowner FROM pg_proc routine JOIN pg_namespace namespace ON namespace.oid=routine.pronamespace
        WHERE namespace.nspname !~ '^pg_' AND namespace.nspname<>'information_schema') owner
        WHERE NOT EXISTS (SELECT 1 FROM pg_default_acl defaults WHERE defaults.defaclrole=owner.owner AND defaults.defaclobjtype='f' AND defaults.defaclnamespace=0)) AS defaults,
    (SELECT count(*) FROM closure)<>${closureRelations.length}
      OR EXISTS (SELECT 1 FROM closure JOIN pg_class relation ON relation.oid=closure.oid JOIN pg_am method ON method.oid=relation.relam
        WHERE relation.relkind<>'r' OR relation.relrowsecurity OR relation.relforcerowsecurity OR relation.relispartition OR method.amname<>'heap'
        OR EXISTS (SELECT 1 FROM pg_inherits WHERE inhrelid=relation.oid OR inhparent=relation.oid)
        OR EXISTS (SELECT 1 FROM pg_rewrite WHERE ev_class=relation.oid AND rulename<>'_RETURN')
        OR EXISTS (SELECT 1 FROM pg_attribute attribute JOIN pg_type type ON type.oid=attribute.atttypid
          WHERE attribute.attrelid=relation.oid AND attribute.attnum>0 AND NOT attribute.attisdropped
          AND (type.typnamespace<>'pg_catalog'::regnamespace OR type.typtype='d' OR attribute.attgenerated<>'' OR attribute.attidentity<>''))
        OR EXISTS (SELECT 1 FROM pg_index index_row CROSS JOIN LATERAL unnest(index_row.indclass) class_oid JOIN pg_opclass class ON class.oid=class_oid
          WHERE index_row.indrelid=relation.oid AND class.opcnamespace<>'pg_catalog'::regnamespace)) AS shape,
    EXISTS (SELECT 1 FROM pg_depend dependency JOIN pg_proc routine ON routine.oid=dependency.refobjid
      WHERE dependency.refclassid='pg_proc'::regclass AND routine.pronamespace<>'pg_catalog'::regnamespace
      AND ((dependency.classid='pg_attrdef'::regclass AND dependency.objid IN (SELECT oid FROM pg_attrdef WHERE adrelid IN (SELECT oid FROM closure)))
        OR (dependency.classid='pg_constraint'::regclass AND dependency.objid IN (SELECT oid FROM pg_constraint WHERE conrelid IN (SELECT oid FROM closure)))
        OR (dependency.classid='pg_class'::regclass AND dependency.objid IN (SELECT indexrelid FROM pg_index WHERE indrelid IN (SELECT oid FROM closure))))) AS expression,
    EXISTS (SELECT 1 FROM pg_constraint WHERE contype='f' AND confrelid IN (SELECT oid FROM closure) AND conrelid NOT IN (SELECT oid FROM closure)
      AND ((confdeltype IN ('c','n','d') AND confrelid IN (SELECT relation.oid FROM pg_class relation WHERE relation.relnamespace='public'::regnamespace AND relation.relname IN (SELECT jsonb_array_elements_text(${JSON.stringify(deleteSources)}::text::jsonb))))
        OR (confupdtype IN ('c','n','d') AND confrelid IN (SELECT relation.oid FROM pg_class relation WHERE relation.relnamespace='public'::regnamespace AND relation.relname IN (SELECT jsonb_array_elements_text(${JSON.stringify(updateSources)}::text::jsonb)))))) AS cascade,
    EXISTS (SELECT 1 FROM pg_operator operator JOIN pg_type left_type ON left_type.oid=operator.oprleft JOIN pg_type right_type ON right_type.oid=operator.oprright
      WHERE operator.oprnamespace='public'::regnamespace AND operator.oprname IN ('=','<>','+') AND left_type.typnamespace='pg_catalog'::regnamespace AND right_type.typnamespace='pg_catalog'::regnamespace)
      OR EXISTS (SELECT 1 FROM pg_cast cast_row JOIN pg_proc routine ON routine.oid=cast_row.castfunc
        JOIN pg_type source ON source.oid=cast_row.castsource JOIN pg_type target ON target.oid=cast_row.casttarget
        WHERE routine.pronamespace<>'pg_catalog'::regnamespace AND source.typnamespace='pg_catalog'::regnamespace AND target.typnamespace='pg_catalog'::regnamespace)
      OR EXISTS (SELECT 1 FROM pg_proc routine WHERE routine.pronamespace='public'::regnamespace
        AND routine.proname IN ('clock_timestamp','current_setting','now')) AS shadow`;
  if (!paths) refuse('CREDENTIAL_WRITER_CATALOG_UNAVAILABLE');
  for (const [path, unsafe] of Object.entries(paths))
    if (unsafe) refuse(`CREDENTIAL_WRITER_UNREVIEWED_${path.toUpperCase()}_PATH`);

  // Pinned builtins are omitted from pg_depend. Exact shapes also refuse a
  // builtin pg_notify/set_config side effect hidden in a new default or CHECK.
  const relationShapes = await client<{ name: string; shape: unknown }[]>`
    SELECT relation.relname AS name,
      json_build_object(
        'columns',(SELECT json_agg(json_build_array(attribute.attname,format_type(attribute.atttypid,attribute.atttypmod),attribute.attnotnull,attribute.attidentity,attribute.attgenerated,pg_get_expr(default_row.adbin,default_row.adrelid)) ORDER BY attribute.attnum)
          FROM pg_attribute attribute LEFT JOIN pg_attrdef default_row ON default_row.adrelid=attribute.attrelid AND default_row.adnum=attribute.attnum WHERE attribute.attrelid=relation.oid AND attribute.attnum>0 AND NOT attribute.attisdropped),
        'indexes',(SELECT json_agg(pg_get_indexdef(indexrelid) ORDER BY indexrelid::regclass::text) FROM pg_index WHERE indrelid=relation.oid),
        'constraints',(SELECT json_agg(pg_get_constraintdef(oid) ORDER BY conname) FROM pg_constraint WHERE conrelid=relation.oid AND contype<>'n')) AS shape
    FROM pg_class relation WHERE relation.relnamespace='public'::regnamespace
      AND relation.relname IN (SELECT jsonb_array_elements_text(${JSON.stringify(closureRelations)}::text::jsonb)) ORDER BY relation.relname`;
  if (JSON.stringify([...relationShapes]) !== JSON.stringify(reviewedRelationShapes))
    refuse('CREDENTIAL_WRITER_UNREVIEWED_RELATION_SHAPE');

  const routines = await client<
    {
      name: string;
      source: string;
      definer: boolean;
      configuration: string[];
      language: string;
      ownerMatches: boolean;
    }[]
  >`
    SELECT routine.proname AS name, routine.prosrc AS source, routine.prosecdef AS definer, routine.proconfig AS configuration,
      language.lanname AS language, routine.proowner=(SELECT relowner FROM pg_class WHERE oid='public.user_credentials'::regclass) AS "ownerMatches"
    FROM pg_proc routine JOIN pg_language language ON language.oid=routine.prolang
    WHERE routine.pronamespace='public'::regnamespace AND routine.oid IN
      (to_regprocedure('public.partner_revoke_on_credential_change()'),to_regprocedure('public.partner_revoke_user(text)')) ORDER BY 1`;
  const expectedRoutines = [
    {
      name: 'partner_revoke_on_credential_change',
      sha256: 'caff89c7db895f231d40ebc519d7d4ad770db7fe8df19ae274c28470b2d4cfa2',
      definer: true,
      configuration: ['search_path=public, pg_catalog'],
    },
    {
      name: 'partner_revoke_user',
      sha256: '90e43627786d993f75bf0b174d60996dadc7760968a32fbb753a3078b4b32eed',
      definer: false,
      configuration: ['search_path=public, pg_catalog', 'lock_timeout=5s'],
    },
  ];
  if (
    routines.length !== expectedRoutines.length ||
    routines.some((routine, index) => {
      const expected = expectedRoutines[index];
      return (
        !expected ||
        routine.name !== expected.name ||
        routine.language !== 'plpgsql' ||
        !routine.ownerMatches ||
        routine.definer !== expected.definer ||
        JSON.stringify(routine.configuration) !== JSON.stringify(expected.configuration) ||
        createHash('sha256').update(routine.source).digest('hex') !== expected.sha256
      );
    })
  )
    refuse('CREDENTIAL_WRITER_UNREVIEWED_PARTNER_REVOKE');
  const triggers = await client<{ definition: string; enabled: string }[]>`
    SELECT pg_get_triggerdef(trigger.oid) AS definition, trigger.tgenabled AS enabled FROM pg_trigger trigger
    WHERE NOT trigger.tgisinternal AND trigger.tgrelid IN (SELECT relation.oid FROM pg_class relation JOIN pg_namespace namespace ON namespace.oid=relation.relnamespace
      WHERE namespace.nspname='public' AND relation.relname IN (SELECT jsonb_array_elements_text(${JSON.stringify(closureRelations)}::text::jsonb))) ORDER BY trigger.tgname`;
  const expectedTriggers = [
    {
      definition:
        'CREATE TRIGGER trg_user_credentials_partner_revoke_insert BEFORE INSERT ON public.user_credentials FOR EACH ROW EXECUTE FUNCTION partner_revoke_on_credential_change()',
      enabled: 'O',
    },
    {
      definition:
        'CREATE TRIGGER trg_user_credentials_partner_revoke_update BEFORE UPDATE OF password_hash ON public.user_credentials FOR EACH ROW WHEN ((old.password_hash IS DISTINCT FROM new.password_hash)) EXECUTE FUNCTION partner_revoke_on_credential_change()',
      enabled: 'O',
    },
  ];
  if (JSON.stringify([...triggers]) !== JSON.stringify(expectedTriggers))
    refuse('CREDENTIAL_WRITER_UNREVIEWED_TRIGGER_PATH');
  return Object.freeze({
    contract: requested.contract,
    role: CREDENTIAL_WRITER_ROLE,
    sessionRole: CREDENTIAL_WRITER_ROLE,
    database: identity.database,
    databaseOid: identity.databaseOid,
    serverVersion: identity.serverVersion,
    catalogSha256: createHash('sha256')
      .update(JSON.stringify({ relations, paths, relationShapes, routines, triggers, directRoutineGrant }))
      .digest('hex'),
  });
}
