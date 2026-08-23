#!/usr/bin/env bash
#
# postgres18-spatial-surface.test.sh — keep the PostGIS blocker's evidence honest.
#
# docs/postgres-18-postgis-rehearsal.md records that the application's entire
# PostGIS surface crosses the 3.7.0dev -> 3.6.4 step intact, and that record is
# the justification for narrowing the version-equality gate in
# docs/postgres-18-migration.md to a capability check. That argument holds only
# while "the entire surface" is still the surface
# scripts/postgres18-spatial-rehearsal.sh actually exercises.
#
# Nothing else binds the two together. A migration adding ST_Buffer, or a
# resolver reaching for ST_Intersects, would silently invalidate the record
# while every existing check stayed green. This test is that binding: it
# inventories the PostGIS surface the repository really uses and fails when it
# grows past what the rehearsal covers.
#
# When it fails, the fix is not to extend the list here. It is to extend the
# rehearsal fixture, re-run it, and update the record — then add the function.
#
# This is the repository-side half of the same question. The runtime half lives
# in scripts/lib/postgres-spatial-capability.sh, which enumerates the same two
# dimensions -- ST_* references and geography columns -- out of a live catalog
# and requires the target to provide each one. They should agree about what "the
# spatial surface" means; a new spatial migration should trip this file, and a
# database that grew one anyway should trip that one.
#
# The runtime half sees two things this file does not, and both are deliberate:
# PostGIS operators (`&&`, `<->`) and operator classes, which have no ST_* name
# to grep for. If a migration ever introduces a spatial operator, expect the
# database-side manifest to grow a row that this file cannot explain -- that is
# the gap working, not a bug, but it is the moment to widen the scan here too.

set -Eeuo pipefail

REPOSITORY_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPOSITORY_ROOT"

readonly REHEARSAL_SCRIPT='scripts/postgres18-spatial-rehearsal.sh'
readonly REHEARSAL_RECORD='docs/postgres-18-postgis-rehearsal.md'

fail() {
  printf 'PostGIS spatial surface check failed: %s\n' "$*" >&2
  exit 1
}

[[ -f "$REHEARSAL_SCRIPT" ]] || fail "$REHEARSAL_SCRIPT is missing"
[[ -f "$REHEARSAL_RECORD" ]] || fail "$REHEARSAL_RECORD is missing"

# Functions the rehearsal actually executes against both PostGIS versions.
# ST_AsEWKB is the rehearsal's own measuring instrument rather than application
# usage; it is listed because the inventory below cannot tell the difference,
# and because it too has to behave identically on both sides.
REHEARSED_FUNCTIONS='ST_AsEWKB ST_AsText ST_Distance ST_DWithin ST_MakePoint'

# Every ST_* call site in first-party SQL and TypeScript. `dist/` is built
# output and `node_modules` is not ours. Tests are deliberately IN scope: a
# spatial query that exists only in a test fixture today is still a spatial
# query someone will promote tomorrow.
#
# The scan is case-insensitive and folds every hit to upper case. SQL does not
# care, so `st_dwithin(` is the same call as `ST_DWithin(` -- and the runtime
# half of this gate, the routine-body scan in
# scripts/lib/postgres-spatial-capability.sh, lowercases before matching for
# exactly that reason. A case-sensitive scan here would let a lowercase call
# site pass this file while the database-side manifest still reported it, which
# is the two halves disagreeing about what "the spatial surface" is.
inventory="$(
  grep -rnoEi '\bST_[A-Za-z][A-Za-z0-9_]*[[:space:]]*\(' \
    --include='*.sql' --include='*.ts' --include='*.tsx' \
    packages/ scripts/ 2>/dev/null |
    grep -v '/node_modules/' |
    grep -v '/dist/' |
    sed -E 's/.*([Ss][Tt]_[A-Za-z0-9_]+).*/\1/' |
    tr '[:lower:]' '[:upper:]' |
    sort -u
)"

# Fail closed. An empty inventory means the pattern, the paths, or grep itself
# broke -- not that the repository stopped using PostGIS. Treating empty as
# "nothing new" is precisely how a guard like this rots into a no-op.
[[ -n "$inventory" ]] ||
  fail 'the ST_* inventory came back empty; the scan is broken, and an empty scan must never read as "no new spatial usage"'

# REHEARSED_FUNCTIONS keeps its canonical mixed case because that is how the
# rehearsal script and the record spell it; membership is compared upper-folded
# so the two sides meet in the middle.
rehearsed_upper="$(printf '%s' "$REHEARSED_FUNCTIONS" | tr '[:lower:]' '[:upper:]')"
unrehearsed=''
while IFS= read -r spatial_function; do
  case " $rehearsed_upper " in
    *" $spatial_function "*) ;;
    *) unrehearsed="$unrehearsed $spatial_function" ;;
  esac
done <<<"$inventory"

if [[ -n "$unrehearsed" ]]; then
  fail "$(
    printf '%s\n' \
      "these PostGIS functions are used but not exercised by the rehearsal:$unrehearsed" \
      '' \
      "$REHEARSAL_RECORD claims the rehearsal covers the application's whole spatial" \
      'surface, and that claim is what justifies the narrowed PostGIS gate in' \
      'docs/postgres-18-migration.md. Extend the fixture in' \
      "$REHEARSAL_SCRIPT, re-run \`vp run test:postgres18-spatial-rehearsal\`," \
      'update the record with the new result, and only then add the function to' \
      'REHEARSED_FUNCTIONS here.'
  )"
fi

# The allowlist above must describe the fixture, not merely sit beside it. Every
# function claimed as rehearsed has to appear in the rehearsal script, or the
# list can drift into permitting things nothing ever runs.
for spatial_function in $REHEARSED_FUNCTIONS; do
  grep -Fqi "$spatial_function" "$REHEARSAL_SCRIPT" ||
    fail "$spatial_function is listed as rehearsed but does not appear in $REHEARSAL_SCRIPT"
done

# The other half of the surface: which tables carry a geography column. The
# rehearsal fixture reproduces gyms and user_boards; a third one would not be
# covered by anything above, because adding a column needs no ST_* call.
geography_tables="$(
  grep -rhoE '^ALTER TABLE [A-Za-z_]+ ADD COLUMN IF NOT EXISTS location geography' \
    packages/db/drizzle/*.sql 2>/dev/null |
    sed -E 's/^ALTER TABLE ([A-Za-z_]+).*/\1/' |
    sort -u | tr '\n' ' '
)"
[[ "$geography_tables" == 'gyms user_boards ' ]] ||
  fail "migrations add a geography column to: ${geography_tables:-<none found>}; the rehearsal fixture covers exactly 'gyms user_boards '. Reproduce the new table in $REHEARSAL_SCRIPT and re-run it before changing this expectation"

printf 'Spatial surface is %s, all rehearsed.\n' "$(printf '%s' "$inventory" | tr '\n' ' ')"
printf 'Geography columns: %s\n' "$geography_tables"
