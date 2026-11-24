import { createHash } from 'node:crypto';
import type postgres from 'postgres';

type CatalogClient = postgres.Sql | postgres.TransactionSql;

export const GYM_INVENTORY_PRIVATE_TABLES: readonly string[] = Object.freeze([
  'gym_board_grade_collections',
  'spray_exposure_invalidations',
  'spray_exposure_observations',
  'spray_exposure_checkpoints',
]);
export const SPRAY_EXPOSURE_EVENT_SEQUENCE = 'spray_exposure_event_seq';

// Exact executable contract of the 0338 migration, including the two
// SECURITY INVOKER SQL helpers. An additional overload can redirect a helper
// call, so the manifest also requires an exact set of public signatures.
const routines = {
  spray_exposure_fence_key: {
    args: ['text', 'text'],
    names: ['dependency', 'source_key'],
    result: 'bigint',
    hash: '782afb2ef7ae95d0bbcda14fb751dfc513bc151b9672a64467bd761816b31450',
  },
  spray_exposure_climb_key: {
    args: ['integer', 'text'],
    names: ['layout_id', 'climb_uuid'],
    result: 'text',
    hash: '6262f71d6981882436c3dcd74eb6395062facea8d5aa1a9171bdab0e5d2c1cf2',
  },
  spray_exposure_invalidate: {
    args: ['text', 'text', 'text'],
    names: ['dependency', 'source_key', 'fence_key'],
    result: 'void',
    hash: 'cdcefdcfc4b533cc754027363a24d0bf4c49b28a155a45ae313e20825437bcc0',
  },
  spray_exposure_policy_invalidate: {
    args: ['text'],
    names: ['board_uuid'],
    result: 'void',
    hash: '2e8da52b226a2478ed6dfec747d7a75a50e273694323b9af98ca4d44d38c6396',
  },
  spray_exposure_board_change: {
    args: [],
    names: [],
    result: 'trigger',
    hash: 'a5b9a6a15fa9b642b3a82d0557a8ea509fbb52e42a59386342a05a07e5161cbd',
  },
  spray_exposure_wall_change: {
    args: [],
    names: [],
    result: 'trigger',
    hash: '60827d130962aa8daa73ffbdb838c44d643a99ac25c19d1c7f47b1453adc8b42',
  },
  spray_exposure_version_change: {
    args: [],
    names: [],
    result: 'trigger',
    hash: '8d4162050782726866cdb54d9715ba184eb772404ad393b356e4c0fe8f0c13fb',
  },
  spray_exposure_policy_change: {
    args: [],
    names: [],
    result: 'trigger',
    hash: '22393e7eb8135ed6b1a3a9c04fcd823d9bac91a102dd4bcc30326d7047dbf8ea',
  },
  spray_exposure_climb_change: {
    args: [],
    names: [],
    result: 'trigger',
    hash: '3e76949ad298804cc6bbdebc6d4329402d412889f74c8a8f4a06edb3976b28d6',
  },
} as const;

// PostgreSQL expands row IS DISTINCT FROM to an OR of component comparisons
// when deparsing the stored predicate. Preserve grouping in the catalog pin.
const changed = (...columns: string[]) =>
  columns.map((column) => `old.${column} IS DISTINCT FROM new.${column}`).join(' OR ');
const nullStateChanged = (column: string) => `(old.${column} IS NULL) IS DISTINCT FROM (new.${column} IS NULL)`;

