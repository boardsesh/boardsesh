import { createHash } from 'node:crypto';
import type postgres from 'postgres';

type CatalogClient = postgres.Sql | postgres.TransactionSql;
export const GYM_RANKING_PRIVATE_TABLES = ['gym_reporting_tick_votes', 'gym_climb_comment_attributions'] as const;
export const GYM_VOTE_TRIGGER = 'invalidate_gym_tick_votes';
export const GYM_VOTE_TRIGGER_SHA256 = '2657a55f4dd37fff70daf2c7b8b70e912b26ddcf204998116cb6a4e88abc3878';
const sourceColumnTypes = {
  id: 'pg_catalog.int8',
  uuid: 'pg_catalog.text',
  user_id: 'pg_catalog.text',
  origin: 'public.tick_origin',
  board_id: 'pg_catalog.int8',
  reporting_board_id: 'pg_catalog.int8',
  reporting_gym_id: 'pg_catalog.int8',
  reporting_attribution: 'pg_catalog.text',
  board_type: 'pg_catalog.text',
  climb_uuid: 'pg_catalog.text',
  angle: 'pg_catalog.int4',
  is_mirror: 'pg_catalog.bool',
  climbed_at: 'pg_catalog.timestamp',
  reporting_climbed_at: 'pg_catalog.timestamp',
  reporting_time_precision: 'pg_catalog.text',
  reporting_date: 'pg_catalog.date',
  reporting_date_time_zone: 'pg_catalog.text',
  quality: 'pg_catalog.int4',
  difficulty: 'pg_catalog.int4',
} as const;
export const GYM_VOTE_SOURCE_COLUMNS = Object.keys(sourceColumnTypes);
const VOTE_ATTACHMENT = 'trg_invalidate_gym_tick_votes';

