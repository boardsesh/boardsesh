import type postgres from 'postgres';
import { createHash } from 'node:crypto';

export const WEB_ROLE = 'boardsesh_web';
export const quoteIdentifier = (identifier: string) => `"${identifier.replaceAll('"', '""')}"`;
export function protectedIdentityTable(name: string): boolean {
  return (
    /^(auth_|oauth_)/.test(name) ||
    [
      'users',
      'accounts',
      'sessions',
      'verificationTokens',
      'user_credentials',
      'mobile_refresh_tokens',
      'integration_credentials',
    ].includes(name)
  );
}
export interface FenceRelation {
  schema: string;
  name: string;
  kind: string;
  columns: string[];
  owner?: string;
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
      to_json(ARRAY(SELECT attname FROM pg_attribute WHERE attrelid = relation.oid AND attnum > 0 AND NOT attisdropped ORDER BY attnum)) AS columns
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
      apply.push(
        `REVOKE ALL ON SEQUENCE ${target} FROM PUBLIC, ${role};`,
        `GRANT USAGE ON SEQUENCE ${target} TO ${role};`,
      );
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
  const relationPrivileges = await client<{ name: string; kind: string; writes: boolean; reads: boolean }[]>`
    SELECT relation.relname AS name, relation.relkind AS kind,
      has_table_privilege(${WEB_ROLE},relation.oid,'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
        OR has_any_column_privilege(${WEB_ROLE},relation.oid,'INSERT,UPDATE,REFERENCES') AS writes,
      has_table_privilege(${WEB_ROLE},relation.oid,'SELECT') OR has_any_column_privilege(${WEB_ROLE},relation.oid,'SELECT') AS reads
    FROM pg_class relation JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
    WHERE namespace.nspname !~ '^pg_' AND namespace.nspname <> 'information_schema' AND relation.relkind IN ('r','p','v','m','f')`;
  for (const relation of relationPrivileges) {
    if ((protectedIdentityTable(relation.name) || !['r', 'p'].includes(relation.kind)) && relation.writes)
      throw new Error('IDENTITY_WRITE_PATH');
    if ((relation.name === 'auth_session' || ['v', 'm', 'f'].includes(relation.kind)) && relation.reads)
      throw new Error('UNREVIEWED_READ_PATH');
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
    }[]
  >`
    SELECT namespace.nspname AS schema, relation_namespace.nspname AS "relationSchema", relation.relname AS relation, routine.proname AS routine,
      routine.prosrc AS source, to_json(routine.proconfig) AS configuration, language.lanname AS language
    FROM pg_trigger trigger JOIN pg_proc routine ON routine.oid = trigger.tgfoid
    JOIN pg_namespace namespace ON namespace.oid = routine.pronamespace
    JOIN pg_class relation ON relation.oid = trigger.tgrelid
    JOIN pg_namespace relation_namespace ON relation_namespace.oid = relation.relnamespace
    JOIN pg_language language ON language.oid = routine.prolang
    WHERE NOT trigger.tgisinternal AND trigger.tgenabled <> 'D' AND routine.prosecdef
      AND has_table_privilege(${WEB_ROLE},trigger.tgrelid,'INSERT,UPDATE,DELETE')`;
  // Reviewed 0298 bodies write only logbook_changes and read ticks. No names-only
  // allowlist: drift in body, language, search_path or attachment fails closed.
  const reviewedTriggers: Readonly<Record<string, { relation: string; sha256: string }>> = {
    log_logbook_change_from_tick: {
      relation: 'boardsesh_ticks',
      sha256: '361b86ed76200a34a4950e9b882ba700f43396dfbb2a246d778ec146805ef068',
    },
    log_logbook_change_from_alias: {
      relation: 'board_climb_aliases',
      sha256: '6a594cadf5b21735e2cacb4c51860503c4ad2b54911354184725a87f67230c1b',
    },
  };
  for (const trigger of triggerFunctions) {
    const reviewed = reviewedTriggers[trigger.routine];
    if (
      !reviewed ||
      trigger.schema !== 'public' ||
      trigger.relationSchema !== 'public' ||
      trigger.relation !== reviewed.relation ||
      trigger.language !== 'plpgsql' ||
      JSON.stringify(trigger.configuration) !== JSON.stringify(['search_path=public, pg_catalog']) ||
      createHash('sha256').update(trigger.source).digest('hex') !== reviewed.sha256
    )
      throw new Error('UNREVIEWED_TRIGGER_PATH');
  }
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
      WHERE namespace.nspname = 'public' AND relation.relname IN ('logbook_changes','boardsesh_ticks','board_climb_aliases')
        AND (relation.relkind <> 'r' OR relation.relrowsecurity OR relation.relforcerowsecurity OR relation.relispartition OR method.amname <> 'heap'
          OR EXISTS (SELECT 1 FROM pg_inherits WHERE inhrelid = relation.oid OR inhparent = relation.oid)
          OR EXISTS (SELECT 1 FROM pg_attribute attribute JOIN pg_type type ON type.oid = attribute.atttypid
            JOIN pg_namespace type_namespace ON type_namespace.oid = type.typnamespace
            WHERE attribute.attrelid = relation.oid AND attribute.attnum > 0 AND NOT attribute.attisdropped
              AND ((type_namespace.nspname <> 'pg_catalog' AND NOT (type_namespace.nspname = 'public' AND type.typtype = 'e' AND type.typname IN ('tick_status','aurora_table_type','kilter_table_type','tick_origin'))) OR type.typtype = 'd' OR attribute.attgenerated <> ''))
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
        AND left_type.oid IN (SELECT atttypid FROM pg_attribute WHERE attrelid IN ('public.boardsesh_ticks'::regclass,'public.logbook_changes'::regclass,'public.board_climb_aliases'::regclass) AND attnum>0 AND NOT attisdropped)
        AND right_type.oid IN (SELECT atttypid FROM pg_attribute WHERE attrelid IN ('public.boardsesh_ticks'::regclass,'public.logbook_changes'::regclass,'public.board_climb_aliases'::regclass) AND attnum>0 AND NOT attisdropped)
    ) AND NOT EXISTS (
      SELECT 1 FROM pg_cast cast_row JOIN pg_proc routine ON routine.oid = cast_row.castfunc
      JOIN pg_namespace namespace ON namespace.oid = routine.pronamespace WHERE namespace.nspname <> 'pg_catalog'
        AND cast_row.castsource IN (SELECT atttypid FROM pg_attribute WHERE attrelid IN ('public.boardsesh_ticks'::regclass,'public.logbook_changes'::regclass,'public.board_climb_aliases'::regclass) AND attnum>0 AND NOT attisdropped)
        AND cast_row.casttarget IN (SELECT atttypid FROM pg_attribute WHERE attrelid IN ('public.boardsesh_ticks'::regclass,'public.logbook_changes'::regclass,'public.board_climb_aliases'::regclass) AND attnum>0 AND NOT attisdropped)
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
      'CREATE UNIQUE INDEX logbook_changes_pkey ON public.logbook_changes USING btree (seq)',
      'CREATE INDEX logbook_changes_user_position_idx ON public.logbook_changes USING btree (user_id, txid, seq)',
    ],
    constraints: ['PRIMARY KEY (seq)'],
  };
  if (!closure?.safe || JSON.stringify(closure.sink) !== JSON.stringify(expectedSink))
    throw new Error('UNREVIEWED_LOGBOOK_SINK');
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
      WHERE (identity_table.relname ~ '^(auth_|oauth_)' OR identity_table.relname IN ('users','accounts','sessions','verificationTokens','user_credentials','mobile_refresh_tokens','integration_credentials'))
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
  return { role: WEB_ROLE, verified: true as const, catalogSha256: fencePlan(catalog).sha256 };
}

/** Called inside the migration owner's transaction after the broad backend grants. */
export async function reconcileWebRuntimeAcl(client: postgres.Sql | postgres.TransactionSql, ddlOwner: string) {
  const plan = fencePlan(await readFenceCatalog(client), { ddlOwner });
  await client.unsafe(plan.sql);
  return verifyFence(client);
}
