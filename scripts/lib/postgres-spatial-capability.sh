#!/usr/bin/env bash
#
# postgres-spatial-capability.sh — the one definition of "the target supports
# everything this database does with PostGIS".
#
# Why this file exists at all
# ---------------------------
# `docs/postgres-18-migration.md` §1 used to block the PG16 -> PG18 catalog
# audit unless `pg_extension.extversion` was byte-identical on both sides.
# Railway production reports `3.7.0dev` only because the service tracks the
# mutable `postgis/postgis:16-master` tag; the attested PG18 artifact ships
# stable 3.6.4; PGDG publishes no stable 3.7 for PostgreSQL 18 and PostGIS
# ships no downgrade script. Neither side can be moved to meet the other, so a
# version-equality gate is not a gate — it is a permanent stop with no
# supported way through, and the only way past it would have been to waive it
# on judgement.
#
# `docs/postgres-18-postgis-rehearsal.md` answers the narrower question the
# decision actually needs: does everything this application does with PostGIS
# survive the step from 3.7.0dev to 3.6.4? It boots the production image beside
# the pinned artifact and matched 21 of 21 checks, including a byte comparison
# of `ST_AsEWKB` over every populated geography. This file turns that one-off
# answer into a standing gate: enumerate what the source really uses, and prove
# the target provides each item.
#
# The rule is deliberately narrow. PostGIS is the only extension whose version
# may differ, the target artifact is still pinned to an exact version, and every
# other extension is still compared exactly, version included.
#
# Both `scripts/postgres-migration-audit.sh` (read-only preflight, soft
# blockers) and `scripts/postgres-logical-replication.sh` (hard fail before any
# schema restore) source this file. They must not grow a second opinion: an
# audit that passes while `setup` aborts, or the reverse, is worse than either
# gate alone.

# The exact, tiny set of extensions whose recorded version may differ between
# source and target. It is a shell constant rather than an environment knob on
# purpose: an operator must not be able to widen the tolerance from a shell
# prompt at 3am, and `docs/postgres-18-migration.md` has said "there is no
# override flag" since the first draft. Adding a name here is a code change,
# and it is only defensible with a rehearsal like
# docs/postgres-18-postgis-rehearsal.md behind it.
#
# Note what this does NOT relax: `postgis_topology` and `postgis_tiger_geocoder`
# are separate extensions and stay strictly compared. A source carrying them
# with no target counterpart still blocks, by design — the intended production
# step is to drop them (they hold no live tuples), not to widen an allowlist.
BOARDSESH_VERSION_TOLERANT_EXTENSIONS='postgis'

# Rendered in place of the real version for a tolerant extension, on both sides,
# so a diff of the two manifests reads as "this line was decided elsewhere"
# rather than looking like the version check silently vanished.
BOARDSESH_TOLERANT_EXTENSION_VERSION_PLACEHOLDER='version-checked-by-capability'

# Space-separated identifiers -> a SQL IN list. Callers pass values they already
# validated with require_identifier; this is the last line of defence, so it
# refuses anything that is not a bare identifier rather than quoting it.
#
# The caller's own failure message names the gate that stopped, not the value
# that broke it, so say which value it was here. Without that, editing
# BOARDSESH_VERSION_TOLERANT_EXTENSIONS to something like `uuid-ossp` (a real
# extension name this deliberately rejects, because it is not a bare
# identifier) surfaces only as "could not build the extension manifest query".
boardsesh_sql_identifier_list() {
  local label="$1"
  local values="$2"
  local joined='' identifier
  for identifier in $values; do
    if [[ ! "$identifier" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]]; then
      printf '%s contains "%s", which is not a bare SQL identifier\n' \
        "$label" "$identifier" >&2
      return 1
    fi
    joined+="${joined:+, }'$identifier'"
  done
  if [[ -z "$joined" ]]; then
    printf '%s is empty; it must name at least one schema/extension\n' "$label" >&2
    return 1
  fi
  printf '%s' "$joined"
}