/** Exact plain-heap and primary-index shape. No executable callback outside the built-in btree families. */
async function verifyGymVoteSink(client: CatalogClient): Promise<boolean> {
  const [result] = await client<{ safe: boolean }[]>`
    WITH sink AS (SELECT pg_catalog.to_regclass('public.gym_reporting_tick_votes') AS oid),
    checked_index AS (
      SELECT index_row.*, index_class.relam FROM pg_catalog.pg_index index_row
      JOIN pg_catalog.pg_class index_class ON index_class.oid = index_row.indexrelid AND index_class.relkind = 'i'
      JOIN sink ON index_row.indrelid = sink.oid
    ),
    operator_classes AS (
      SELECT operator_class.oid, operator_class.opcname, operator_class.opcnamespace,
        operator_class.opcintype, operator_class.opcmethod, family.oid AS family_oid, family.opfname,
        family.opfnamespace, family.opfmethod, key.position
      FROM checked_index
      CROSS JOIN LATERAL pg_catalog.unnest(indclass::oid[]) WITH ORDINALITY AS key(oid, position)
      JOIN pg_catalog.pg_opclass operator_class ON operator_class.oid = key.oid
      JOIN pg_catalog.pg_opfamily family ON family.oid = operator_class.opcfamily
    ),
    expression_objects(class_id, oid) AS (
      SELECT 'pg_catalog.pg_constraint'::regclass, constraint_row.oid
      FROM pg_catalog.pg_constraint constraint_row, sink WHERE constraint_row.conrelid = sink.oid
      UNION ALL
      SELECT 'pg_catalog.pg_class'::regclass, indexrelid FROM checked_index
    )
    SELECT
      (SELECT count(*) FROM checked_index) = 1
      AND EXISTS (
        SELECT 1 FROM checked_index index_row
        JOIN pg_catalog.pg_am method ON method.oid = index_row.relam
        WHERE index_row.indisprimary AND index_row.indisunique AND index_row.indimmediate
          AND index_row.indisvalid AND index_row.indisready AND index_row.indislive
          AND index_row.indisclustered IS FALSE AND index_row.indnkeyatts = 2 AND index_row.indnatts = 2
          AND index_row.indexprs IS NULL AND index_row.indpred IS NULL
          AND index_row.indkey::text = '1 2' AND index_row.indoption::text = '0 0'
          AND index_row.indcollation::text = ('0 ' || ('pg_catalog."default"'::regcollation)::oid::text)
          AND method.oid < 16384 AND method.amhandler = 'pg_catalog.bthandler'::regproc
      )
      AND (SELECT array_agg(attribute.attname::text ORDER BY attribute.attnum)
        FROM pg_catalog.pg_attribute attribute, sink
        WHERE attribute.attrelid = sink.oid AND attribute.attnum > 0) =
        ARRAY['tick_id','metric','attested_value']
      AND (SELECT array_agg(attribute.atttypid ORDER BY attribute.attnum)
        FROM pg_catalog.pg_attribute attribute, sink
        WHERE attribute.attrelid = sink.oid AND attribute.attnum > 0
          AND attribute.attnotnull AND NOT attribute.attisdropped AND attribute.attgenerated = ''
          AND attribute.attidentity = '' AND NOT attribute.atthasdef) =
        ARRAY['pg_catalog.int8'::regtype::oid, 'pg_catalog.text'::regtype::oid, 'pg_catalog.int4'::regtype::oid]
      AND (SELECT count(*) FROM operator_classes) = 2
      AND NOT EXISTS (
        SELECT 1 FROM operator_classes class_row
        WHERE class_row.oid >= 16384 OR class_row.family_oid >= 16384
          OR class_row.opcnamespace <> 'pg_catalog'::regnamespace OR class_row.opfnamespace <> 'pg_catalog'::regnamespace
          OR class_row.opcmethod <> class_row.opfmethod
          OR ((class_row.position = 1 AND class_row.opcname = 'int8_ops' AND class_row.opfname = 'integer_ops'
                AND class_row.opcintype = 'pg_catalog.int8'::regtype)
            OR (class_row.position = 2 AND class_row.opcname = 'text_ops' AND class_row.opfname = 'text_ops'
                AND class_row.opcintype = 'pg_catalog.text'::regtype)) IS NOT TRUE
      )
      AND NOT EXISTS (
        SELECT 1 FROM pg_catalog.pg_amproc support
        JOIN operator_classes class_row ON class_row.family_oid = support.amprocfamily
        JOIN pg_catalog.pg_proc callback ON callback.oid = support.amproc::oid
        WHERE callback.oid >= 16384 OR callback.pronamespace <> 'pg_catalog'::regnamespace
      )
      AND NOT EXISTS (
        SELECT 1 FROM pg_catalog.pg_amop family_operator
        JOIN operator_classes class_row ON class_row.family_oid = family_operator.amopfamily
        JOIN pg_catalog.pg_operator operator ON operator.oid = family_operator.amopopr
        LEFT JOIN pg_catalog.pg_proc callback ON callback.oid IN
          (operator.oprcode::oid, operator.oprrest::oid, operator.oprjoin::oid)
        WHERE operator.oid >= 16384 OR operator.oprnamespace <> 'pg_catalog'::regnamespace
          OR callback.oid >= 16384 OR callback.pronamespace <> 'pg_catalog'::regnamespace
      )
      AND NOT EXISTS (
        SELECT 1 FROM expression_objects object
        JOIN pg_catalog.pg_depend dependency ON dependency.classid = object.class_id AND dependency.objid = object.oid
        LEFT JOIN pg_catalog.pg_proc routine ON dependency.refclassid = 'pg_catalog.pg_proc'::regclass
          AND routine.oid = dependency.refobjid
        LEFT JOIN pg_catalog.pg_operator operator ON dependency.refclassid = 'pg_catalog.pg_operator'::regclass
          AND operator.oid = dependency.refobjid
        WHERE routine.oid >= 16384 OR routine.pronamespace <> 'pg_catalog'::regnamespace
          OR operator.oid >= 16384 OR operator.oprnamespace <> 'pg_catalog'::regnamespace
      )
      AND NOT EXISTS (
        SELECT 1 FROM pg_catalog.pg_operator operator
        WHERE operator.oprnamespace <> 'pg_catalog'::regnamespace AND operator.oprname IN ('=', '<>')
          AND operator.oprleft IN ('pg_catalog.int8'::regtype, 'pg_catalog.text'::regtype, 'pg_catalog.int4'::regtype)
          AND operator.oprright IN ('pg_catalog.int8'::regtype, 'pg_catalog.text'::regtype, 'pg_catalog.int4'::regtype)
      ) AS safe
  `;
  return result?.safe === true;
}

