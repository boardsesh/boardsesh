import type postgres from 'postgres';
import { createHash } from 'node:crypto';
import {
  GYM_INVENTORY_PRIVATE_TABLES,
  SPRAY_EXPOSURE_EVENT_SEQUENCE,
  sprayExposureTriggerIdentity,
  verifySprayExposureClosure,
} from './auth-spray-exposure-acl';

export const WEB_ROLE = 'boardsesh_web';
export const quoteIdentifier = (identifier: string) => `"${identifier.replaceAll('"', '""')}"`;
/** Partner state is served through backend APIs, never directly by the web database role. */
export const BACKEND_ONLY_PARTNER_TABLES: readonly string[] = Object.freeze([
  'partner_developer_emails',
  'partner_connection_notices',
  'gym_mcp_write_receipts',
  'partner_app_cap_audit',
  'app_workouts',
  'app_workout_requests',
  'oauth_client_webhooks',
  'partner_webhook_outbox',
  'webhook_deliveries',
  'partner_webhook_feed_state',
  'partner_webhook_debounce',
]);
/** Identity tables outside the `auth_`/`oauth_` prefixes. The web role may read them, never write. */
export const NAMED_IDENTITY_TABLES: readonly string[] = Object.freeze([
  'users',
  'accounts',
  'sessions',
  'verificationTokens',
  'user_credentials',
  'mobile_refresh_tokens',
  'integration_credentials',
  // Encrypted board passwords and refresh tokens. Written by the backend's
  // board-credential service and the sync workers; the web only reads it.
  'aurora_credentials',
  // Which board account a Boardsesh user is. Written by the backend and the
  // sync workers; the web only reads it (sitemap, profile).
  'user_board_mappings',
  ...BACKEND_ONLY_PARTNER_TABLES,
]);
export function protectedIdentityTable(name: string): boolean {
  return /^(auth_|oauth_)/.test(name) || NAMED_IDENTITY_TABLES.includes(name);
}
/**
 * Tables declared under `packages/db/src/schema/auth/` that the web role may
 * still write, each with the reason. Every other table there must be an
 * identity table above: the fence grants web CRUD on anything that is not, so
 * a new auth table missing from both lists fails `catalog.test.ts`.
 */
export const WEB_WRITABLE_AUTH_SCHEMA_TABLES: Readonly<Record<string, string>> = Object.freeze({
  user_profiles:
    'Display name, avatar and privacy, not a credential. Web sign-in inserts the row (auth-options.ts) and registration creates it.',
});
/**
 * Serializes fence `apply` with the web reconcile every migration runs. Both
 * take it inside their transaction. The migration runner had no lock of its own.
 */
export const WEB_FENCE_LOCK_SQL = 'SELECT pg_advisory_xact_lock(6975, 3)';
export interface FenceRelation {
  schema: string;
  name: string;
  kind: string;
  columns: string[];
  owner?: string;
  /** For a sequence: the table whose serial or identity column owns it. */
  sequenceOwner?: string | null;
}
export interface FenceCatalog {
  webRoleExists?: boolean;
  relations: FenceRelation[];
  routines: string[];
  routineOwners?: Readonly<Record<string, string>>;
  owners: string[];
  schemas: string[];
  schemaOwners?: Readonly<Record<string, string>>;
}

/** Catalog only: no account, token or email rows are ever read. */
export async function readFenceCatalog(client: postgres.Sql | postgres.TransactionSql): Promise<FenceCatalog> {
  const [webRole] = await client<
    { present: boolean }[]
  >`SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = ${WEB_ROLE}) AS present`;
  const relations = await client<FenceRelation[]>`
    SELECT namespace.nspname AS schema, relation.relname AS name, relation.relkind AS kind, pg_get_userbyid(relation.relowner) AS owner,
      to_json(ARRAY(SELECT attname FROM pg_attribute WHERE attrelid = relation.oid AND attnum > 0 AND NOT attisdropped ORDER BY attnum)) AS columns,
      (SELECT owning.relname FROM pg_depend dependency JOIN pg_class owning ON owning.oid = dependency.refobjid
        WHERE relation.relkind = 'S' AND dependency.classid = 'pg_class'::regclass AND dependency.objid = relation.oid
          AND dependency.refclassid = 'pg_class'::regclass AND dependency.deptype IN ('a','i') LIMIT 1) AS "sequenceOwner"
    FROM pg_class relation JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
    WHERE namespace.nspname !~ '^pg_' AND namespace.nspname <> 'information_schema'
      AND relation.relkind IN ('r','p','v','m','f','S') ORDER BY 1,2`;
  const routines = await client<{ signature: string; owner: string }[]>`
    SELECT procedure.oid::regprocedure::text AS signature, pg_get_userbyid(procedure.proowner) AS owner FROM pg_proc procedure
    JOIN pg_namespace namespace ON namespace.oid = procedure.pronamespace
    WHERE namespace.nspname !~ '^pg_' AND namespace.nspname <> 'information_schema' AND procedure.prosecdef
      AND EXISTS (SELECT 1 FROM aclexplode(coalesce(procedure.proacl, acldefault('f',procedure.proowner))) acl
        WHERE acl.grantee = 0 OR acl.grantee = (SELECT oid FROM pg_roles WHERE rolname = ${WEB_ROLE})) ORDER BY 1`;
  const owners = await client<{ name: string }[]>`
    SELECT DISTINCT role.rolname AS name FROM pg_roles role WHERE role.oid IN (
      SELECT relowner FROM pg_class relation JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
      WHERE namespace.nspname !~ '^pg_' AND namespace.nspname <> 'information_schema'
      UNION SELECT proowner FROM pg_proc routine JOIN pg_namespace namespace ON namespace.oid = routine.pronamespace WHERE namespace.nspname !~ '^pg_' AND namespace.nspname <> 'information_schema'
      UNION SELECT defaclrole FROM pg_default_acl) ORDER BY 1`;
  const schemas = await client<{ name: string; owner: string }[]>`
    SELECT nspname AS name, pg_get_userbyid(nspowner) AS owner FROM pg_namespace WHERE nspname !~ '^pg_' AND nspname <> 'information_schema' ORDER BY 1`;
  return {
    webRoleExists: webRole?.present === true,
    relations: [...relations],
    routines: routines.map(({ signature }) => signature),
    routineOwners: Object.fromEntries(routines.map(({ signature, owner }) => [signature, owner])),
    owners: owners.map(({ name }) => name),
    schemas: schemas.map(({ name }) => name),
    schemaOwners: Object.fromEntries(schemas.map(({ name, owner }) => [name, owner])),
  };
}