# The extension manifest both callers compare. Identical row shape to the
# strict manifest it replaces — extname|extversion|schema|relocatable — except
# that the version of a version-tolerant extension is replaced by the
# placeholder above, on both sides. Everything else, including which schema an
# extension lives in and whether it is relocatable, is still compared exactly.
#
# Ordering stays keyed on extname so the caller's `comm`/string comparison is
# still valid: the substitution never changes the sort key.
boardsesh_extension_manifest_sql() {
  local tolerant_list
  tolerant_list="$(boardsesh_sql_identifier_list \
    BOARDSESH_VERSION_TOLERANT_EXTENSIONS "$BOARDSESH_VERSION_TOLERANT_EXTENSIONS")" ||
    return 1
  cat <<SQL
SELECT extension.extname
       || '|' || CASE WHEN extension.extname IN (${tolerant_list})
                      THEN '${BOARDSESH_TOLERANT_EXTENSION_VERSION_PLACEHOLDER}'
                      ELSE extension.extversion END
       || '|' || namespace.nspname
       || '|' || extension.extrelocatable::text
FROM pg_catalog.pg_extension AS extension
JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = extension.extnamespace
WHERE extension.extname <> 'plpgsql'
ORDER BY extension.extname;
SQL
}

# The spatial capability manifest, read from the SOURCE.
#
# One row per distinct capability, rendered as a complete SQL VALUES tuple whose
# four fields are already `quote_literal`-quoted, so the gap query below can
# interpolate them without any shell-side escaping:
#
#   ('type',     'geography(Point,4326)',        'catalog',      'public.gyms.location')
#   ('opclass',  'gist/public.gist_geography_ops','catalog',     'public.gyms_location_idx')
#   ('operator', 'public.&&(geography,geography)','catalog',     'index public.gyms_bbox_idx')
#   ('function', 'st_makepoint',                 'routine-body', 'public.set_location_from_coordinates')
#
# Four dimensions, because no one of them sees the others:
#
#   type     every column whose type is, or is built over, a type belonging to
#            the postgis extension. See the normalisation note below for why the
#            token always names the postgis type rather than the column's.
#   opclass  every operator class an in-scope index actually selected that
#            belongs to postgis, so `gist_geography_ops` disappearing is a
#            blocker rather than a restore-time surprise.
#   operator every postgis operator an in-scope catalog object references. `&&`
#            and `<->` are how a GiST index is actually used, and an operator
#            carries no pg_proc edge of its own, so without this dimension a
#            future `WHERE location && :bbox` view or index predicate would be
#            spatial usage the gate silently tolerated.
#   function every postgis routine the source references.
#
# *** The function dimension cannot be answered from pg_depend alone. ***
# packages/db/drizzle/0127_backfill_gym_location_trigger.sql defines
# set_location_from_coordinates(), a plpgsql function whose body calls
# ST_MakePoint(...)::geography. PostgreSQL stores a plpgsql body as opaque text
# and records no dependency edge from it to anything it calls; an old-style
# string-bodied SQL function is stored the same way. (PostgreSQL 14's
# `BEGIN ATOMIC` bodies are the exception -- those ARE parsed at definition time
# and do record edges, which is why the catalog dimension already covers them.)
# A capability check built on catalog dependencies alone reports that this
# database uses no PostGIS functions at all. So routine bodies are ALSO scanned
# textually, and the two results are merged.
#
# What the textual scan can and cannot see, stated plainly because a gate that
# overstates its coverage is worse than one that admits a hole:
#   - it sees identifiers matching st_* / postgis_* followed by an open paren,
#     which is the whole of this repository's spatial surface today (see
#     scripts/postgres18-spatial-surface.test.sh, which fails when that stops
#     being true);
#   - it does NOT see PostGIS operators (`&&`, `<->`, `@`) or functions not named
#     st_*/postgis_* WHEN THEY APPEAR ONLY INSIDE A ROUTINE BODY. Used anywhere
#     the catalog records -- a view, an index expression or predicate, a
#     constraint, a default -- both are covered by the operator/function
#     dimensions above. The hole is body text, not the catalog;
#   - it does NOT see dynamic SQL assembled at runtime, or anything reached from
#     application code rather than from inside the database;
#   - it cannot resolve overloads, so the target is checked for the NAME, not
#     for a matching signature;
#   - it will over-report if a body merely mentions such a name in a comment or
#     a string. Over-reporting fails closed, which is the direction to err in.
#
# A textual hit is dropped ONLY when the name resolves exclusively to ordinary
# (non-postgis) routines: that is a user function, already covered exactly by
# the DDL manifest, and reporting it would turn every locally-named st_* helper
# into a permanent false blocker. The exclusivity matters and is not pedantry --
# postgis_topology ships its own st_srid/st_simplify/st_geometrytype, so a name
# that resolves to BOTH a postgis routine and something else is a real PostGIS
# capability that a "does any other routine share this name?" test would delete
# from the manifest. A hit that resolves to nothing at all is reported as
# `routine-body-unresolved`, because at that point the audit genuinely does not
# know what it is looking at and must say so.
#
# *** Type normalisation: the token always names a POSTGIS type. ***
# A column can reach a postgis type through a domain, an array, or both, at any
# depth. Rendering format_type(atttypid, atttypmod) for such a column emits the
# USER's type name -- `gps_point`, not `geography(Point,4326)` -- and the target
# is asked to provide a type only the restore this gate guards could have
# created. That is a rule nothing can satisfy: postgres-logical-replication.sh
# runs this check before the schema restore, so a single `CREATE DOMAIN ... AS
# geography` migration would wedge the cutover permanently. Worse, a domain over
# a domain, or an array of a domain, matched no branch at all and vanished from
# the manifest silently. So spatial_column_type below walks domains and arrays
# to the postgis type underneath and the token is rendered from THAT, with the
# typmod the column or the innermost domain pins. The user domain itself is not
# lost: the post-restore catalog DDL manifest already compares it byte for byte,
# which is the same division of labour the shadow-name rule above relies on.
#
# Extension-owned objects are excluded from scope throughout, exactly as the
# rest of the audit does it: PostGIS's own geometry_columns view and
# geometry_dump composite are not application usage, and counting them would
# bury the two rows that matter.
#
# Cost: every audit query runs under statement_timeout=30000. The catalog side
# is index-driven; the textual side runs one regexp over the bodies of the
# non-extension routines in scope, which is a few dozen rows in this database.
boardsesh_spatial_capability_manifest_sql() {
  local included_schemas_sql="$1"
  local excluded_schemas_sql="$2"
  cat <<SQL
-- RECURSIVE is here for spatial_column_type alone; every other CTE is a plain
-- one. A domain chain has no cycles and array-of-array does not exist in
-- PostgreSQL, so the walk always terminates.
WITH RECURSIVE scoped_namespace AS (
  SELECT namespace.oid, namespace.nspname
  FROM pg_catalog.pg_namespace AS namespace
  WHERE namespace.nspname IN (${included_schemas_sql})
    AND namespace.nspname NOT IN (${excluded_schemas_sql})
), spatial_extension AS (
  SELECT extension.oid
  FROM pg_catalog.pg_extension AS extension
  WHERE extension.extname = 'postgis'
), spatial_type AS (
  SELECT dependency.objid AS oid
  FROM pg_catalog.pg_depend AS dependency
  JOIN spatial_extension ON spatial_extension.oid = dependency.refobjid
  WHERE dependency.classid = 'pg_catalog.pg_type'::pg_catalog.regclass
    AND dependency.refclassid = 'pg_catalog.pg_extension'::pg_catalog.regclass
    AND dependency.deptype = 'e'
), spatial_routine AS (
  SELECT procedure.oid, procedure.proname
  FROM pg_catalog.pg_depend AS dependency
  JOIN spatial_extension ON spatial_extension.oid = dependency.refobjid
  JOIN pg_catalog.pg_proc AS procedure ON procedure.oid = dependency.objid
  WHERE dependency.classid = 'pg_catalog.pg_proc'::pg_catalog.regclass
    AND dependency.refclassid = 'pg_catalog.pg_extension'::pg_catalog.regclass
    AND dependency.deptype = 'e'
), spatial_operator AS (
  SELECT operator_row.oid,
         pg_catalog.format('%I.%s(%s,%s)', operator_namespace.nspname,
           operator_row.oprname,
           CASE WHEN operator_row.oprleft = 0 THEN ''
                ELSE pg_catalog.format_type(operator_row.oprleft, NULL) END,
           CASE WHEN operator_row.oprright = 0 THEN ''
                ELSE pg_catalog.format_type(operator_row.oprright, NULL) END) AS token
  FROM pg_catalog.pg_depend AS dependency
  JOIN spatial_extension ON spatial_extension.oid = dependency.refobjid
  JOIN pg_catalog.pg_operator AS operator_row ON operator_row.oid = dependency.objid
  JOIN pg_catalog.pg_namespace AS operator_namespace
    ON operator_namespace.oid = operator_row.oprnamespace
  WHERE dependency.classid = 'pg_catalog.pg_operator'::pg_catalog.regclass
    AND dependency.refclassid = 'pg_catalog.pg_extension'::pg_catalog.regclass
    AND dependency.deptype = 'e'
), spatial_operator_class AS (
  SELECT dependency.objid AS oid
  FROM pg_catalog.pg_depend AS dependency
  JOIN spatial_extension ON spatial_extension.oid = dependency.refobjid
  WHERE dependency.classid = 'pg_catalog.pg_opclass'::pg_catalog.regclass
    AND dependency.refclassid = 'pg_catalog.pg_extension'::pg_catalog.regclass
    AND dependency.deptype = 'e'
), spatial_column_type AS (
  -- Every type that IS a postgis type, plus every domain over one and every
  -- array of one, to any depth and in any combination -- each mapped back to
  -- the postgis type underneath and to the typmod pinned along the way. See the
  -- type-normalisation note above the function: rendering a column's own type
  -- name here would ask the target for a type that only the guarded restore
  -- could create, and would miss a nested domain outright.
  --
  -- The seed deliberately skips array types even though PostGIS's _geography
  -- and _geometry are extension members in their own right. Seeding them would
  -- also reach an array column by the identity path and emit a second,
  -- unreduced geography(Point,4326)[] row beside the reduced one. Reaching
  -- arrays only through the recursive step keeps exactly one token per column.
  -- (No backticks in this heredoc: it is unquoted so the shell can interpolate
  -- the schema lists, which means a backtick in a comment runs as a command.)
  SELECT postgis_type.oid AS oid, postgis_type.oid AS spatial_oid,
         (-1)::integer AS spatial_typmod
  FROM pg_catalog.pg_type AS postgis_type
  WHERE postgis_type.oid IN (SELECT oid FROM spatial_type)
    AND postgis_type.typcategory <> 'A'
  UNION ALL
  SELECT derived.oid, spatial_column_type.spatial_oid,
         CASE WHEN derived.typtypmod <> -1 THEN derived.typtypmod
              ELSE spatial_column_type.spatial_typmod END
  FROM spatial_column_type
  JOIN pg_catalog.pg_type AS derived
    ON (derived.typtype = 'd' AND derived.typbasetype = spatial_column_type.oid)
    OR (derived.typcategory = 'A' AND derived.typelem = spatial_column_type.oid)
), scoped_relation AS (
  SELECT relation.oid
  FROM pg_catalog.pg_class AS relation
  JOIN scoped_namespace ON scoped_namespace.oid = relation.relnamespace
  WHERE NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_depend AS extension_dependency
    WHERE extension_dependency.classid = 'pg_catalog.pg_class'::pg_catalog.regclass
      AND extension_dependency.objid = relation.oid
      AND extension_dependency.deptype = 'e'
  )
  -- A composite type created by CREATE TYPE records its extension membership
  -- against pg_type, not against the pg_class row that carries its columns.
  -- Without this second exclusion PostGIS's own geometry_dump and valid_detail
  -- composites report a bare 'geometry' column requirement and bury the two
  -- application rows that matter.
  AND NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_depend AS composite_extension_dependency
    WHERE composite_extension_dependency.classid = 'pg_catalog.pg_type'::pg_catalog.regclass
      AND composite_extension_dependency.objid = relation.reltype
      AND composite_extension_dependency.deptype = 'e'
  )
), scoped_routine AS (
  SELECT procedure.oid, procedure.prosrc, procedure.proname, scoped_namespace.nspname
  FROM pg_catalog.pg_proc AS procedure
  JOIN scoped_namespace ON scoped_namespace.oid = procedure.pronamespace
  WHERE NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_depend AS extension_dependency
    WHERE extension_dependency.classid = 'pg_catalog.pg_proc'::pg_catalog.regclass
      AND extension_dependency.objid = procedure.oid
      AND extension_dependency.deptype = 'e'
  )
), scoped_dependent AS (
  SELECT 'pg_catalog.pg_class'::pg_catalog.regclass AS classid, oid AS objid
  FROM scoped_relation
  UNION ALL
  SELECT 'pg_catalog.pg_proc'::pg_catalog.regclass, oid FROM scoped_routine
  UNION ALL
  SELECT 'pg_catalog.pg_type'::pg_catalog.regclass, type_row.oid
  FROM pg_catalog.pg_type AS type_row
  JOIN scoped_namespace ON scoped_namespace.oid = type_row.typnamespace
  WHERE NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_depend AS extension_dependency
    WHERE extension_dependency.classid = 'pg_catalog.pg_type'::pg_catalog.regclass
      AND extension_dependency.objid = type_row.oid
      AND extension_dependency.deptype = 'e'
  )
  UNION ALL
  SELECT 'pg_catalog.pg_attrdef'::pg_catalog.regclass, default_row.oid
  FROM pg_catalog.pg_attrdef AS default_row
  JOIN scoped_relation ON scoped_relation.oid = default_row.adrelid
  UNION ALL
  SELECT 'pg_catalog.pg_constraint'::pg_catalog.regclass, constraint_row.oid
  FROM pg_catalog.pg_constraint AS constraint_row
  WHERE (constraint_row.conrelid IN (SELECT oid FROM scoped_relation)
      OR constraint_row.connamespace IN (SELECT oid FROM scoped_namespace))
    AND NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_depend AS extension_dependency
      WHERE extension_dependency.classid = 'pg_catalog.pg_constraint'::pg_catalog.regclass
        AND extension_dependency.objid = constraint_row.oid
        AND extension_dependency.deptype = 'e'
    )
  UNION ALL
  SELECT 'pg_catalog.pg_rewrite'::pg_catalog.regclass, rule_row.oid
  FROM pg_catalog.pg_rewrite AS rule_row
  JOIN scoped_relation ON scoped_relation.oid = rule_row.ev_class
  UNION ALL
  SELECT 'pg_catalog.pg_trigger'::pg_catalog.regclass, trigger_row.oid
  FROM pg_catalog.pg_trigger AS trigger_row
  JOIN scoped_relation ON scoped_relation.oid = trigger_row.tgrelid
), capability AS (
  -- The typmod is taken from the column when it carries one (a plain or array
  -- geography column) and from the domain chain when it does not (a domain
  -- column's atttypmod is -1; the domain pins the typmod in pg_type instead).
  SELECT 'type'::text AS kind,
         pg_catalog.format_type(spatial_column_type.spatial_oid,
           CASE WHEN attribute.atttypmod <> -1 THEN attribute.atttypmod
                ELSE spatial_column_type.spatial_typmod END) AS token,
         'catalog'::text AS source_state,
         pg_catalog.format('%I.%I.%I', scoped_namespace.nspname, relation.relname,
           attribute.attname) AS identity
  FROM pg_catalog.pg_attribute AS attribute
  JOIN pg_catalog.pg_class AS relation ON relation.oid = attribute.attrelid
  JOIN scoped_relation ON scoped_relation.oid = relation.oid
  JOIN scoped_namespace ON scoped_namespace.oid = relation.relnamespace
  JOIN spatial_column_type ON spatial_column_type.oid = attribute.atttypid
  WHERE attribute.attnum > 0
    AND NOT attribute.attisdropped
    AND relation.relkind IN ('r', 'p', 'v', 'm', 'c', 'f')

  UNION ALL

  SELECT 'opclass',
         pg_catalog.format('%I/%I.%I', access_method.amname, opclass_namespace.nspname,
           operator_class.opcname),
         'catalog',
         pg_catalog.format('%I.%I', scoped_namespace.nspname, index_class.relname)
  FROM pg_catalog.pg_index AS index_row
  JOIN pg_catalog.pg_class AS index_class ON index_class.oid = index_row.indexrelid
  JOIN scoped_relation ON scoped_relation.oid = index_class.oid
  JOIN scoped_namespace ON scoped_namespace.oid = index_class.relnamespace
  CROSS JOIN LATERAL pg_catalog.unnest(index_row.indclass::pg_catalog.oid[])
    AS index_operator_class(oid)
  JOIN pg_catalog.pg_opclass AS operator_class ON operator_class.oid = index_operator_class.oid
  JOIN pg_catalog.pg_namespace AS opclass_namespace
    ON opclass_namespace.oid = operator_class.opcnamespace
  JOIN pg_catalog.pg_am AS access_method ON access_method.oid = operator_class.opcmethod
  WHERE operator_class.oid IN (SELECT oid FROM spatial_operator_class)

  UNION ALL

  -- Operators are catalog-visible wherever they are used in something the
  -- planner had to parse: a view or rule, an index expression or predicate, a
  -- constraint, a column default. That is the same edge set the function
  -- dimension below reads, so both share scoped_dependent.
  SELECT 'operator', spatial_operator.token, 'catalog',
         pg_catalog.pg_describe_object(dependency.classid, dependency.objid, 0)
  FROM pg_catalog.pg_depend AS dependency
  JOIN scoped_dependent ON scoped_dependent.classid = dependency.classid
                       AND scoped_dependent.objid = dependency.objid
  JOIN spatial_operator ON spatial_operator.oid = dependency.refobjid
  WHERE dependency.refclassid = 'pg_catalog.pg_operator'::pg_catalog.regclass

  UNION ALL

  SELECT 'function', spatial_routine.proname, 'catalog',
         pg_catalog.pg_describe_object(dependency.classid, dependency.objid, 0)
  FROM pg_catalog.pg_depend AS dependency
  JOIN scoped_dependent ON scoped_dependent.classid = dependency.classid
                       AND scoped_dependent.objid = dependency.objid
  JOIN spatial_routine ON spatial_routine.oid = dependency.refobjid
  WHERE dependency.refclassid = 'pg_catalog.pg_proc'::pg_catalog.regclass

  UNION ALL

  SELECT 'function', spatial_reference.match[1],
         CASE
           WHEN EXISTS (
             SELECT 1 FROM spatial_routine
             WHERE spatial_routine.proname = spatial_reference.match[1]
           ) THEN 'routine-body'
           ELSE 'routine-body-unresolved'
         END,
         pg_catalog.format('%I.%I', scoped_routine.nspname, scoped_routine.proname)
  FROM scoped_routine
  CROSS JOIN LATERAL pg_catalog.regexp_matches(
    pg_catalog.lower(scoped_routine.prosrc),
    '\\m(st_[a-z0-9_]+|postgis_[a-z0-9_]+)[[:space:]]*\\(', 'g') AS spatial_reference(match)
  -- Keep the reference when postgis provides the name, because then it is a
  -- PostGIS capability whatever else shares the name. Keep it when NOTHING
  -- provides the name, because then the CASE above has already marked it
  -- unresolved and both callers block on that. Drop it only in the remaining
  -- case: the name resolves, but exclusively to routines postgis does not own,
  -- which makes it a user function the DDL manifest already compares exactly.
  --
  -- Testing "does any other routine share this name?" instead is the fail-open
  -- this is shaped to avoid: postgis_topology ships st_srid, st_simplify and
  -- st_geometrytype of its own, and production still has that extension
  -- installed, so a body calling core ST_SRID would have vanished from the
  -- manifest entirely and the target would never have been asked for it.
  WHERE EXISTS (
    SELECT 1 FROM spatial_routine
    WHERE spatial_routine.proname = spatial_reference.match[1]
  )
  OR NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_proc AS resolved
    WHERE resolved.proname = spatial_reference.match[1]
  )
)
-- min(source_state) leans on the alphabetical order
-- catalog < routine-body < routine-body-unresolved, and on the fact that
-- 'routine-body-unresolved' is only ever produced when postgis owns no routine
-- of that name -- in which case no 'catalog' row for it can exist either, since
-- catalog rows come from spatial_routine. So an unresolved reference can never
-- be aggregated away by a resolvable sibling. Both callers block on the
-- unresolved marker surviving into this output; do not reorder these states.
--
-- Each field leaves here already quote_literal-quoted, because the gap query
-- interpolates these tuples into a VALUES list verbatim. The nesting order is
-- load-bearing: translate strips newlines and tabs so one row cannot become
-- two, left() truncates BEFORE quote_literal so truncation cannot land inside
-- an escape it just produced, and quote_literal is outermost so whatever
-- survives is a single well-formed literal. Reordering these reopens both row
-- splitting and injection through a catalog identifier.
SELECT pg_catalog.format('(%s, %s, %s, %s)',
         pg_catalog.quote_literal(kind),
         pg_catalog.quote_literal(token),
         pg_catalog.quote_literal(pg_catalog.min(source_state)),
         pg_catalog.quote_literal(pg_catalog.left(
           pg_catalog.string_agg(DISTINCT pg_catalog.translate(identity, E'\\n\\r\\t', '   '), ', '),
           200)))