/** The definer has no helper or sequence. Its only sink is a plain private table, with no executable delete dependencies. */
export async function verifyGymVoteClosure(client: CatalogClient, role: string): Promise<void> {
  const [presence] = await client<
    { hasSink: boolean; hasComments: boolean; hasRoutine: boolean; attachments: number }[]
  >`
    SELECT pg_catalog.to_regclass('public.gym_reporting_tick_votes') IS NOT NULL AS "hasSink",
      pg_catalog.to_regclass('public.gym_climb_comment_attributions') IS NOT NULL AS "hasComments",
      EXISTS (
        SELECT 1 FROM pg_catalog.pg_proc routine
        WHERE routine.pronamespace = 'public'::regnamespace AND routine.proname = ${GYM_VOTE_TRIGGER}
      ) AS "hasRoutine",
      (SELECT count(*)::int FROM pg_catalog.pg_trigger trigger_row
        JOIN pg_catalog.pg_class relation ON relation.oid = trigger_row.tgrelid
        WHERE relation.relnamespace = 'public'::regnamespace AND trigger_row.tgname = ${VOTE_ATTACHMENT}) AS attachments
  `;
  if (!presence.hasSink && !presence.hasComments && !presence.hasRoutine && !presence.attachments) return;
  if (!presence.hasSink || !presence.hasComments || !presence.hasRoutine || presence.attachments !== 1) {
    throw new Error('UNREVIEWED_GYM_VOTE_CLOSURE');
  }

  const rows = await client<{ source: string; columns: string[]; safe: boolean }[]>`
    SELECT routine.prosrc AS source, to_json(ARRAY(
      SELECT attribute.attname FROM unnest(attachment.tgattr::smallint[]) WITH ORDINALITY item(num, position)
      JOIN pg_catalog.pg_attribute attribute ON attribute.attrelid = ticks.oid AND attribute.attnum = item.num
      ORDER BY item.position
    )) AS columns, coalesce((
      routine.pronargs = 0 AND routine.prokind = 'f' AND routine.prorettype = 'pg_catalog.trigger'::regtype
      AND routine.prosecdef AND routine.proconfig = ARRAY['search_path=pg_catalog']
      AND routine.prolang = (SELECT oid FROM pg_catalog.pg_language WHERE lanname = 'plpgsql')
      AND NOT pg_catalog.has_function_privilege(${role}, routine.oid, 'EXECUTE')
      AND NOT EXISTS (
        SELECT 1 FROM pg_catalog.aclexplode(coalesce(routine.proacl, pg_catalog.acldefault('f', routine.proowner))) acl
        WHERE acl.grantee = 0 AND acl.privilege_type = 'EXECUTE'
      )
      AND ticks.oid = 'public.boardsesh_ticks'::regclass
      AND attachment.tgname = ${VOTE_ATTACHMENT}
      AND attachment.tgtype = 17 AND attachment.tgenabled = 'O' AND NOT attachment.tgisinternal
      AND attachment.tgqual IS NULL AND attachment.tgnargs = 0 AND attachment.tgconstraint = 0
      AND NOT attachment.tgdeferrable AND NOT attachment.tginitdeferred
      AND attachment.tgoldtable IS NULL AND attachment.tgnewtable IS NULL
      AND sink.relkind = 'r' AND NOT sink.relispartition AND sink.relowner = routine.proowner
      AND sink.relpersistence = 'p'
      AND EXISTS (SELECT 1 FROM pg_catalog.pg_am method
        WHERE method.oid = sink.relam AND method.oid < 16384
          AND method.amhandler = 'pg_catalog.heap_tableam_handler'::regproc)
      AND NOT EXISTS (
        SELECT 1 FROM pg_catalog.jsonb_each_text(${JSON.stringify(sourceColumnTypes)}::text::jsonb) expected(name, type_name)
        WHERE NOT EXISTS (SELECT 1 FROM pg_catalog.pg_attribute attribute
          WHERE attribute.attrelid = ticks.oid AND attribute.attname = expected.name::name
            AND attribute.attnum > 0 AND NOT attribute.attisdropped AND attribute.attgenerated = ''
            AND attribute.atttypid = pg_catalog.to_regtype(expected.type_name)
            AND (attribute.attcollation = 0 OR attribute.attcollation = 'pg_catalog."default"'::regcollation))
      )
      AND NOT sink.relrowsecurity AND NOT sink.relforcerowsecurity
      AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_inherits WHERE inhrelid = sink.oid OR inhparent = sink.oid)
      AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_trigger WHERE tgrelid = sink.oid AND NOT tgisinternal)
      AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_rewrite WHERE ev_class = sink.oid)
      AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint WHERE confrelid = sink.oid AND contype = 'f')
      AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_policy WHERE polrelid = sink.oid)
      AND NOT pg_catalog.has_table_privilege(${role}, sink.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
      AND NOT pg_catalog.has_any_column_privilege(${role}, sink.oid, 'SELECT,INSERT,UPDATE,REFERENCES')
    ), false) AS safe
    FROM pg_catalog.pg_proc routine JOIN pg_catalog.pg_namespace namespace ON namespace.oid = routine.pronamespace
    LEFT JOIN pg_catalog.pg_trigger attachment ON attachment.tgfoid = routine.oid
    LEFT JOIN pg_catalog.pg_class ticks ON ticks.oid = attachment.tgrelid
    LEFT JOIN pg_catalog.pg_class sink ON sink.oid = pg_catalog.to_regclass('public.gym_reporting_tick_votes')
    WHERE namespace.nspname = 'public' AND routine.proname = ${GYM_VOTE_TRIGGER}
  `;
  if (
    rows.length !== 1 ||
    !rows[0].safe ||
    JSON.stringify(rows[0].columns) !== JSON.stringify(GYM_VOTE_SOURCE_COLUMNS) ||
    createHash('sha256').update(rows[0].source).digest('hex') !== GYM_VOTE_TRIGGER_SHA256 ||
    !(await verifyGymVoteSink(client))
  ) {
    throw new Error('UNREVIEWED_GYM_VOTE_CLOSURE');
  }
}