export function fencePlan(catalog: FenceCatalog, options: { readonly ddlOwner?: string } = {}) {
  const role = quoteIdentifier(WEB_ROLE);
  const apply: string[] = [];
  const rollback: string[] = [];
  // Role creation is explicit and reviewable, password provisioning stays outside SQL output.
  if (!catalog.webRoleExists)
    apply.push(`CREATE ROLE ${role} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;`);
  for (const schema of catalog.schemas) {
    if (options.ddlOwner && catalog.schemaOwners?.[schema] !== options.ddlOwner) continue;
    apply.push(
      `REVOKE CREATE ON SCHEMA ${quoteIdentifier(schema)} FROM PUBLIC, ${role};`,
      `GRANT USAGE ON SCHEMA ${quoteIdentifier(schema)} TO ${role};`,
    );
  }
  for (const relation of catalog.relations) {
    // The admin operator handles external/extension owners; routine deploys do not impersonate them.
    if (options.ddlOwner && relation.owner !== options.ddlOwner) continue;
    const target = `${quoteIdentifier(relation.schema)}.${quoteIdentifier(relation.name)}`;
    if (relation.kind === 'S') {
      apply.push(`REVOKE ALL ON SEQUENCE ${target} FROM PUBLIC, ${role};`);
      if (relation.name === SPRAY_EXPOSURE_EVENT_SEQUENCE) continue;
      // An identity table's own sequence stays closed: the web never inserts there.
      const identitySequence = !!relation.sequenceOwner && protectedIdentityTable(relation.sequenceOwner);
      if (identitySequence && !BACKEND_ONLY_PARTNER_TABLES.includes(relation.sequenceOwner!))
        rollback.push(`GRANT USAGE ON SEQUENCE ${target} TO ${role};`);
      else if (identitySequence) continue;
      else apply.push(`GRANT USAGE ON SEQUENCE ${target} TO ${role};`);
      continue;
    }
    apply.push(`REVOKE ALL ON TABLE ${target} FROM PUBLIC, ${role};`);
    for (const column of relation.columns)
      apply.push(`REVOKE ALL (${quoteIdentifier(column)}) ON TABLE ${target} FROM PUBLIC, ${role};`);
    const identity = protectedIdentityTable(relation.name);
    // Views/routines are denied by default: owners can bypass base-table ACLs.
    const readable =
      relation.name !== 'auth_session' &&
      relation.name !== '__drizzle_migrations' &&
      !BACKEND_ONLY_PARTNER_TABLES.includes(relation.name) &&
      !GYM_INVENTORY_PRIVATE_TABLES.includes(relation.name) &&
      ['r', 'p'].includes(relation.kind);
    if (readable) apply.push(`GRANT SELECT ON TABLE ${target} TO ${role};`);
    if (!identity && readable) apply.push(`GRANT INSERT, UPDATE, DELETE ON TABLE ${target} TO ${role};`);
    if (identity && readable) rollback.push(`GRANT INSERT, UPDATE, DELETE ON TABLE ${target} TO ${role};`);
  }
  for (const routine of catalog.routines) {
    if (options.ddlOwner && catalog.routineOwners?.[routine] !== options.ddlOwner) continue;
    apply.push(`REVOKE ALL ON ROUTINE ${routine} FROM PUBLIC, ${role};`);
  }
  for (const owner of catalog.owners) {
    if (options.ddlOwner && owner !== options.ddlOwner) continue;
    for (const scope of ['', ...catalog.schemas.map((schema) => ` IN SCHEMA ${quoteIdentifier(schema)}`)]) {
      for (const kind of ['TABLES', 'SEQUENCES', 'ROUTINES'])
        apply.push(
          `ALTER DEFAULT PRIVILEGES FOR ROLE ${quoteIdentifier(owner)}${scope} REVOKE ALL ON ${kind} FROM PUBLIC, ${role};`,
        );
    }
  }
  const sql = apply.join('\n') + '\n';
  return {
    sql,
    rollbackSql:
      '-- Emergency only before S3; never removes cutoffs or changes passwords.\n' + rollback.join('\n') + '\n',
    sha256: createHash('sha256').update(sql).digest('hex'),
  };
}

