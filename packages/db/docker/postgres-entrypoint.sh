#!/usr/bin/env bash
# Materialise the primary's TLS material, then hand off to the upstream entrypoint.
#
# Why the key arrives as a variable rather than in the image: this image is public
# on GHCR, so a server key can never be baked into it.
#
# Why it is written outside PGDATA: pg_basebackup copies the whole data directory
# and excludes only a fixed list of runtime files, so a key under PGDATA would be
# copied onto the DR standby's disk and into every WAL-G base backup. The DR
# design states that the backup host holds only the encryption *public* key, and
# a key under PGDATA would quietly break that. It goes on the volume instead, in
# a sibling directory, so it still survives a rebuild and a fresh deploy.
#
# With PG_TLS_SERVER_CERT and PG_TLS_SERVER_KEY unset this script changes
# nothing. That is what keeps local dev, CI, a fresh volume and the homelab DR
# standby -- which serves loopback only with ssl = off -- booting unchanged.

set -Eeuo pipefail

TLS_DIR="${PG_TLS_DIR:-/var/lib/postgresql/tls}"
TLS_CERT="$TLS_DIR/server.crt"
TLS_KEY="$TLS_DIR/server.key"
readonly TLS_DIR TLS_CERT TLS_KEY

log() { printf 'boardsesh-postgres: %s\n' "$1"; }
fail() {
  printf 'boardsesh-postgres: %s\n' "$1" >&2
  exit 1
}

# Every way the staged pair can be wrong, reported specifically.
staged_material_is_valid() {
  local cert_path="$1"
  local key_path="$2"

  if ! openssl x509 -noout -in "$cert_path" 2>/dev/null; then
    printf 'boardsesh-postgres: PG_TLS_SERVER_CERT is not a PEM certificate\n' >&2
    return 1
  fi
  if ! openssl pkey -noout -in "$key_path" 2>/dev/null; then
    printf 'boardsesh-postgres: PG_TLS_SERVER_KEY is not a PEM private key\n' >&2
    return 1
  fi

  # A mismatched pair is the failure worth catching here. PostgreSQL reveals it
  # only by refusing to start, and on a service with no shell that is a much
  # worse place to discover it than in this log line.
  local cert_pubkey key_pubkey
  cert_pubkey="$(openssl x509 -noout -pubkey -in "$cert_path")"
  key_pubkey="$(openssl pkey -pubout -in "$key_path")"
  if [[ "$cert_pubkey" != "$key_pubkey" ]]; then
    printf 'boardsesh-postgres: PG_TLS_SERVER_CERT and PG_TLS_SERVER_KEY are not a matching pair\n' >&2
    return 1
  fi
  return 0
}

# A pure test, so it is safe to call in condition context. Bash suspends errexit
# inside a function called there, which is why the mutating half below is kept
# out of it: a failed mkdir, chmod, mv or chown would otherwise be swallowed and
# the boot would continue with unusable TLS files, or silently without TLS.
tls_material_requested() {
  [[ -n "${PG_TLS_SERVER_CERT:-}" || -n "${PG_TLS_SERVER_KEY:-}" ]]
}

install_tls_material() {
  local cert="${PG_TLS_SERVER_CERT:-}"
  local key="${PG_TLS_SERVER_KEY:-}"

  # Failing closed matters more than convenience here: half a pair means someone
  # intended TLS and mis-wired it, and starting without it would look fine while
  # serving a snakeoil certificate the DR standby refuses.
  [[ -n "$cert" ]] || fail 'PG_TLS_SERVER_KEY is set but PG_TLS_SERVER_CERT is empty'
  [[ -n "$key" ]] || fail 'PG_TLS_SERVER_CERT is set but PG_TLS_SERVER_KEY is empty'

  mkdir -p "$TLS_DIR"
  chmod 0750 "$TLS_DIR"

  # Staged beside the real paths and validated there, so material that does not
  # validate is never installed -- and, more importantly, a bad variable update
  # cannot replace a working pair with a broken one and then exit. The previous
  # material stays exactly as it was.
  local cert_staged="$TLS_CERT.incoming"
  local key_staged="$TLS_KEY.incoming"

  # umask first, so both files are created 0600 and the key is never briefly
  # world-readable between the write and the chmod.
  local previous_umask
  previous_umask="$(umask)"
  umask 077
  printf '%s\n' "$cert" >"$cert_staged"
  printf '%s\n' "$key" >"$key_staged"
  umask "$previous_umask"

  if ! staged_material_is_valid "$cert_staged" "$key_staged"; then
    rm -f "$cert_staged" "$key_staged"
    fail 'refusing to install TLS material that does not validate'
  fi

  chmod 0644 "$cert_staged"
  chmod 0600 "$key_staged"
  mv -f "$cert_staged" "$TLS_CERT"
  mv -f "$key_staged" "$TLS_KEY"

  # PostgreSQL refuses a key it does not own, and the upstream entrypoint drops
  # to postgres via gosu after this runs.
  if [[ "$(id -u)" == '0' ]]; then
    chown postgres:postgres "$TLS_DIR" "$TLS_CERT" "$TLS_KEY"
  fi

  log "installed TLS material at $TLS_DIR ($(openssl x509 -noout -subject -enddate -in "$TLS_CERT" | tr '\n' ' '))"
}

# The upstream entrypoint treats a leading option as PostgreSQL's own and prepends
# `postgres` itself, so `docker run IMAGE -c shared_buffers=...` is a supported
# form. Normalise it first, or the check below would install the certificate and
# then start PostgreSQL without being told to use it.
if [[ "${1:-}" == -* ]]; then
  set -- postgres "$@"
fi

if tls_material_requested; then
  # Called outside condition context on purpose: errexit is live here, so a
  # failed mkdir, chmod, mv or chown stops the boot instead of being ignored.
  install_tls_material
else
  log 'PG_TLS_SERVER_CERT/KEY unset; leaving TLS configuration untouched'
fi

if tls_material_requested && [[ "${1:-}" == 'postgres' ]]; then
  shift
  # Command-line settings outrank postgresql.auto.conf, which is deliberate: it
  # makes the image authoritative, so an ALTER SYSTEM left over from an earlier
  # manual fix cannot silently shadow the declared paths.
  #
  # ssl_min_protocol_version is PostgreSQL's own default. It is stated rather
  # than assumed. Tightening the cipher list is deliberately NOT bundled with a
  # certificate rollout -- that is a separate, separately reviewed change.
  set -- postgres \
    -c ssl=on \
    -c "ssl_cert_file=$TLS_CERT" \
    -c "ssl_key_file=$TLS_KEY" \
    -c ssl_min_protocol_version=TLSv1.2 \
    "$@"
fi

exec docker-entrypoint.sh "$@"