FROM capability
GROUP BY kind, token
ORDER BY kind, token;
SQL
}

# Given the source manifest, ask the TARGET which rows it cannot satisfy.
#
# The manifest arrives as complete, already-quoted VALUES tuples, so nothing is
# escaped here; the rows are catalog-derived and passed through quote_literal on
# the way out of the source.
#
# Satisfaction is deliberately by rendered identity rather than by OID: the two
# databases share no OIDs, and the thing being proven is that the target's own
# PostGIS build offers the same named capability.
#   type     to_regtype resolves the token AND the resolved type belongs to the
#            target's postgis extension. The manifest has already normalised
#            every column down to the postgis type underneath, so there is no
#            domain or array to unwrap here -- a token that is not a postgis
#            type name is a bug upstream, not something to be tolerant of.
#            to_regtype ignores the typmod, so this proves `geography` exists,
#            not that `(Point,4326)` parses; exact typmod equality is already
#            the catalog DDL manifest's job, which compares
#            format_type(atttypid, atttypmod) byte for byte after the restore.
#            The typmod is kept in the token so the two reports name the same
#            thing.
#   opclass  the target has an operator class with the same access
#            method/schema/name that belongs to its postgis extension.
#   operator the target's postgis provides an operator with the same
#            schema/name/operand types. Operand types are compared by rendered
#            name because the two databases share no OIDs.
#   function the target's postgis provides at least one routine of that name.
#            Name, not signature -- the textual scan upstream cannot resolve
#            overloads, so claiming signature coverage would be a lie.
#
# Rows come back delimited by the ASCII unit separator rather than `|`, because
# a token or an identity is a rendered catalog identifier and a quoted
# identifier may legally contain a pipe. A garbled split would still block (the
# row is non-empty either way) but it would print the wrong sentence about it.
boardsesh_spatial_capability_gap_sql() {
  local manifest_values="$1"
  cat <<SQL
WITH required(kind, token, source_state, identities) AS (
  VALUES ${manifest_values}
), spatial_extension AS (
  SELECT extension.oid
  FROM pg_catalog.pg_extension AS extension
  WHERE extension.extname = 'postgis'
), spatial_type AS (
  SELECT dependency.objid AS oid
  FROM pg_catalog.pg_depend AS dependency
  JOIN spatial_extension ON spatial_extension.oid = dependency.refobjid
  WHERE dependency.classid = 'pg_catalog.pg_type'::pg_catalog.regclass
    AND dependency.refclassid = 'pg_catalog.pg_extension'::pg_catalog.regclass
    AND dependency.deptype = 'e'
), spatial_routine AS (
  SELECT procedure.proname
  FROM pg_catalog.pg_depend AS dependency
  JOIN spatial_extension ON spatial_extension.oid = dependency.refobjid
  JOIN pg_catalog.pg_proc AS procedure ON procedure.oid = dependency.objid
  WHERE dependency.classid = 'pg_catalog.pg_proc'::pg_catalog.regclass
    AND dependency.refclassid = 'pg_catalog.pg_extension'::pg_catalog.regclass
    AND dependency.deptype = 'e'
), spatial_operator_class AS (
  SELECT pg_catalog.format('%I/%I.%I', access_method.amname, opclass_namespace.nspname,
           operator_class.opcname) AS token
  FROM pg_catalog.pg_depend AS dependency
  JOIN spatial_extension ON spatial_extension.oid = dependency.refobjid
  JOIN pg_catalog.pg_opclass AS operator_class ON operator_class.oid = dependency.objid
  JOIN pg_catalog.pg_namespace AS opclass_namespace
    ON opclass_namespace.oid = operator_class.opcnamespace
  JOIN pg_catalog.pg_am AS access_method ON access_method.oid = operator_class.opcmethod
  WHERE dependency.classid = 'pg_catalog.pg_opclass'::pg_catalog.regclass
    AND dependency.refclassid = 'pg_catalog.pg_extension'::pg_catalog.regclass
    AND dependency.deptype = 'e'
), spatial_operator AS (
  SELECT pg_catalog.format('%I.%s(%s,%s)', operator_namespace.nspname,
           operator_row.oprname,
           CASE WHEN operator_row.oprleft = 0 THEN ''
                ELSE pg_catalog.format_type(operator_row.oprleft, NULL) END,
           CASE WHEN operator_row.oprright = 0 THEN ''
                ELSE pg_catalog.format_type(operator_row.oprright, NULL) END) AS token
  FROM pg_catalog.pg_depend AS dependency
  JOIN spatial_extension ON spatial_extension.oid = dependency.refobjid
  JOIN pg_catalog.pg_operator AS operator_row ON operator_row.oid = dependency.objid
  JOIN pg_catalog.pg_namespace AS operator_namespace
    ON operator_namespace.oid = operator_row.oprnamespace
  WHERE dependency.classid = 'pg_catalog.pg_operator'::pg_catalog.regclass
    AND dependency.refclassid = 'pg_catalog.pg_extension'::pg_catalog.regclass
    AND dependency.deptype = 'e'
)
SELECT required.kind || E'\x1f' || required.token || E'\x1f' || required.source_state
       || E'\x1f' || required.identities
FROM required
-- ELSE false: a kind this query does not recognise is always a gap. A future
-- dimension added to the manifest and forgotten here blocks loudly instead of
-- passing silently, which is the only safe default for a gate.
WHERE NOT CASE required.kind
  WHEN 'type' THEN EXISTS (
    SELECT 1
    FROM pg_catalog.pg_type AS target_type
    WHERE target_type.oid = pg_catalog.to_regtype(required.token)
      AND target_type.oid IN (SELECT oid FROM spatial_type)
  )
  WHEN 'opclass' THEN EXISTS (
    SELECT 1 FROM spatial_operator_class
    WHERE spatial_operator_class.token = required.token
  )
  WHEN 'operator' THEN EXISTS (
    SELECT 1 FROM spatial_operator WHERE spatial_operator.token = required.token
  )
  WHEN 'function' THEN EXISTS (
    SELECT 1 FROM spatial_routine WHERE spatial_routine.proname = required.token
  )
  ELSE false
END
ORDER BY 1;
SQL
}

# One gap row -> the sentence both callers print. Shared so the audit's soft
# blocker and the replication helper's hard fail cannot drift into describing
# the same catalog fact differently.
boardsesh_describe_spatial_capability_gap() {
  local gap_row="$1"
  local unit_separator=$'\x1f'
  local kind="${gap_row%%${unit_separator}*}"
  local remainder="${gap_row#*${unit_separator}}"
  local token="${remainder%%${unit_separator}*}"
  remainder="${remainder#*${unit_separator}}"
  local source_state="${remainder%%${unit_separator}*}"
  local identities="${remainder#*${unit_separator}}"
  if [[ "$source_state" == 'routine-body-unresolved' ]]; then
    printf 'spatial %s "%s", referenced by %s, resolves to no PostGIS routine on either side; the audit cannot classify it and will not assume the target provides it' \
      "$kind" "$token" "$identities"
    return 0
  fi
  printf 'the target PostGIS build does not provide %s "%s", which the source uses in %s' \
    "$kind" "$token" "$identities"
}
