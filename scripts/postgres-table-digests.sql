\set ON_ERROR_STOP on
\pset format unaligned
\pset tuples_only on

\if :{?included_schemas}
\else
\set included_schemas 'public,drizzle'
\endif
\if :{?excluded_schemas}
\else
\set excluded_schemas 'neon_auth,neon_control_plane'
\endif

-- Generate and execute one full-table read per explicitly covered logical
-- table. Query top-level partitioned parents so their leaf rows are covered
-- exactly once; query ordinary tables only when they are not partitions. The
-- digest is order-independent so physical row order may differ on a logical
-- subscriber. It is an operational drift detector, not a cryptographic proof.
SELECT pg_catalog.format(
  $generated_query$
SELECT %L || E'\t' || count(*)::text || E'\t' ||
       coalesce(
         sum(pg_catalog.hashtextextended(pg_catalog.row_to_json(table_row)::text, 0)::numeric),
         0
       )::text
FROM %I.%I AS table_row;
$generated_query$,
  pg_catalog.format('%I.%I', namespace.nspname, relation.relname),
  namespace.nspname,
  relation.relname
)
FROM pg_catalog.pg_class AS relation
JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
WHERE relation.relkind IN ('r', 'p')
  AND NOT relation.relispartition
  AND relation.relpersistence = 'p'
  AND namespace.nspname = ANY (pg_catalog.string_to_array(:'included_schemas', ','))
  AND NOT namespace.nspname = ANY (pg_catalog.string_to_array(:'excluded_schemas', ','))
  AND NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_depend AS extension_dependency
    WHERE extension_dependency.classid = 'pg_catalog.pg_class'::pg_catalog.regclass
      AND extension_dependency.objid = relation.oid
      AND extension_dependency.deptype = 'e'
  )
ORDER BY namespace.nspname, relation.relname
\gexec
