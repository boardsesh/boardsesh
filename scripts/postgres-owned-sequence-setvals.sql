\set ON_ERROR_STOP on
\pset format unaligned
\pset tuples_only on

\if :{?included_schemas}
\else
\set included_schemas 'public,drizzle'
\endif
\if :{?excluded_schemas}
\else
\set excluded_schemas ''
\endif

-- pg_sequences intentionally does not expose is_called. Generate one query per
-- sequence relation so the relation's actual last_value/is_called tuple is read.
-- Restrict this to sequences owned by application-table columns; unowned
-- sequences are reported as blockers by postgres-migration-audit.sh.
SELECT pg_catalog.format(
  $generated_query$
SELECT pg_catalog.format(
  'SELECT pg_catalog.setval(%%L::pg_catalog.regclass, %%s, %%L);',
  %L,
  last_value,
  is_called
)
FROM %I.%I;
$generated_query$,
  pg_catalog.format('%I.%I', sequence_namespace.nspname, sequence_class.relname),
  sequence_namespace.nspname,
  sequence_class.relname
)
FROM pg_catalog.pg_class AS sequence_class
JOIN pg_catalog.pg_namespace AS sequence_namespace
  ON sequence_namespace.oid = sequence_class.relnamespace
JOIN pg_catalog.pg_depend AS ownership
  ON ownership.classid = 'pg_catalog.pg_class'::pg_catalog.regclass
 AND ownership.objid = sequence_class.oid
 AND ownership.refclassid = 'pg_catalog.pg_class'::pg_catalog.regclass
 AND ownership.deptype IN ('a', 'i')
 AND ownership.refobjsubid > 0
JOIN pg_catalog.pg_class AS owner_class
  ON owner_class.oid = ownership.refobjid
JOIN pg_catalog.pg_namespace AS owner_namespace
  ON owner_namespace.oid = owner_class.relnamespace
JOIN pg_catalog.pg_attribute AS owner_attribute
  ON owner_attribute.attrelid = owner_class.oid
 AND owner_attribute.attnum = ownership.refobjsubid
 AND NOT owner_attribute.attisdropped
WHERE sequence_class.relkind = 'S'
  AND sequence_class.relpersistence = 'p'
  AND owner_class.relkind IN ('r', 'p')
  AND sequence_namespace.nspname NOT IN ('pg_catalog', 'information_schema')
  AND sequence_namespace.nspname NOT LIKE 'pg_toast%'
  AND sequence_namespace.nspname = ANY (
    pg_catalog.string_to_array(:'included_schemas', ',')
  )
  AND NOT sequence_namespace.nspname = ANY (
    pg_catalog.string_to_array(:'excluded_schemas', ',')
  )
  AND NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_depend AS extension_dependency
    WHERE extension_dependency.classid = 'pg_catalog.pg_class'::pg_catalog.regclass
      AND extension_dependency.objid IN (sequence_class.oid, owner_class.oid)
      AND extension_dependency.deptype = 'e'
  )
ORDER BY sequence_namespace.nspname, sequence_class.relname
\gexec