const attachments = {
  spray_exposure_board_insert: [
    'user_boards',
    'spray_exposure_board_change',
    'INSERT',
    [],
    "new.board_type = 'spray'::text",
  ],
  spray_exposure_board_delete: [
    'user_boards',
    'spray_exposure_board_change',
    'DELETE',
    [],
    "old.board_type = 'spray'::text",
  ],
  spray_exposure_board_update: [
    'user_boards',
    'spray_exposure_board_change',
    'UPDATE',
    ['id', 'uuid', 'board_type', 'layout_id', 'angle', 'gym_id', 'deleted_at', 'merged_into_board_uuid'],
    `(old.board_type = 'spray'::text OR new.board_type = 'spray'::text) AND (${changed(
      'id',
      'uuid',
      'board_type',
      'layout_id',
      'angle',
      'gym_id',
    )} OR ${nullStateChanged('deleted_at')} OR ${nullStateChanged('merged_into_board_uuid')})`,
  ],
  spray_exposure_wall_lifecycle: ['spray_walls', 'spray_exposure_wall_change', 'INSERT OR DELETE', [], ''],
  spray_exposure_wall_update: [
    'spray_walls',
    'spray_exposure_wall_change',
    'UPDATE',
    ['id', 'board_uuid', 'layout_id', 'current_version_id', 'deleted_at', 'archived_at', 'hidden_at'],
    `${changed('id', 'board_uuid', 'layout_id', 'current_version_id')} OR ${nullStateChanged('deleted_at')} OR ${nullStateChanged(
      'archived_at',
    )} OR ${nullStateChanged('hidden_at')}`,
  ],
  spray_exposure_version_lifecycle: [
    'spray_wall_versions',
    'spray_exposure_version_change',
    'INSERT OR DELETE',
    [],
    '',
  ],
  spray_exposure_version_update: [
    'spray_wall_versions',
    'spray_exposure_version_change',
    'UPDATE',
    ['id', 'wall_id', 'status'],
    `${changed('id', 'wall_id')} OR (old.status = 'published'::spray_wall_version_status) IS DISTINCT FROM (new.status = 'published'::spray_wall_version_status)`,
  ],
  spray_exposure_policy_lifecycle: ['resource_privacy', 'spray_exposure_policy_change', 'INSERT OR DELETE', [], ''],
  spray_exposure_policy_update: [
    'resource_privacy',
    'spray_exposure_policy_change',
    'UPDATE',
    ['kind', 'resource_id', 'audience'],
    '',
  ],
  spray_exposure_climb_insert: [
    'board_climbs',
    'spray_exposure_climb_change',
    'INSERT',
    [],
    "new.board_type = 'spray'::text",
  ],
  spray_exposure_climb_delete: [
    'board_climbs',
    'spray_exposure_climb_change',
    'DELETE',
    [],
    "old.board_type = 'spray'::text",
  ],
  spray_exposure_climb_update: [
    'board_climbs',
    'spray_exposure_climb_change',
    'UPDATE',
    [
      'board_type',
      'layout_id',
      'uuid',
      'is_draft',
      'is_listed',
      'is_hidden',
      'frames',
      'missing_hold_count',
      'retired_by_reset',
    ],
    "old.board_type = 'spray'::text OR new.board_type = 'spray'::text",
  ],
} as const;

/** Remove only layout whitespace and known qualification, keeping the WHEN tree. */
function normalizedTrigger(definition: string) {
  return definition
    .replace(
      /\bpublic\.(spray_exposure_\w+|spray_wall_version_status|user_boards|spray_walls|spray_wall_versions|resource_privacy|board_climbs)\b/g,
      '$1',
    )
    .replace(/\s+/g, ' ')
    .trim();
}

function attachmentDefinition(
  name: string,
  [table, routine, events, columns, predicate]: (typeof attachments)[keyof typeof attachments],
) {
  const updates = columns.length > 0 ? ` OF ${columns.join(', ')}` : '';
  const when = predicate ? ` WHEN (${predicate})` : '';
  return `CREATE TRIGGER ${name} AFTER ${events}${updates} ON ${table} FOR EACH ROW${when} EXECUTE FUNCTION ${routine}()`;
}

export function sprayExposureTriggerIdentity(schema: string, table: string, trigger: string, routine: string): string {
  return `${schema}:${table}:${trigger}:${routine}`;
}