/** The app-facing board update reaches these objects under the reviewed trigger owner's privileges. */
async function verifyGymReportingAliasClosure(
  client: postgres.Sql | postgres.TransactionSql,
  reviewedAttachment: boolean,
) {
  const [closure] = await client<
    { installed: boolean; safe: boolean; sink: { columns: unknown; indexes: unknown; constraints: unknown } }[]
  >`
    WITH relations(oid) AS (
      VALUES (to_regclass('public.user_boards')), (to_regclass('public.gyms')),
        (to_regclass('public.gym_reporting_board_aliases'))
    ), source_columns(relation, name, type) AS (
      VALUES ('public.user_boards', 'id', 'pg_catalog.int8'), ('public.user_boards', 'gym_id', 'pg_catalog.int8'),
        ('public.gyms', 'id', 'pg_catalog.int8'), ('public.gyms', 'merged_into_gym_id', 'pg_catalog.int8'),
        ('public.gyms', 'deleted_at', 'pg_catalog.timestamp')
    ), source_indexes AS (
      SELECT indexrelid, indclass FROM pg_index WHERE indrelid = to_regclass('public.gyms')
    ), postgis_members(classid, oid) AS (
      SELECT dependency.classid, dependency.objid FROM pg_depend dependency
      JOIN pg_extension extension ON extension.oid = dependency.refobjid
      WHERE dependency.refclassid = 'pg_extension'::regclass AND dependency.deptype = 'e'
        AND extension.extname = 'postgis' AND extension.extnamespace = 'public'::regnamespace
    ), sink_indexes AS (
      SELECT indexrelid, indclass FROM pg_index WHERE indrelid = to_regclass('public.gym_reporting_board_aliases')
    ), expressions(classid, oid) AS (
      SELECT 'pg_attrdef'::regclass, oid FROM pg_attrdef WHERE adrelid = to_regclass('public.gym_reporting_board_aliases')
      UNION ALL SELECT 'pg_constraint'::regclass, oid FROM pg_constraint WHERE conrelid = to_regclass('public.gym_reporting_board_aliases')
      UNION ALL SELECT 'pg_class'::regclass, indexrelid FROM sink_indexes
      UNION ALL SELECT 'pg_class'::regclass, indexrelid FROM source_indexes
    ), reached_types(oid) AS (
      VALUES ('pg_catalog.int8'::regtype), ('pg_catalog.int8[]'::regtype), ('pg_catalog.int4'::regtype),
        ('pg_catalog.timestamp'::regtype), ('pg_catalog.timestamptz'::regtype), ('pg_catalog.text'::regtype)
    )
    SELECT to_regprocedure('public.revoke_gym_reporting_aliases_on_board_move()') IS NOT NULL AS installed,
      (SELECT count(relation.oid) FROM relations JOIN pg_class relation ON relation.oid = relations.oid
        JOIN pg_am method ON method.oid = relation.relam
        WHERE relation.relkind = 'r' AND NOT relation.relrowsecurity AND NOT relation.relforcerowsecurity
          AND NOT relation.relispartition AND method.amname = 'heap') = 3
      AND NOT EXISTS (SELECT 1 FROM pg_inherits WHERE inhrelid IN (SELECT oid FROM relations)
        OR inhparent IN (SELECT oid FROM relations))
      AND NOT EXISTS (SELECT 1 FROM pg_rewrite WHERE ev_class IN (SELECT oid FROM relations) AND rulename <> '_RETURN')
      AND NOT EXISTS (SELECT 1 FROM source_columns source
        WHERE NOT EXISTS (SELECT 1 FROM pg_attribute attribute WHERE attribute.attrelid = to_regclass(source.relation)
          AND attribute.attname = source.name AND attribute.atttypid = to_regtype(source.type)
          AND attribute.attnum > 0 AND NOT attribute.attisdropped AND attribute.attgenerated = ''))
      AND NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = to_regclass('public.gym_reporting_board_aliases')
        AND NOT tgisinternal AND tgenabled <> 'D')
      AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE confrelid = to_regclass('public.gym_reporting_board_aliases'))
      AND NOT EXISTS (SELECT 1 FROM pg_depend dependency JOIN expressions expression
        ON expression.classid = dependency.classid AND expression.oid = dependency.objid
        LEFT JOIN pg_proc routine ON dependency.refclassid = 'pg_proc'::regclass AND routine.oid = dependency.refobjid
        LEFT JOIN pg_operator operator ON dependency.refclassid = 'pg_operator'::regclass AND operator.oid = dependency.refobjid
        WHERE routine.pronamespace <> 'pg_catalog'::regnamespace OR operator.oprnamespace <> 'pg_catalog'::regnamespace)
      AND NOT EXISTS (SELECT 1 FROM sink_indexes index_row CROSS JOIN LATERAL unnest(index_row.indclass) class_oid
        JOIN pg_opclass class ON class.oid = class_oid WHERE class.opcnamespace <> 'pg_catalog'::regnamespace)
      -- Partial index predicates can make an index reachable even when the
      -- trigger does not read its key. Only this exact PostGIS path is reviewed.
      AND NOT EXISTS (SELECT 1 FROM source_indexes index_row JOIN pg_class index_relation ON index_relation.oid = index_row.indexrelid
        JOIN pg_am method ON method.oid = index_relation.relam
        CROSS JOIN LATERAL unnest(index_row.indclass) class_oid JOIN pg_opclass class ON class.oid = class_oid
        JOIN pg_opfamily family ON family.oid = class.opcfamily
        WHERE (
          (method.amname = 'btree' AND method.amhandler::oid = to_regprocedure('pg_catalog.bthandler(internal)')::oid
            AND class.opcnamespace = 'pg_catalog'::regnamespace AND family.opfnamespace = 'pg_catalog'::regnamespace)
          OR (method.amname = 'gist' AND method.amhandler::oid = to_regprocedure('pg_catalog.gisthandler(internal)')::oid
            AND pg_get_indexdef(index_row.indexrelid) = 'CREATE INDEX gyms_location_idx ON public.gyms USING gist (location) WHERE ((deleted_at IS NULL) AND (is_public = true))'
            AND class.opcname = 'gist_geography_ops' AND family.opfname = 'gist_geography_ops'
            AND class.opcnamespace = 'public'::regnamespace AND family.opfnamespace = 'public'::regnamespace
            AND class.opcintype = to_regtype('public.geography')
            AND EXISTS (SELECT 1 FROM postgis_members WHERE classid = 'pg_opclass'::regclass AND oid = class.oid)
            AND EXISTS (SELECT 1 FROM postgis_members WHERE classid = 'pg_opfamily'::regclass AND oid = family.oid)
            AND EXISTS (SELECT 1 FROM postgis_members WHERE classid = 'pg_type'::regclass AND oid = class.opcintype)
            AND NOT EXISTS (SELECT 1 FROM pg_amop family_operator
              WHERE family_operator.amopfamily = family.oid
                AND NOT EXISTS (SELECT 1 FROM postgis_members
                  WHERE classid = 'pg_operator'::regclass AND oid = family_operator.amopopr))
            AND NOT EXISTS (
              SELECT 1 FROM pg_proc routine JOIN pg_language language ON language.oid = routine.prolang
              WHERE routine.oid IN (
                SELECT support.amproc::oid FROM pg_amproc support WHERE support.amprocfamily = family.oid
                UNION ALL SELECT callback.oid FROM pg_amop family_operator JOIN pg_operator operator ON operator.oid = family_operator.amopopr
                  CROSS JOIN LATERAL unnest(ARRAY[operator.oprcode::oid, operator.oprrest::oid, operator.oprjoin::oid]) callback(oid)
                  WHERE family_operator.amopfamily = family.oid
              ) AND routine.pronamespace <> 'pg_catalog'::regnamespace
              AND (language.lanname <> 'c' OR routine.probin IS DISTINCT FROM '$libdir/postgis-3'
                OR NOT EXISTS (SELECT 1 FROM postgis_members WHERE classid = 'pg_proc'::regclass AND oid = routine.oid))
            ))
        ) IS NOT TRUE)
      AND NOT EXISTS (SELECT 1 FROM pg_operator operator WHERE operator.oprnamespace <> 'pg_catalog'::regnamespace
        AND operator.oprname IN ('=', '<>', '<', '||') AND operator.oprleft IN (SELECT oid FROM reached_types)
        AND operator.oprright IN (SELECT oid FROM reached_types))
      AND NOT EXISTS (SELECT 1 FROM pg_cast cast_row JOIN pg_proc routine ON routine.oid = cast_row.castfunc
        WHERE routine.pronamespace <> 'pg_catalog'::regnamespace AND cast_row.castsource IN (SELECT oid FROM reached_types)
        AND cast_row.casttarget IN (SELECT oid FROM reached_types)) AS safe,
      json_build_object(
        'columns', (SELECT json_agg(json_build_array(attribute.attname, format_type(attribute.atttypid, attribute.atttypmod),
            attribute.attnotnull, attribute.attidentity, attribute.attgenerated,
            replace(pg_get_expr(default_row.adbin, default_row.adrelid), 'public.gym_reporting_board_aliases_id_seq', 'gym_reporting_board_aliases_id_seq'))
          ORDER BY attribute.attnum)
          FROM pg_attribute attribute LEFT JOIN pg_attrdef default_row ON default_row.adrelid = attribute.attrelid AND default_row.adnum = attribute.attnum
          WHERE attribute.attrelid = to_regclass('public.gym_reporting_board_aliases') AND attribute.attnum > 0 AND NOT attribute.attisdropped),
        'indexes', (SELECT json_agg(pg_get_indexdef(indexrelid) ORDER BY indexrelid::regclass::text) FROM sink_indexes),
        'constraints', (SELECT json_agg(replace(pg_get_constraintdef(oid), 'REFERENCES public.', 'REFERENCES ') ORDER BY conname)
          FROM pg_constraint WHERE conrelid = to_regclass('public.gym_reporting_board_aliases') AND contype <> 'n')
      ) AS sink`;
  if (!closure) throw new Error('FENCE_EVIDENCE_UNAVAILABLE');
  if (!closure.installed) return;
  // PostgreSQL omits dependencies on pinned builtins from pg_depend. The
  // exact sink shape prevents built-in or extension expressions from being
  // attached to this privileged UPDATE without review.
  const reviewedSink = {
    columns: [
      ['id', 'bigint', true, '', '', "nextval('gym_reporting_board_aliases_id_seq'::regclass)"],
      ['gym_id', 'bigint', true, '', '', null],
      ['board_id', 'bigint', true, '', '', null],
      ['root_board_id', 'bigint', true, '', '', null],
      ['verified_by', 'text', false, '', '', null],
      ['verified_at', 'timestamp with time zone', true, '', '', 'now()'],
      ['revoked_by', 'text', false, '', '', null],
      ['revoked_at', 'timestamp with time zone', false, '', '', null],
    ],
    indexes: [
      'CREATE UNIQUE INDEX gym_reporting_alias_active_board_idx ON public.gym_reporting_board_aliases USING btree (board_id) WHERE (revoked_at IS NULL)',
      'CREATE INDEX gym_reporting_alias_active_root_idx ON public.gym_reporting_board_aliases USING btree (root_board_id) WHERE (revoked_at IS NULL)',
      'CREATE UNIQUE INDEX gym_reporting_board_aliases_pkey ON public.gym_reporting_board_aliases USING btree (id)',
    ],
    constraints: [
      'CHECK ((board_id <> root_board_id))',
      'FOREIGN KEY (board_id) REFERENCES user_boards(id) ON DELETE CASCADE',
      'FOREIGN KEY (gym_id) REFERENCES gyms(id) ON DELETE CASCADE',
      'PRIMARY KEY (id)',
      'FOREIGN KEY (revoked_by) REFERENCES users(id) ON DELETE SET NULL',
      'FOREIGN KEY (root_board_id) REFERENCES user_boards(id) ON DELETE CASCADE',
      'FOREIGN KEY (verified_by) REFERENCES users(id) ON DELETE SET NULL',
    ],
  };
  if (!reviewedAttachment || !closure.safe || JSON.stringify(closure.sink) !== JSON.stringify(reviewedSink)) {
    throw new Error('UNREVIEWED_GYM_REPORTING_ALIAS_CLOSURE');
  }
}

