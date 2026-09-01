#!/usr/bin/env bash
set -Eeuo pipefail

VALIDATION_WORKFLOW="${1:-.github/workflows/dev-db-docker.yml}"
CONTRACT_TASK_CONFIG="${2:-vite.config.ts}"
CONTRACT_SCRIPT="${3:-scripts/postgres18-contract.sh}"
MIGRATION_AUDIT_SCRIPT="${4:-scripts/postgres-migration-audit.sh}"
[[ -f "$VALIDATION_WORKFLOW" ]]
[[ -f "$CONTRACT_TASK_CONFIG" ]]
[[ -f "$CONTRACT_SCRIPT" ]]
[[ -f "$MIGRATION_AUDIT_SCRIPT" ]]

fail() {
  printf 'PostgreSQL image workflow contract failed: %s\n' "$*" >&2
  exit 1
}

# PostgreSQL deliberately uses different object-type discriminators in these
# two catalog APIs: acldefault() names a sequence with lowercase `s`, while
# pg_default_acl.defaclobjtype names one with uppercase `S`. Mixing them makes
# the runtime audit ask for a foreign-server default ACL instead of a sequence
# ACL whenever pg_class.relacl is NULL.
grep -Fq "pg_catalog.acldefault('s', sequence.relowner)" "$MIGRATION_AUDIT_SCRIPT" ||
  fail 'the migration audit must use the lowercase sequence discriminator for acldefault()'
if grep -Fq "pg_catalog.acldefault('S', sequence.relowner)" "$MIGRATION_AUDIT_SCRIPT"; then
  fail 'uppercase S is the acldefault() foreign-server discriminator, not sequence'
fi

# Candidate-controlled pull-request and branch workflows are structurally
# incapable of registry/package/OIDC mutation.
# `test-db-setup` is gone with the pgloader sidecar image it built: the seeded
# image now loads its catalogue from the published board snapshots, so there is
# no second Dockerfile left to validate.
[[ "$(grep -cE '^  (test-postgres-postgis|test-dev-db):$' "$VALIDATION_WORKFLOW")" == '2' ]] ||
  fail 'the two read-only image validation jobs must remain explicit'
grep -Fq 'permissions:' "$VALIDATION_WORKFLOW"
grep -Fq '  contents: read' "$VALIDATION_WORKFLOW"
if grep -qE 'workflow_dispatch|packages: write|id-token: write|docker/login-action|attest-build-provenance|environment:' \
  "$VALIDATION_WORKFLOW"; then
  fail 'candidate-controlled validation must not dispatch or contain registry/OIDC/environment mutation capability'
fi
if grep -qE 'cache-to:|actions/cache|actions/upload-artifact|DOCKER_BUILD_RECORD_UPLOAD: .true.' \
  "$VALIDATION_WORKFLOW"; then
  fail 'candidate-controlled validation must not write Actions caches or artifacts'
fi
[[ "$(grep -cF "DOCKER_BUILD_RECORD_UPLOAD: 'false'" "$VALIDATION_WORKFLOW")" == '2' ]] ||
  fail 'every branch-controlled image build must disable build-record uploads'
! grep -qE '^  pull_request_target:' "$VALIDATION_WORKFLOW" || fail 'pull_request_target is forbidden'

# `- uses:` is the ordinary list-item form, so anchoring on `uses:` alone would
# exempt every step written that way from the SHA pin.
if grep -E '^[[:space:]]*-?[[:space:]]*uses:' "$VALIDATION_WORKFLOW" |
  grep -vE 'uses: [^@]+@[0-9a-f]{40} # ' >/dev/null; then
  fail 'every third-party action in branch-controlled validation must use a reviewed full commit SHA with its tag comment'
fi

# Every branch-controlled validation job that builds or boots ARM64 installs
# QEMU. Only the portable-image job does now — the seeded image is amd64-only
# until the publisher gains a native ARM64 runner (docs/postgres-18-migration.md).
# Published-digest smoke and publisher trust are enforced by the separate
# prerequisite workflow after it lands on protected main.
[[ "$(grep -cE 'docker/setup-qemu-action@[0-9a-f]{40}' "$VALIDATION_WORKFLOW")" == '1' ]] ||
  fail 'the validation job that covers ARM64 must install QEMU'