async function verifySourceAndSink(client: CatalogClient): Promise<boolean> {
  const [closure] = await client<{ safe: boolean; sink: unknown }[]>`
    WITH relations(oid) AS (
      VALUES (to_regclass('public.user_boards')), (to_regclass('public.spray_walls')),
        (to_regclass('public.spray_wall_versions')), (to_regclass('public.resource_privacy')),
        (to_regclass('public.board_climbs')), (to_regclass('public.spray_exposure_invalidations'))
    ), source_columns(relation, name, type_name) AS (
      VALUES ('user_boards','id','pg_catalog.int8'), ('user_boards','uuid','pg_catalog.text'),
        ('user_boards','board_type','pg_catalog.text'), ('user_boards','layout_id','pg_catalog.int8'),
        ('user_boards','angle','pg_catalog.int8'), ('user_boards','gym_id','pg_catalog.int8'),
        ('user_boards','deleted_at','pg_catalog.timestamp'), ('user_boards','merged_into_board_uuid','pg_catalog.text'),
        ('spray_walls','id','pg_catalog.int8'), ('spray_walls','board_uuid','pg_catalog.text'),
        ('spray_walls','layout_id','pg_catalog.int4'), ('spray_walls','current_version_id','pg_catalog.int8'),
        ('spray_walls','deleted_at','pg_catalog.timestamp'), ('spray_walls','archived_at','pg_catalog.timestamp'),
        ('spray_walls','hidden_at','pg_catalog.timestamp'),
        ('spray_wall_versions','id','pg_catalog.int8'), ('spray_wall_versions','wall_id','pg_catalog.int8'),
        ('spray_wall_versions','status','public.spray_wall_version_status'),
        ('resource_privacy','kind','pg_catalog.text'), ('resource_privacy','resource_id','pg_catalog.text'),
        ('resource_privacy','audience','pg_catalog.text'),
        ('board_climbs','board_type','pg_catalog.text'), ('board_climbs','layout_id','pg_catalog.int4'),
        ('board_climbs','uuid','pg_catalog.text'), ('board_climbs','frames','pg_catalog.text'),
        ('board_climbs','is_draft','pg_catalog.bool'), ('board_climbs','is_listed','pg_catalog.bool'),
        ('board_climbs','is_hidden','pg_catalog.bool'), ('board_climbs','missing_hold_count','pg_catalog.int4'),
        ('board_climbs','retired_by_reset','pg_catalog.bool')
    ), names AS (
      SELECT to_regclass('public.spray_exposure_invalidations') AS sink,
        to_regclass('public.spray_exposure_event_seq') AS sequence,
        to_regclass('public.user_boards') AS lookup
    ), indexes AS (
      SELECT indexrelid, indrelid, indclass, indcollation, indisvalid, indisready
      FROM pg_index, names WHERE indrelid IN (names.sink, names.lookup)
    ), postgis_members(classid, oid) AS (
      SELECT dependency.classid, dependency.objid FROM pg_depend dependency
      JOIN pg_extension extension ON extension.oid = dependency.refobjid
      WHERE dependency.refclassid = 'pg_extension'::regclass AND dependency.deptype = 'e'
        AND extension.extname = 'postgis' AND extension.extnamespace = 'public'::regnamespace
    ), expressions(classid, oid) AS (
      SELECT 'pg_attrdef'::regclass, oid FROM pg_attrdef, names WHERE adrelid = names.sink
      UNION ALL SELECT 'pg_constraint'::regclass, oid FROM pg_constraint, names WHERE conrelid = names.sink
      UNION ALL SELECT 'pg_class'::regclass, indexrelid FROM indexes
    ), reached_types(oid) AS (
      VALUES ('pg_catalog.int8'::regtype), ('pg_catalog.int4'::regtype), ('pg_catalog.timestamp'::regtype),
        ('pg_catalog.timestamptz'::regtype), ('pg_catalog.text'::regtype), ('pg_catalog.bool'::regtype),
        (to_regtype('public.spray_wall_version_status'))
    )
    SELECT
      (SELECT count(*) FROM relations JOIN pg_class relation ON relation.oid = relations.oid
        JOIN pg_am method ON method.oid = relation.relam
        WHERE relation.relkind = 'r' AND NOT relation.relrowsecurity AND NOT relation.relforcerowsecurity
          AND NOT relation.relispartition AND method.amhandler = 'pg_catalog.heap_tableam_handler'::regproc) = 6
      AND NOT EXISTS (SELECT 1 FROM pg_inherits WHERE inhrelid IN (SELECT oid FROM relations)
        OR inhparent IN (SELECT oid FROM relations))
      AND NOT EXISTS (SELECT 1 FROM pg_rewrite WHERE ev_class IN (SELECT oid FROM relations))
      AND NOT EXISTS (SELECT 1 FROM source_columns source WHERE NOT EXISTS (
        SELECT 1 FROM pg_attribute attribute WHERE attribute.attrelid = to_regclass('public.' || source.relation)
          AND attribute.attname = source.name AND attribute.atttypid = to_regtype(source.type_name)
          AND attribute.attnum > 0 AND NOT attribute.attisdropped AND attribute.attgenerated = ''
          AND (attribute.attcollation = 0 OR attribute.attcollation = 'pg_catalog."default"'::regcollation)
      ))
      AND (SELECT type.typtype = 'e' AND type.typinput = 'pg_catalog.enum_in'::regproc
        AND type.typoutput = 'pg_catalog.enum_out'::regproc AND type.typreceive = 'pg_catalog.enum_recv'::regproc
        AND type.typsend = 'pg_catalog.enum_send'::regproc
        AND ARRAY(SELECT enumlabel::text FROM pg_enum WHERE enumtypid = type.oid ORDER BY enumsortorder)
          = ARRAY['draft','published','superseded']
        FROM pg_type type WHERE type.oid = to_regtype('public.spray_wall_version_status'))
      -- Neither invoker nor definer callbacks may run from the privileged INSERT.
      AND NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = names.sink AND tgenabled <> 'D')
      AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE confrelid = names.sink)
      AND EXISTS (SELECT 1 FROM pg_sequence config JOIN pg_class relation ON relation.oid = config.seqrelid
        WHERE config.seqrelid = names.sequence AND relation.relkind = 'S' AND relation.relpersistence = 'p'
          AND config.seqtypid = 'pg_catalog.int8'::regtype AND config.seqstart = 1 AND config.seqincrement = 1
          AND relation.relowner = (SELECT relowner FROM pg_class WHERE oid = names.sink)
          AND config.seqmin = 1 AND config.seqmax = 9223372036854775807 AND config.seqcache = 1 AND NOT config.seqcycle)
      AND NOT EXISTS (SELECT 1 FROM pg_depend WHERE classid = 'pg_class'::regclass AND objid = names.sequence
        AND refclassid = 'pg_class'::regclass AND deptype IN ('a','i'))
      AND (SELECT count(*) FROM pg_depend dependency JOIN pg_attrdef default_row ON default_row.oid = dependency.objid
        WHERE dependency.classid = 'pg_attrdef'::regclass AND default_row.adrelid = names.sink
          AND dependency.refclassid = 'pg_class'::regclass AND dependency.refobjid = names.sequence) = 1
      AND NOT EXISTS (SELECT 1 FROM pg_depend dependency JOIN expressions expression
        ON expression.classid = dependency.classid AND expression.oid = dependency.objid
        LEFT JOIN pg_proc routine ON dependency.refclassid = 'pg_proc'::regclass AND routine.oid = dependency.refobjid
        LEFT JOIN pg_operator operator ON dependency.refclassid = 'pg_operator'::regclass AND operator.oid = dependency.refobjid
        WHERE routine.pronamespace <> 'pg_catalog'::regnamespace OR operator.oprnamespace <> 'pg_catalog'::regnamespace)
      AND NOT EXISTS (SELECT 1 FROM indexes index_row JOIN pg_class relation ON relation.oid = index_row.indexrelid
        JOIN pg_am method ON method.oid = relation.relam
        CROSS JOIN LATERAL unnest(index_row.indclass) class_oid JOIN pg_opclass class ON class.oid = class_oid
        JOIN pg_opfamily family ON family.oid = class.opcfamily
        WHERE (
          (method.amhandler = 'pg_catalog.bthandler'::regproc AND class.opcnamespace = 'pg_catalog'::regnamespace
            AND family.opfnamespace = 'pg_catalog'::regnamespace
            AND NOT EXISTS (SELECT 1 FROM unnest(index_row.indcollation) collation_oid
              WHERE collation_oid NOT IN (0, 'pg_catalog."default"'::regcollation)))
          OR (index_row.indrelid = names.lookup AND method.amhandler = 'pg_catalog.gisthandler'::regproc
            AND pg_get_indexdef(index_row.indexrelid) = 'CREATE INDEX user_boards_location_gist_idx ON public.user_boards USING gist (location) WHERE ((is_public = true) AND (deleted_at IS NULL))'
            AND class.opcname = 'gist_geography_ops' AND family.opfname = 'gist_geography_ops'
            AND class.opcnamespace = 'public'::regnamespace AND family.opfnamespace = 'public'::regnamespace
            AND class.opcintype = to_regtype('public.geography')
            AND EXISTS (SELECT 1 FROM postgis_members WHERE classid = 'pg_opclass'::regclass AND oid = class.oid)
            AND EXISTS (SELECT 1 FROM postgis_members WHERE classid = 'pg_opfamily'::regclass AND oid = family.oid)
            AND EXISTS (SELECT 1 FROM postgis_members WHERE classid = 'pg_type'::regclass AND oid = class.opcintype)
            AND NOT EXISTS (SELECT 1 FROM pg_amop family_operator WHERE family_operator.amopfamily = family.oid
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
        AND operator.oprname IN ('=', '<>', '||') AND operator.oprleft IN (SELECT oid FROM reached_types)
        AND operator.oprright IN (SELECT oid FROM reached_types))
      AND NOT EXISTS (SELECT 1 FROM pg_cast cast_row JOIN pg_proc routine ON routine.oid = cast_row.castfunc
        WHERE routine.pronamespace <> 'pg_catalog'::regnamespace AND cast_row.castsource IN (SELECT oid FROM reached_types)
        AND cast_row.casttarget IN (SELECT oid FROM reached_types)) AS safe,
      json_build_object(
        'columns', (SELECT json_agg(json_build_array(attribute.attname, format_type(attribute.atttypid, attribute.atttypmod),
              attribute.attnotnull, attribute.attgenerated, attribute.attidentity,
              replace(pg_get_expr(default_row.adbin, default_row.adrelid), 'public.spray_exposure_event_seq', 'spray_exposure_event_seq'))
            ORDER BY attribute.attnum)
          FROM pg_attribute attribute LEFT JOIN pg_attrdef default_row ON default_row.adrelid = attribute.attrelid AND default_row.adnum = attribute.attnum
          WHERE attribute.attrelid = names.sink AND attribute.attnum > 0 AND NOT attribute.attisdropped),
        'constraints', (SELECT json_agg(pg_get_constraintdef(oid) ORDER BY conname)
          FROM pg_constraint WHERE conrelid = names.sink AND contype <> 'n'),
        'indexes', (SELECT json_agg(json_build_array(pg_get_indexdef(indexrelid), indisvalid, indisready) ORDER BY indexrelid::regclass::text)
          FROM indexes WHERE indrelid = names.sink)
      ) AS sink
    FROM names`;
  const reviewedSink = {
    columns: [
      ['seq', 'bigint', true, '', '', "nextval('spray_exposure_event_seq'::regclass)"],
      ['kind', 'text', true, '', '', null],
      ['key', 'text', true, '', '', null],
      ['observed_at', 'timestamp with time zone', true, '', '', null],
    ],
    constraints: ['PRIMARY KEY (seq)'],
    indexes: [
      [
        'CREATE INDEX spray_exposure_invalidation_key_idx ON public.spray_exposure_invalidations USING btree (kind, key, seq)',
        true,
        true,
      ],
      [
        'CREATE UNIQUE INDEX spray_exposure_invalidations_pkey ON public.spray_exposure_invalidations USING btree (seq)',
        true,
        true,
      ],
    ],
  };
  return !!closure?.safe && JSON.stringify(closure.sink) === JSON.stringify(reviewedSink);
}