/** Effective ACL checks include PUBLIC, column grants and all memberships (even NOINHERIT SET ROLE). */
export async function verifyFence(client: postgres.Sql | postgres.TransactionSql) {
  const [role] = await client<{ safe: boolean }[]>`
    SELECT NOT rolsuper AND NOT rolcreatedb AND NOT rolcreaterole AND NOT rolreplication AND NOT rolbypassrls AND rolcanlogin
      AND NOT EXISTS (SELECT 1 FROM pg_auth_members WHERE member = role.oid OR roleid = role.oid)
      AND NOT EXISTS (SELECT 1 FROM pg_shdepend WHERE refclassid = 'pg_authid'::regclass AND refobjid = role.oid AND deptype = 'o')
      AND NOT has_database_privilege(role.oid,current_database(),'CREATE')
      AND NOT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname !~ '^pg_' AND nspname <> 'information_schema' AND has_schema_privilege(role.oid,oid,'CREATE'))
      AS safe FROM pg_roles role WHERE rolname = ${WEB_ROLE}`;
  if (!role?.safe) throw new Error('UNSAFE_WEB_ROLE');
  const catalog = await readFenceCatalog(client);
  const relationPrivileges = await client<
    { name: string; kind: string; writes: boolean; unreviewed: boolean; reads: boolean; maintain: boolean }[]
  >`
    SELECT relation.relname AS name, relation.relkind AS kind,
      has_table_privilege(${WEB_ROLE},relation.oid,'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
        OR has_any_column_privilege(${WEB_ROLE},relation.oid,'INSERT,UPDATE,REFERENCES')
        OR CASE WHEN current_setting('server_version_num')::integer >= 170000 THEN has_table_privilege(${WEB_ROLE},relation.oid,'MAINTAIN') ELSE false END AS writes,
      has_table_privilege(${WEB_ROLE},relation.oid,'TRUNCATE,REFERENCES,TRIGGER')
        OR has_any_column_privilege(${WEB_ROLE},relation.oid,'REFERENCES') AS unreviewed,
      has_table_privilege(${WEB_ROLE},relation.oid,'SELECT') OR has_any_column_privilege(${WEB_ROLE},relation.oid,'SELECT') AS reads,
      CASE WHEN current_setting('server_version_num')::integer >= 170000 THEN has_table_privilege(${WEB_ROLE},relation.oid,'MAINTAIN') ELSE false END AS maintain
    FROM pg_class relation JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
    WHERE namespace.nspname !~ '^pg_' AND namespace.nspname <> 'information_schema' AND relation.relkind IN ('r','p','v','m','f')`;
  for (const relation of relationPrivileges) {
    if (GYM_INVENTORY_PRIVATE_TABLES.includes(relation.name) && (relation.reads || relation.writes)) {
      throw new Error('UNREVIEWED_GYM_INVENTORY_PRIVILEGE');
    }
    if ((protectedIdentityTable(relation.name) || !['r', 'p'].includes(relation.kind)) && relation.writes)
      throw new Error('IDENTITY_WRITE_PATH');
    // The plan grants product tables SELECT/INSERT/UPDATE/DELETE only. TRIGGER can
    // attach an existing definer routine, so any of these three fails closed.
    if (relation.unreviewed) throw new Error('UNREVIEWED_TABLE_PRIVILEGE');
    if (relation.maintain) throw new Error('UNREVIEWED_MAINTAIN_PATH');
    if (
      (relation.name === 'auth_session' ||
        BACKEND_ONLY_PARTNER_TABLES.includes(relation.name) ||
        ['v', 'm', 'f'].includes(relation.kind)) &&
      relation.reads
    )
      throw new Error('UNREVIEWED_READ_PATH');
  }
  const sequencePrivileges = await client<
    { name: string; owner: string | null; usable: boolean; readable: boolean; settable: boolean }[]
  >`
    SELECT relation.relname AS name, (SELECT owning.relname FROM pg_depend dependency JOIN pg_class owning ON owning.oid = dependency.refobjid
        WHERE dependency.classid = 'pg_class'::regclass AND dependency.objid = relation.oid
          AND dependency.refclassid = 'pg_class'::regclass AND dependency.deptype IN ('a','i') LIMIT 1) AS owner,
      has_sequence_privilege(${WEB_ROLE},relation.oid,'USAGE,UPDATE') AS usable,
      has_sequence_privilege(${WEB_ROLE},relation.oid,'SELECT') AS readable,
      has_sequence_privilege(${WEB_ROLE},relation.oid,'UPDATE') AS settable
    FROM pg_class relation JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
    WHERE namespace.nspname !~ '^pg_' AND namespace.nspname <> 'information_schema' AND relation.relkind = 'S'`;
  for (const sequence of sequencePrivileges) {
    if (sequence.name === SPRAY_EXPOSURE_EVENT_SEQUENCE && (sequence.usable || sequence.readable)) {
      throw new Error('UNREVIEWED_GYM_INVENTORY_PRIVILEGE');
    }
    if (sequence.owner && protectedIdentityTable(sequence.owner) && sequence.usable)
      throw new Error('IDENTITY_SEQUENCE_PATH');
    // setval is never granted: it can make another writer's nextval collide.
    if (sequence.settable) throw new Error('UNREVIEWED_SEQUENCE_PRIVILEGE');
  }
  const triggerFunctions = await client<
    {
      schema: string;
      relationSchema: string;
      relation: string;
      routine: string;
      source: string;
      configuration: string[];
      language: string;
      triggerName: string;
      triggerType: number;
      enabled: string;
      deferred: boolean;
      updateColumns: string[];
    }[]
  >`
    SELECT namespace.nspname AS schema, relation_namespace.nspname AS "relationSchema", relation.relname AS relation, routine.proname AS routine,
      routine.prosrc AS source, to_json(routine.proconfig) AS configuration, language.lanname AS language,
      trigger.tgname AS "triggerName", trigger.tgtype::integer AS "triggerType", trigger.tgenabled AS enabled,
      trigger.tgdeferrable AND trigger.tginitdeferred AS deferred,
      to_json(ARRAY(SELECT attribute.attname FROM unnest(trigger.tgattr::smallint[]) WITH ORDINALITY AS update_col(attnum, position)
        JOIN pg_attribute attribute ON attribute.attrelid = trigger.tgrelid AND attribute.attnum = update_col.attnum
        ORDER BY update_col.position)) AS "updateColumns"
    FROM pg_trigger trigger JOIN pg_proc routine ON routine.oid = trigger.tgfoid
    JOIN pg_namespace namespace ON namespace.oid = routine.pronamespace
    JOIN pg_class relation ON relation.oid = trigger.tgrelid
    JOIN pg_namespace relation_namespace ON relation_namespace.oid = relation.relnamespace
    JOIN pg_language language ON language.oid = routine.prolang
    WHERE NOT trigger.tgisinternal AND trigger.tgenabled <> 'D' AND routine.prosecdef
      AND has_table_privilege(${WEB_ROLE},trigger.tgrelid,'INSERT,UPDATE,DELETE')`;
  // No names-only allowlist. Drift in body, language, search_path or attachment
  // fails closed. The board move trigger writes only the reporting alias audit
  // and checks fully qualified gyms. Its catalog-only path resolves built-ins.
  const reviewedTriggers: Readonly<
    Record<
      string,
      {
        relation: string | readonly string[];
        sha256: string;
        configuration?: readonly string[];
        attachment?: { name: string; type: number; deferred: boolean; columns: readonly string[] };
      }
    >
  > = {
    revoke_gym_reporting_aliases_on_board_move: {
      relation: 'user_boards',
      sha256: 'f645b67ae38be89b9af89bf000c68336c1d24e85e2335a32ecc79eebfddab243',
      configuration: ['search_path=pg_catalog'],
      // PostgreSQL's row (1) and UPDATE (16) flags, with no BEFORE flag.
      attachment: { name: 'trg_gym_reporting_aliases_board_move', type: 17, deferred: true, columns: ['gym_id'] },
    },
    log_partner_session_from_session: {
      relation: 'board_sessions',
      sha256: '53477df49c5493dcd817d6a9e39925d9921a4810ef907fd7170e6d89fb5cc2ea',
    },
    log_partner_session_from_participant: {
      relation: 'board_session_participants',
      sha256: '7d54e376ddd7eb3fdd73a0338549eaad2b3c3063b1994eff0c91e3982f90fd6e',
    },
    log_partner_session_from_workout: {
      relation: ['session_workouts', 'app_workouts'],
      sha256: 'e5a2558e755b2f57b671098c963aaac41e8e269c6d09fc296e8660612f9f2e0a',
    },
    log_partner_session_from_tick: {
      relation: 'boardsesh_ticks',
      sha256: '4b549a86f70e61307fb20f238ca2f4bc936c71cc75937f1d4b0c93bb948f098f',
    },
    log_partner_session_from_alias: {
      relation: 'board_climb_aliases',
      sha256: '50fdf38e8303f988e50d49fd208ee2ce7996f956e30f878171b81ee2d13476e2',
    },
    log_logbook_change_from_tick: {
      relation: 'boardsesh_ticks',
      sha256: '361b86ed76200a34a4950e9b882ba700f43396dfbb2a246d778ec146805ef068',
    },
    log_logbook_change_from_alias: {
      relation: 'board_climb_aliases',
      sha256: '6a594cadf5b21735e2cacb4c51860503c4ad2b54911354184725a87f67230c1b',
    },
  };
  const verifiedExposure = await verifySprayExposureClosure(client, WEB_ROLE);
  for (const trigger of triggerFunctions) {
    // This exact identity was verified alongside its helper, source and sink
    // closure above. The public schema and ordinary role checks still apply.
    if (
      trigger.schema === 'public' &&
      verifiedExposure.has(
        sprayExposureTriggerIdentity(trigger.relationSchema, trigger.relation, trigger.triggerName, trigger.routine),
      )
    )
      continue;
    const reviewed = reviewedTriggers[trigger.routine];
    if (
      !reviewed ||
      trigger.schema !== 'public' ||
      trigger.relationSchema !== 'public' ||
      !(typeof reviewed.relation === 'string' ? [reviewed.relation] : reviewed.relation).includes(trigger.relation) ||
      trigger.language !== 'plpgsql' ||
      JSON.stringify(trigger.configuration) !==
        JSON.stringify(reviewed.configuration ?? ['search_path=public, pg_catalog']) ||
      createHash('sha256').update(trigger.source).digest('hex') !== reviewed.sha256 ||
      (reviewed.attachment &&
        (trigger.triggerName !== reviewed.attachment.name ||
          trigger.triggerType !== reviewed.attachment.type ||
          trigger.enabled !== 'O' ||
          trigger.deferred !== reviewed.attachment.deferred ||
          JSON.stringify(trigger.updateColumns) !== JSON.stringify(reviewed.attachment.columns)))
    )
      throw new Error('UNREVIEWED_TRIGGER_PATH');
  }
  await verifyGymReportingAliasClosure(
    client,
    triggerFunctions.some((trigger) => trigger.routine === 'revoke_gym_reporting_aliases_on_board_move'),
  );
  const enumTypes = await client<{ name: string; labels: string[]; safe: boolean }[]>`
    SELECT type.typname AS name, to_json(ARRAY(SELECT enumlabel FROM pg_enum WHERE enumtypid=type.oid ORDER BY enumsortorder)) AS labels,
      type.typtype='e' AND type.typinput='pg_catalog.enum_in'::regproc AND type.typoutput='pg_catalog.enum_out'::regproc
      AND type.typreceive='pg_catalog.enum_recv'::regproc AND type.typsend='pg_catalog.enum_send'::regproc AS safe
    FROM pg_type type JOIN pg_namespace namespace ON namespace.oid=type.typnamespace
    WHERE namespace.nspname='public' AND type.typname IN ('tick_status','aurora_table_type','kilter_table_type','tick_origin') ORDER BY type.typname`;
  const expectedEnums = [
    { name: 'aurora_table_type', labels: ['ascents', 'bids'], safe: true },
    { name: 'kilter_table_type', labels: ['logs', 'attempts'], safe: true },
    {
      name: 'tick_origin',
      labels: ['native', 'aurora_pull', 'kilter_pull', 'json_import', 'moonboard_import'],
      safe: true,
    },
    { name: 'tick_status', labels: ['flash', 'send', 'attempt'], safe: true },
  ];
  if (JSON.stringify([...enumTypes]) !== JSON.stringify(expectedEnums)) throw new Error('UNREVIEWED_SOURCE_TYPES');
  const [closure] = await client<
    { safe: boolean; sink: { columns: unknown; indexes: unknown; constraints: unknown } }[]
  >`
    SELECT NOT EXISTS (
      SELECT 1 FROM pg_class relation JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
      LEFT JOIN pg_am method ON method.oid = relation.relam
      WHERE namespace.nspname = 'public' AND relation.relname IN ('logbook_changes','boardsesh_ticks','board_climb_aliases','logbook_session_changes','board_sessions','board_session_participants','session_workouts','app_workouts')
        AND (relation.relkind <> 'r' OR relation.relrowsecurity OR relation.relforcerowsecurity OR relation.relispartition OR method.amname <> 'heap'
          OR EXISTS (SELECT 1 FROM pg_inherits WHERE inhrelid = relation.oid OR inhparent = relation.oid)
          OR EXISTS (SELECT 1 FROM pg_attribute attribute JOIN pg_type type ON type.oid = attribute.atttypid
            JOIN pg_namespace type_namespace ON type_namespace.oid = type.typnamespace
            WHERE attribute.attrelid = relation.oid AND attribute.attnum > 0 AND NOT attribute.attisdropped
              AND ((type_namespace.nspname <> 'pg_catalog' AND NOT (type_namespace.nspname = 'public' AND type.typtype = 'e' AND type.typname IN ('tick_status','aurora_table_type','kilter_table_type','tick_origin','session_origin'))) OR type.typtype = 'd' OR attribute.attgenerated <> ''))
          OR EXISTS (SELECT 1 FROM pg_index index_row CROSS JOIN LATERAL unnest(index_row.indclass) class_oid
            JOIN pg_opclass class ON class.oid = class_oid JOIN pg_namespace class_namespace ON class_namespace.oid = class.opcnamespace
            WHERE index_row.indrelid = relation.oid AND class_namespace.nspname <> 'pg_catalog')
          OR EXISTS (SELECT 1 FROM pg_depend dependency JOIN pg_proc routine ON routine.oid = dependency.refobjid
            JOIN pg_namespace routine_namespace ON routine_namespace.oid = routine.pronamespace
            WHERE dependency.refclassid = 'pg_proc'::regclass AND routine_namespace.nspname <> 'pg_catalog'
              AND dependency.objid IN (SELECT indexrelid FROM pg_index WHERE indrelid = relation.oid)))
    ) AND NOT EXISTS (
      SELECT 1 FROM pg_operator operator JOIN pg_namespace namespace ON namespace.oid = operator.oprnamespace
      JOIN pg_type left_type ON left_type.oid = operator.oprleft JOIN pg_type right_type ON right_type.oid = operator.oprright
      -- The SHA-pinned 0298 bodies use only these comparison operators.
      WHERE namespace.nspname = 'public' AND operator.oprname IN ('=','<>','!~~','~~')
        AND left_type.oid IN (SELECT atttypid FROM pg_attribute WHERE attrelid IN (to_regclass('public.boardsesh_ticks'),to_regclass('public.logbook_changes'),to_regclass('public.board_climb_aliases'),to_regclass('public.logbook_session_changes'),to_regclass('public.board_sessions'),to_regclass('public.board_session_participants'),to_regclass('public.session_workouts'),to_regclass('public.app_workouts')) AND attnum>0 AND NOT attisdropped)
        AND right_type.oid IN (SELECT atttypid FROM pg_attribute WHERE attrelid IN (to_regclass('public.boardsesh_ticks'),to_regclass('public.logbook_changes'),to_regclass('public.board_climb_aliases'),to_regclass('public.logbook_session_changes'),to_regclass('public.board_sessions'),to_regclass('public.board_session_participants'),to_regclass('public.session_workouts'),to_regclass('public.app_workouts')) AND attnum>0 AND NOT attisdropped)
    ) AND NOT EXISTS (
      SELECT 1 FROM pg_cast cast_row JOIN pg_proc routine ON routine.oid = cast_row.castfunc
      JOIN pg_namespace namespace ON namespace.oid = routine.pronamespace WHERE namespace.nspname <> 'pg_catalog'
        AND cast_row.castsource IN (SELECT atttypid FROM pg_attribute WHERE attrelid IN (to_regclass('public.boardsesh_ticks'),to_regclass('public.logbook_changes'),to_regclass('public.board_climb_aliases'),to_regclass('public.logbook_session_changes'),to_regclass('public.board_sessions'),to_regclass('public.board_session_participants'),to_regclass('public.session_workouts'),to_regclass('public.app_workouts')) AND attnum>0 AND NOT attisdropped)
        AND cast_row.casttarget IN (SELECT atttypid FROM pg_attribute WHERE attrelid IN (to_regclass('public.boardsesh_ticks'),to_regclass('public.logbook_changes'),to_regclass('public.board_climb_aliases'),to_regclass('public.logbook_session_changes'),to_regclass('public.board_sessions'),to_regclass('public.board_session_participants'),to_regclass('public.session_workouts'),to_regclass('public.app_workouts')) AND attnum>0 AND NOT attisdropped)
    ) AS safe,
    json_build_object(
      'columns',(SELECT json_agg(json_build_array(attribute.attname,format_type(attribute.atttypid,attribute.atttypmod),attribute.attnotnull,attribute.attidentity,attribute.attgenerated,pg_get_expr(default_row.adbin,default_row.adrelid)) ORDER BY attribute.attnum)
        FROM pg_attribute attribute LEFT JOIN pg_attrdef default_row ON default_row.adrelid=attribute.attrelid AND default_row.adnum=attribute.attnum
        WHERE attribute.attrelid='public.logbook_changes'::regclass AND attribute.attnum>0 AND NOT attribute.attisdropped),
      'indexes',(SELECT json_agg(pg_get_indexdef(indexrelid) ORDER BY indexrelid::regclass::text) FROM pg_index WHERE indrelid='public.logbook_changes'::regclass),
      'constraints',(SELECT json_agg(pg_get_constraintdef(oid) ORDER BY conname) FROM pg_constraint WHERE conrelid='public.logbook_changes'::regclass AND contype <> 'n')
    ) AS sink`;
  const expectedSink = {
    columns: [
      ['seq', 'bigint', true, '', '', "nextval('logbook_changes_seq_seq'::regclass)"],
      ['txid', 'xid8', true, '', '', 'pg_current_xact_id()'],
      ['user_id', 'text', true, '', '', null],
      ['tick_uuid', 'text', true, '', '', null],
      ['created_at', 'timestamp without time zone', true, '', '', 'now()'],
    ],
    indexes: [
      'CREATE INDEX logbook_changes_created_at_brin_idx ON public.logbook_changes USING brin (created_at)',
      'CREATE INDEX logbook_changes_global_position_idx ON public.logbook_changes USING btree (txid, seq)',
      'CREATE UNIQUE INDEX logbook_changes_pkey ON public.logbook_changes USING btree (seq)',
      'CREATE INDEX logbook_changes_user_position_idx ON public.logbook_changes USING btree (user_id, txid, seq)',
    ],
    constraints: ['PRIMARY KEY (seq)'],
  };
  // Both reviewed shapes have identical privilege-bearing columns and constraints.
  // The only difference is the plain read index added for milestone 4; historic
  // credential proof fixtures intentionally predate it.
  const historicalSink = {
    ...expectedSink,
    indexes: expectedSink.indexes.filter(
      (definition) => !definition.startsWith('CREATE INDEX logbook_changes_global_position_idx '),
    ),
  };
  if (
    !closure?.safe ||
    (JSON.stringify(closure.sink) !== JSON.stringify(expectedSink) &&
      JSON.stringify(closure.sink) !== JSON.stringify(historicalSink))
  )
    throw new Error('UNREVIEWED_LOGBOOK_SINK');
  // The optional companion sink is absent in historical credential fixtures.
  // Its shape and complete executable closure are pinned when it exists.
  const [sessionSink] = await client<
    { present: boolean; safe: boolean; columns: unknown; indexes: unknown; constraints: unknown }[]
  >`
    SELECT to_regclass('public.logbook_session_changes') IS NOT NULL AS present,
      NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid=to_regclass('public.logbook_session_changes') AND NOT tgisinternal AND tgenabled<>'D')
      AND NOT EXISTS (SELECT 1 FROM pg_rewrite WHERE ev_class=to_regclass('public.logbook_session_changes') AND rulename<>'_RETURN')
      AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE confrelid=to_regclass('public.logbook_session_changes'))
      AND NOT EXISTS (SELECT 1 FROM pg_depend dependency JOIN pg_proc routine ON routine.oid=dependency.refobjid
        JOIN pg_namespace namespace ON namespace.oid=routine.pronamespace
        WHERE dependency.refclassid='pg_proc'::regclass AND namespace.nspname<>'pg_catalog'
          AND (dependency.objid IN (SELECT oid FROM pg_attrdef WHERE adrelid=to_regclass('public.logbook_session_changes'))
            OR dependency.objid IN (SELECT oid FROM pg_constraint WHERE conrelid=to_regclass('public.logbook_session_changes'))
            OR dependency.objid IN (SELECT indexrelid FROM pg_index WHERE indrelid=to_regclass('public.logbook_session_changes')))) AS safe,
      (SELECT json_agg(json_build_array(attribute.attname,format_type(attribute.atttypid,attribute.atttypmod),attribute.attnotnull,attribute.attidentity,attribute.attgenerated,pg_get_expr(default_row.adbin,default_row.adrelid)) ORDER BY attribute.attnum)
        FROM pg_attribute attribute LEFT JOIN pg_attrdef default_row ON default_row.adrelid=attribute.attrelid AND default_row.adnum=attribute.attnum
        WHERE attribute.attrelid=to_regclass('public.logbook_session_changes') AND attribute.attnum>0 AND NOT attribute.attisdropped) AS columns,
      (SELECT json_agg(pg_get_indexdef(indexrelid) ORDER BY indexrelid::regclass::text) FROM pg_index WHERE indrelid=to_regclass('public.logbook_session_changes')) AS indexes,
      (SELECT json_agg(pg_get_constraintdef(oid) ORDER BY conname) FROM pg_constraint WHERE conrelid=to_regclass('public.logbook_session_changes') AND contype<>'n') AS constraints`;
  if (
    sessionSink?.present &&
    (!sessionSink.safe ||
      JSON.stringify({
        columns: sessionSink.columns,
        indexes: sessionSink.indexes,
        constraints: sessionSink.constraints,
      }) !==
        JSON.stringify({
          columns: [
            ['seq', 'bigint', true, '', '', "nextval('logbook_changes_seq_seq'::regclass)"],
            ['txid', 'xid8', true, '', '', 'pg_current_xact_id()'],
            ['user_id', 'text', true, '', '', null],
            ['session_export_id', 'uuid', true, '', '', null],
            ['created_at', 'timestamp without time zone', true, '', '', 'now()'],
            ['remove_if_missing', 'boolean', true, '', '', 'false'],
          ],
          indexes: [
            'CREATE INDEX logbook_session_changes_global_position_idx ON public.logbook_session_changes USING btree (txid, seq)',
            'CREATE UNIQUE INDEX logbook_session_changes_pkey ON public.logbook_session_changes USING btree (seq)',
            'CREATE INDEX logbook_session_changes_user_position_idx ON public.logbook_session_changes USING btree (user_id, txid, seq)',
          ],
          constraints: ['PRIMARY KEY (seq)'],
        }))
  )
    throw new Error('UNREVIEWED_SESSION_LOGBOOK_SINK');
  const [paths] = await client<
    { cascade: boolean; routine: boolean; defaults: boolean; trigger: boolean; rule: boolean }[]
  >`
    WITH RECURSIVE cascading(target, source) AS (
      SELECT conrelid, confrelid FROM pg_constraint WHERE contype = 'f' AND (confdeltype IN ('c','n','d') OR confupdtype IN ('c','n','d'))
      UNION SELECT cascading.target, constraint_row.confrelid FROM cascading JOIN pg_constraint constraint_row ON constraint_row.conrelid = cascading.source
        WHERE constraint_row.contype = 'f' AND (constraint_row.confdeltype IN ('c','n','d') OR constraint_row.confupdtype IN ('c','n','d'))
    )
    SELECT EXISTS (
      SELECT 1 FROM cascading JOIN pg_class identity_table ON identity_table.oid = cascading.target
      WHERE (identity_table.relname ~ '^(auth_|oauth_)' OR identity_table.relname IN (SELECT jsonb_array_elements_text(${JSON.stringify(NAMED_IDENTITY_TABLES)}::text::jsonb)))
        AND has_table_privilege(${WEB_ROLE}, cascading.source, 'UPDATE,DELETE')
    ) AS cascade, EXISTS (
      SELECT 1 FROM pg_proc routine JOIN pg_namespace namespace ON namespace.oid = routine.pronamespace
      WHERE namespace.nspname !~ '^pg_' AND namespace.nspname <> 'information_schema'
        AND routine.prosecdef AND has_function_privilege(${WEB_ROLE},routine.oid,'EXECUTE')
    ) OR EXISTS (
      SELECT 1 FROM pg_proc routine JOIN pg_namespace namespace ON namespace.oid=routine.pronamespace
      CROSS JOIN LATERAL aclexplode(routine.proacl) acl
      WHERE namespace.nspname='pg_catalog' AND acl.grantee=(SELECT oid FROM pg_roles WHERE rolname=${WEB_ROLE})
    ) AS routine, EXISTS (
      SELECT 1 FROM pg_default_acl defaults CROSS JOIN LATERAL aclexplode(defaults.defaclacl) acl
      WHERE acl.grantee IN (0, (SELECT oid FROM pg_roles WHERE rolname = ${WEB_ROLE}))
        AND defaults.defaclobjtype IN ('r','f','S')
    ) OR EXISTS (
      SELECT 1 FROM pg_roles owner WHERE owner.rolname IN (SELECT jsonb_array_elements_text(${JSON.stringify(catalog.owners)}::text::jsonb))
        AND NOT EXISTS (SELECT 1 FROM pg_default_acl defaults WHERE defaults.defaclrole=owner.oid AND defaults.defaclobjtype='f' AND defaults.defaclnamespace=0)
    ) AS defaults, EXISTS (
      SELECT 1 FROM pg_trigger trigger WHERE trigger.tgrelid = 'public.logbook_changes'::regclass
        AND NOT trigger.tgisinternal AND trigger.tgenabled <> 'D'
    ) OR EXISTS (
      SELECT 1 FROM pg_rewrite rule WHERE rule.ev_class = 'public.logbook_changes'::regclass AND rule.rulename <> '_RETURN'
    ) OR EXISTS (
      SELECT 1 FROM pg_depend dependency JOIN pg_proc routine ON routine.oid = dependency.refobjid
      JOIN pg_namespace namespace ON namespace.oid = routine.pronamespace
      WHERE dependency.refclassid = 'pg_proc'::regclass AND namespace.nspname <> 'pg_catalog'
        AND (dependency.objid IN (SELECT oid FROM pg_attrdef WHERE adrelid = 'public.logbook_changes'::regclass)
          OR dependency.objid IN (SELECT oid FROM pg_constraint WHERE conrelid = 'public.logbook_changes'::regclass)
          OR dependency.objid IN (SELECT indexrelid FROM pg_index WHERE indrelid = 'public.logbook_changes'::regclass))
    ) AS trigger, EXISTS (
      SELECT 1 FROM pg_rewrite rule JOIN pg_class relation ON relation.oid = rule.ev_class
      JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
      WHERE namespace.nspname !~ '^pg_' AND namespace.nspname <> 'information_schema' AND rule.rulename <> '_RETURN' AND has_table_privilege(${WEB_ROLE},relation.oid,'INSERT,UPDATE,DELETE')
    ) AS rule`;
  if (!paths) throw new Error('FENCE_EVIDENCE_UNAVAILABLE');
  for (const [path, unsafe] of Object.entries(paths))
    if (unsafe) throw new Error(`UNREVIEWED_${path.toUpperCase()}_PATH`);
  const [cutoff] = await client<
    { readable: boolean }[]
  >`SELECT has_table_privilege(${WEB_ROLE},'public.auth_subject_cutoffs','SELECT') AS readable`;
  if (!cutoff?.readable) throw new Error('CUTOFF_READ_REQUIRED');
  const [sessionDenials] = await client<
    { readable: boolean }[]
  >`SELECT has_table_privilege(${WEB_ROLE},'public.auth_session_denials','SELECT') AS readable`;
  if (!sessionDenials?.readable) throw new Error('SESSION_DENIAL_READ_REQUIRED');
  return { role: WEB_ROLE, verified: true as const, catalogSha256: fencePlan(catalog).sha256 };
}