# `vp run test:postgres18-contract` runs on a pull request from exactly one
# place: this workflow. Every file it executes or syntax-checks must therefore
# be covered by the shared `paths` anchor, or a PR that breaks that file merges
# green and the break only surfaces inside the trusted publisher's validate-main
# job, which hard-stops a cutover and needs a fresh producer commit and
# re-dispatch. Parse the real command out of the task config instead of
# restating the list here, and fail closed whenever the parse does not resolve.
config_text="$(<"$CONTRACT_TASK_CONFIG")"
[[ "$config_text" == *"'test:postgres18-contract':"* ]] ||
  fail "$CONTRACT_TASK_CONFIG does not define a test:postgres18-contract task"
[[ "$config_text" == *"command: 'bash $CONTRACT_SCRIPT'"* ]] ||
  fail "test:postgres18-contract must delegate to $CONTRACT_SCRIPT"
contract_command="$(<"$CONTRACT_SCRIPT")"
# The syntax-check tail is the part most easily forgotten in a path filter, so
# treat its absence as a parse failure rather than as "nothing to check".
[[ "$contract_command" == *'bash -n '* ]] ||
  fail "$CONTRACT_SCRIPT must contain the bash -n contract file list"

# Everything below proves the anchor covers the contract files. That only means
# anything if the pull_request trigger actually resolves to the anchor and fires
# for every PR, so pin the whole trigger: an inlined literal list, or any extra
# narrowing key beside the anchor, would leave the coverage message true about a
# filter no PR ever runs.
path_filters=()
in_path_anchor=false
in_pull_request=false
pull_request_uses_anchor=false
pull_request_narrowed=false
while IFS= read -r workflow_line; do
  if [[ "$workflow_line" == '  pull_request:' ]]; then
    in_pull_request=true
  elif [[ "$in_pull_request" == true ]]; then
    if [[ "$workflow_line" == '    paths: *database_image_paths' ]]; then
      pull_request_uses_anchor=true
    fi
    # `paths` is the only filter the anchor covers. Any sibling narrowing key
    # can exclude the PRs that touch the contract files, so treat one as fatal
    # rather than trying to model its semantics here.
    if [[ "$workflow_line" =~ ^[[:space:]]{4}(branches|branches-ignore|paths-ignore|types): ]]; then
      pull_request_narrowed=true
    fi
    # YAML keeps a block mapping open across blank lines and full-line comments,
    # so neither may close it here — otherwise one extra newline before a
    # narrowing key hides that key from both checks below. Only a content line
    # indented two spaces or less ends the mapping.
    if [[ -n "${workflow_line//[[:space:]]/}" ]] &&
      [[ ! "$workflow_line" =~ ^[[:space:]]*# ]] &&
      [[ ! "$workflow_line" =~ ^[[:space:]]{3} ]]; then
      in_pull_request=false
    fi
  fi
  if [[ "$workflow_line" == *'paths: &database_image_paths'* ]]; then
    in_path_anchor=true
    continue
  fi
  if [[ "$in_path_anchor" == true ]]; then
    if [[ -z "${workflow_line//[[:space:]]/}" ]] || [[ "$workflow_line" =~ ^[[:space:]]*# ]]; then
      continue
    elif [[ "$workflow_line" =~ ^[[:space:]]+-[[:space:]]+\'([^\']+)\'[[:space:]]*$ ]]; then
      path_filters+=("${BASH_REMATCH[1]}")
    else
      # The anchor list ends here, but the pull_request trigger is defined below
      # it, so keep reading instead of leaving the loop.
      in_path_anchor=false
    fi
  fi
done <"$VALIDATION_WORKFLOW"
[[ "${#path_filters[@]}" -gt 0 ]] ||
  fail 'could not parse the &database_image_paths anchor entries'
[[ "$pull_request_uses_anchor" == true ]] ||
  fail 'pull_request must filter on "paths: *database_image_paths"; an inlined list makes the coverage check below prove nothing about pull requests'
[[ "$pull_request_narrowed" == false ]] ||
  fail 'pull_request must carry no filter beside "paths: *database_image_paths"; a branches/branches-ignore/paths-ignore/types key makes the coverage check below prove nothing about pull requests'

path_filter_covers() {
  local candidate="$1" filter pattern
  for filter in "${path_filters[@]}"; do
    # GitHub's `**` crosses directory separators and bash's `*` already does the
    # same inside `[[ == ]]`, so collapsing the two is an exact translation.
    pattern="${filter//\*\*/\*}"
    # shellcheck disable=SC2053
    if [[ "$candidate" == $pattern ]]; then
      return 0
    fi
  done
  return 1
}

# The seeded image copies the whole scripts directory for a simple Docker layer,
# but executes only these entry points and their local imports. A blanket
# packages/db/scripts/** trigger rebuilt two heavyweight images for unrelated
# migration/admin utilities. Prove every script that can execute in the image is
# still covered by the narrow filter, including transitive local imports.
for path_filter in "${path_filters[@]}"; do
  [[ "$path_filter" != 'packages/db/scripts/**' ]] ||
    fail 'database image paths must name executable seed scripts, not all packages/db/scripts'
done

seed_script_queue=(
  packages/db/scripts/load-board-snapshots.ts
  packages/db/scripts/create-test-user.ts
  packages/db/scripts/seed-social.ts
)
# PostgreSQL role-transition smokes invoke this real-database contract directly.
# Its two local imports are therefore workflow inputs even though the seeded
# image builder itself does not execute them.
seed_script_queue+=(packages/db/scripts/migration-owner-role.integration.test.ts)
seed_scripts_seen='|'
while [[ "${#seed_script_queue[@]}" -gt 0 ]]; do
  seed_script="${seed_script_queue[0]}"
  seed_script_queue=("${seed_script_queue[@]:1}")
  [[ "$seed_scripts_seen" != *"|$seed_script|"* ]] || continue
  seed_scripts_seen+="$seed_script|"
  [[ -f "$seed_script" ]] || fail "seeded image references missing script $seed_script"
  path_filter_covers "$seed_script" ||
    fail "$seed_script executes in Dockerfile.dev-db but is not matched by the database image filter"

  while IFS= read -r local_import; do
    imported_path="$(dirname "$seed_script")/${local_import#./}"
    imported_path="${imported_path%.js}.ts"
    [[ -f "$imported_path" ]] || continue
    seed_script_queue+=("$imported_path")
  done < <(grep -Eo "from ['\"]\./[^'\"]+['\"]" "$seed_script" | sed -E "s/^from ['\"](.*)['\"]$/\1/")
done

contract_tokens=()
while IFS= read -r contract_line; do
  read -r -a contract_line_tokens <<<"$contract_line"
  contract_tokens+=("${contract_line_tokens[@]}")
done <<<"$contract_command"
contract_file_count=0
for contract_token in "${contract_tokens[@]}"; do
  [[ "$contract_token" == *.sh || "$contract_token" == *.ts ]] || continue
  [[ "$contract_token" != -* ]] || continue
  contract_file_count=$((contract_file_count + 1))
  [[ -f "$contract_token" ]] ||
    fail "test:postgres18-contract references missing file $contract_token"
  path_filter_covers "$contract_token" ||
    fail "$contract_token is validated by test:postgres18-contract but is not matched by the &database_image_paths filter"
done
[[ "$contract_file_count" -ge 10 ]] ||
  fail "only parsed $contract_file_count contract-validated files; the command parse is not trustworthy"

printf 'PostgreSQL image pull-request and branch validation is externally read-only.\n'
printf 'All %s contract-validated files are covered by the workflow path filter.\n' "$contract_file_count"