/** Catalog-only proof of all paths under the exposure trigger definer. */
export async function verifySprayExposureClosure(client: CatalogClient, webRole: string): Promise<ReadonlySet<string>> {
  const routineNames = Object.keys(routines);
  const triggerNames = Object.keys(attachments);
  const functions = await client<
    {
      name: keyof typeof routines;
      args: string[];
      names: string[];
      result: string;
      source: string;
      safe: boolean;
      privileged: boolean;
      language: string;
      strict: boolean;
      volatile: string;
      parallel: string;
    }[]
  >`
    SELECT routine.proname AS name, to_json(ARRAY(
        SELECT format_type(argument, NULL) FROM unnest(routine.proargtypes) argument
      )) AS args, to_json(coalesce(routine.proargnames, ARRAY[]::text[])) AS names, format_type(routine.prorettype, NULL) AS result, routine.prosrc AS source,
      routine.prosecdef AS privileged, language.lanname AS language,
      routine.proisstrict AS strict, routine.provolatile AS volatile, routine.proparallel AS parallel,
      routine.proconfig = ARRAY['search_path=pg_catalog']
        AND routine.prokind = 'f' AND NOT routine.proretset AND routine.pronargdefaults = 0
        AND routine.provariadic = 0 AND routine.prosupport = 0 AND routine.prosqlbody IS NULL
        AND routine.proargmodes IS NULL
        AND routine.proowner = (SELECT relowner FROM pg_class WHERE oid = to_regclass('public.spray_exposure_invalidations'))
        AND (NOT routine.prosecdef OR NOT has_function_privilege(${webRole}, routine.oid, 'EXECUTE')) AS safe
    FROM pg_proc routine JOIN pg_language language ON language.oid = routine.prolang
    WHERE routine.pronamespace = 'public'::regnamespace AND routine.proname IN (SELECT pg_catalog.jsonb_array_elements_text(${JSON.stringify(routineNames)}::text::jsonb))`;
  const triggers = await client<
    {
      name: keyof typeof attachments;
      schema: string;
      routineSchema: string;
      table: string;
      routine: string;
      definition: string;
      safe: boolean;
    }[]
  >`
    SELECT trigger.tgname AS name, namespace.nspname AS schema,
      routine_namespace.nspname AS "routineSchema", relation.relname AS table, routine.proname AS routine,
      pg_get_triggerdef(trigger.oid, true) AS definition,
      trigger.tgenabled = 'O' AND NOT trigger.tgisinternal AND NOT trigger.tgdeferrable AND NOT trigger.tginitdeferred
        AND trigger.tgnargs = 0 AND trigger.tgconstraint = 0 AND NOT EXISTS (
          SELECT 1 FROM pg_depend dependency
          JOIN pg_operator operator ON dependency.refclassid = 'pg_operator'::regclass AND operator.oid = dependency.refobjid
          WHERE dependency.classid = 'pg_trigger'::regclass AND dependency.objid = trigger.oid
            AND operator.oprnamespace <> 'pg_catalog'::regnamespace
        ) AS safe
    FROM pg_trigger trigger JOIN pg_class relation ON relation.oid = trigger.tgrelid
    JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
    JOIN pg_proc routine ON routine.oid = trigger.tgfoid
    JOIN pg_namespace routine_namespace ON routine_namespace.oid = routine.pronamespace
    WHERE (routine_namespace.nspname = 'public' AND routine.proname IN (SELECT pg_catalog.jsonb_array_elements_text(${JSON.stringify(routineNames)}::text::jsonb)))
      OR (namespace.nspname = 'public' AND trigger.tgname IN (SELECT pg_catalog.jsonb_array_elements_text(${JSON.stringify(triggerNames)}::text::jsonb)))`;

  if (functions.length === 0 && triggers.length === 0) {
    const [schema] = await client<{ installed: boolean }[]>`
      SELECT EXISTS (SELECT 1 FROM pg_class
        WHERE relnamespace = 'public'::regnamespace
          AND relname IN (SELECT pg_catalog.jsonb_array_elements_text(${JSON.stringify([...GYM_INVENTORY_PRIVATE_TABLES, SPRAY_EXPOSURE_EVENT_SEQUENCE])}::text::jsonb))) AS installed`;
    if (schema?.installed === false) return new Set(); // Pre-0337 schema fixture.
  }

  const verified = new Set<string>();
  const uniqueFunctions = new Set<string>();
  for (const fn of functions) {
    const pin = routines[fn.name];
    const key = fn.name === 'spray_exposure_fence_key' || fn.name === 'spray_exposure_climb_key';
    if (
      !pin ||
      !fn.safe ||
      uniqueFunctions.has(fn.name) ||
      fn.privileged === key ||
      fn.language !== (key ? 'sql' : 'plpgsql') ||
      fn.strict !== key ||
      fn.volatile !== (key ? 'i' : 'v') ||
      fn.parallel !== (key ? 's' : 'u') ||
      fn.result !== pin.result ||
      JSON.stringify(fn.args) !== JSON.stringify(pin.args) ||
      JSON.stringify(fn.names) !== JSON.stringify(pin.names) ||
      createHash('sha256').update(fn.source).digest('hex') !== pin.hash
    ) {
      throw new Error('UNREVIEWED_SPRAY_EXPOSURE_ROUTINE');
    }
    uniqueFunctions.add(fn.name);
  }
  if (uniqueFunctions.size !== routineNames.length) throw new Error('UNREVIEWED_SPRAY_EXPOSURE_ROUTINE');
  for (const trigger of triggers) {
    const pin = attachments[trigger.name];
    if (
      !pin ||
      !trigger.safe ||
      trigger.schema !== 'public' ||
      trigger.routineSchema !== 'public' ||
      trigger.table !== pin[0] ||
      trigger.routine !== pin[1] ||
      normalizedTrigger(trigger.definition) !== attachmentDefinition(trigger.name, pin)
    ) {
      throw new Error('UNREVIEWED_SPRAY_EXPOSURE_ATTACHMENT');
    }
    verified.add(sprayExposureTriggerIdentity(trigger.schema, trigger.table, trigger.name, trigger.routine));
  }
  if (verified.size !== triggerNames.length) throw new Error('UNREVIEWED_SPRAY_EXPOSURE_ATTACHMENT');
  if (!(await verifySourceAndSink(client))) throw new Error('UNREVIEWED_SPRAY_EXPOSURE_CLOSURE');
  return verified;
}