/** How long a migration's web reconcile waits for the fence lock; the same bound `auth:fence apply` uses. */
export const WEB_FENCE_LOCK_TIMEOUT = '2000ms';

/** Called inside the migration owner's transaction after the broad backend grants. */
export async function reconcileWebRuntimeAcl(client: postgres.Sql | postgres.TransactionSql, ddlOwner: string) {
  // Waits for a running `auth:fence apply`; both hold it until their transaction ends.
  // Bounded, so an apply left idle in its transaction fails the migration in
  // seconds instead of holding it to the job timeout. The session's own
  // lock_timeout comes back afterwards for the grant statements below.
  const [previous] = await client<{ value: string }[]>`SELECT current_setting('lock_timeout') AS value`;
  await client`SELECT set_config('lock_timeout', ${WEB_FENCE_LOCK_TIMEOUT}, true)`;
  try {
    await client.unsafe(WEB_FENCE_LOCK_SQL);
  } catch (error) {
    if ((error as { code?: unknown } | null)?.code !== '55P03') throw error;
    throw Object.assign(
      new Error(
        `Web reconcile could not take the BA-04 fence lock (6975, 3) within ${WEB_FENCE_LOCK_TIMEOUT}. ` +
          'Most likely an `auth:fence apply` is open or idle in its transaction; end it and rerun the migration.',
        { cause: error },
      ),
      { code: '55P03' },
    );
  }
  await client`SELECT set_config('lock_timeout', ${previous?.value ?? '0'}, true)`;
  const plan = fencePlan(await readFenceCatalog(client), { ddlOwner });
  await client.unsafe(plan.sql);
  return verifyFence(client);
}
