#!/usr/bin/env bash
set -Eeuo pipefail

TEST_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/boardsesh-pg-tls-entrypoint.XXXXXX")"
readonly TEST_ROOT
trap 'rm -rf "$TEST_ROOT"' EXIT

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly SCRIPT_DIR
readonly ENTRYPOINT="$SCRIPT_DIR/postgres-entrypoint.sh"
readonly FAKE_BIN="$TEST_ROOT/bin"
readonly ARGS_LOG="$TEST_ROOT/handoff-args"

mkdir -p "$FAKE_BIN"

# Stand in for the upstream entrypoint and record exactly what it was handed, so
# the tests assert on the real handoff rather than on the wrapper's own output.
cat >"$FAKE_BIN/docker-entrypoint.sh" <<STUB
#!/usr/bin/env bash
printf '%s\n' "\$@" >"$ARGS_LOG"
STUB
chmod +x "$FAKE_BIN/docker-entrypoint.sh"

export PATH="$FAKE_BIN:$PATH"

fail() {
  printf 'postgres-entrypoint test: %s\n' "$1" >&2
  exit 1
}

# A real pair, plus a second pair whose key belongs to a different certificate.
readonly PKI="$TEST_ROOT/pki"
mkdir -p "$PKI"
openssl req -x509 -newkey rsa:2048 -noenc -days 2 -subj '/CN=pgdr.test.invalid' \
  -addext 'subjectAltName=DNS:pgdr.test.invalid' \
  -keyout "$PKI/good.key" -out "$PKI/good.crt" >/dev/null 2>&1
openssl req -x509 -newkey rsa:2048 -noenc -days 2 -subj '/CN=other.test.invalid' \
  -keyout "$PKI/other.key" -out "$PKI/other.crt" >/dev/null 2>&1

run_entrypoint() {
  local tls_dir="$1"
  shift
  rm -f "$ARGS_LOG"
  PG_TLS_DIR="$tls_dir" bash "$ENTRYPOINT" "$@"
}

# 1. No TLS material: the wrapper is a pass-through and creates nothing.
tls_dir="$TEST_ROOT/case-absent"
env -u PG_TLS_SERVER_CERT -u PG_TLS_SERVER_KEY \
  PG_TLS_DIR="$tls_dir" bash "$ENTRYPOINT" postgres -D /pgdata >/dev/null
[[ "$(cat "$ARGS_LOG")" == "$(printf 'postgres\n-D\n/pgdata')" ]] ||
  fail "unset credentials must hand off unchanged, got: $(tr '\n' ' ' <"$ARGS_LOG")"
[[ ! -d "$tls_dir" ]] || fail 'unset credentials must not create the TLS directory'

# 2. Both set: material is installed and the server is told to use it.
tls_dir="$TEST_ROOT/case-installed"
PG_TLS_SERVER_CERT="$(cat "$PKI/good.crt")" \
  PG_TLS_SERVER_KEY="$(cat "$PKI/good.key")" \
  run_entrypoint "$tls_dir" postgres >/dev/null
grep -Fqx -- '-c' "$ARGS_LOG" || fail 'expected injected -c settings'
for expected in 'ssl=on' "ssl_cert_file=$tls_dir/server.crt" \
  "ssl_key_file=$tls_dir/server.key" 'ssl_min_protocol_version=TLSv1.2'; do
  grep -Fqx -- "$expected" "$ARGS_LOG" || fail "expected injected setting $expected"
done
[[ "$(head -n 1 "$ARGS_LOG")" == 'postgres' ]] ||
  fail 'postgres must stay the first argument'
openssl x509 -noout -in "$tls_dir/server.crt" >/dev/null ||
  fail 'installed certificate is not readable as PEM'

# Modes are the point of the umask dance: a key readable by anyone else would be
# rejected by PostgreSQL, and a world-readable window would be worse.
key_mode="$(stat -c '%a' "$tls_dir/server.key" 2>/dev/null || stat -f '%Lp' "$tls_dir/server.key")"
cert_mode="$(stat -c '%a' "$tls_dir/server.crt" 2>/dev/null || stat -f '%Lp' "$tls_dir/server.crt")"
[[ "$key_mode" == '600' ]] || fail "server.key must be 0600, got $key_mode"
[[ "$cert_mode" == '644' ]] || fail "server.crt must be 0644, got $cert_mode"

# 3. A command that is not postgres must not be rewritten -- you cannot hand psql
#    a -c ssl=on -- but the material IS still installed. That split is deliberate:
#    installing is idempotent and leaves the volume correct however the container
#    was invoked, while only the server invocation can be told to use it.
tls_dir="$TEST_ROOT/case-other-command"
PG_TLS_SERVER_CERT="$(cat "$PKI/good.crt")" \
  PG_TLS_SERVER_KEY="$(cat "$PKI/good.key")" \
  run_entrypoint "$tls_dir" psql --version >/dev/null
[[ "$(cat "$ARGS_LOG")" == "$(printf 'psql\n--version')" ]] ||
  fail "a non-postgres command must pass through, got: $(tr '\n' ' ' <"$ARGS_LOG")"
openssl x509 -noout -in "$tls_dir/server.crt" >/dev/null 2>&1 ||
  fail 'material should still be installed for a non-postgres command'
[[ ! -e "$tls_dir/server.crt.incoming" ]] ||
  fail 'staged material was left behind by a non-postgres command'

expect_failure() {
  local description="$1"
  shift
  if "$@" >/dev/null 2>&1; then
    fail "entrypoint accepted $description"
  fi
}

# 4. Half a pair is a mis-wiring, not a reason to fall back to no TLS.
expect_failure 'a certificate with no key' env -u PG_TLS_SERVER_KEY \
  PG_TLS_DIR="$TEST_ROOT/case-cert-only" \
  PG_TLS_SERVER_CERT="$(cat "$PKI/good.crt")" \
  bash "$ENTRYPOINT" postgres
expect_failure 'a key with no certificate' env -u PG_TLS_SERVER_CERT \
  PG_TLS_DIR="$TEST_ROOT/case-key-only" \
  PG_TLS_SERVER_KEY="$(cat "$PKI/good.key")" \
  bash "$ENTRYPOINT" postgres

# 5. Garbage in either variable.
expect_failure 'a certificate that is not PEM' env \
  PG_TLS_DIR="$TEST_ROOT/case-bad-cert" \
  PG_TLS_SERVER_CERT='not a certificate' \
  PG_TLS_SERVER_KEY="$(cat "$PKI/good.key")" \
  bash "$ENTRYPOINT" postgres
expect_failure 'a key that is not PEM' env \
  PG_TLS_DIR="$TEST_ROOT/case-bad-key" \
  PG_TLS_SERVER_CERT="$(cat "$PKI/good.crt")" \
  PG_TLS_SERVER_KEY='not a key' \
  bash "$ENTRYPOINT" postgres

# 6. The one PostgreSQL would only reveal at startup, on a service with no shell.
expect_failure 'a certificate and key that are not a pair' env \
  PG_TLS_DIR="$TEST_ROOT/case-mismatch" \
  PG_TLS_SERVER_CERT="$(cat "$PKI/good.crt")" \
  PG_TLS_SERVER_KEY="$(cat "$PKI/other.key")" \
  bash "$ENTRYPOINT" postgres

# 7. A broken update must leave a working pair intact. Overwriting first and
#    validating afterwards would take a healthy primary down at its next boot.
tls_dir="$TEST_ROOT/case-preserves-working-pair"
PG_TLS_SERVER_CERT="$(cat "$PKI/good.crt")" \
  PG_TLS_SERVER_KEY="$(cat "$PKI/good.key")" \
  run_entrypoint "$tls_dir" postgres >/dev/null
installed_fingerprint="$(openssl x509 -noout -fingerprint -sha256 -in "$tls_dir/server.crt")"
expect_failure 'a mismatched update over a working pair' env \
  PG_TLS_DIR="$tls_dir" \
  PG_TLS_SERVER_CERT="$(cat "$PKI/good.crt")" \
  PG_TLS_SERVER_KEY="$(cat "$PKI/other.key")" \
  bash "$ENTRYPOINT" postgres
[[ "$(openssl x509 -noout -fingerprint -sha256 -in "$tls_dir/server.crt")" == "$installed_fingerprint" ]] ||
  fail 'a rejected update replaced the working certificate'
openssl pkey -noout -in "$tls_dir/server.key" ||
  fail 'a rejected update damaged the working key'
[[ ! -e "$tls_dir/server.crt.incoming" && ! -e "$tls_dir/server.key.incoming" ]] ||
  fail 'a rejected update left staged material behind'

# 8. The upstream entrypoint accepts leading PostgreSQL options and prepends
#    `postgres` itself, so this wrapper has to normalise that form too -- otherwise
#    it installs the certificate and starts PostgreSQL without pointing at it.
tls_dir="$TEST_ROOT/case-leading-option"
PG_TLS_SERVER_CERT="$(cat "$PKI/good.crt")" \
  PG_TLS_SERVER_KEY="$(cat "$PKI/good.key")" \
  run_entrypoint "$tls_dir" -c shared_buffers=128MB >/dev/null
[[ "$(head -n 1 "$ARGS_LOG")" == 'postgres' ]] ||
  fail "a leading option must be normalised to postgres, got: $(tr '\n' ' ' <"$ARGS_LOG")"
grep -Fqx -- 'ssl=on' "$ARGS_LOG" || fail 'a leading option must still get the TLS settings'
grep -Fqx -- 'shared_buffers=128MB' "$ARGS_LOG" || fail 'the caller option must survive'

# 9. Bash suspends errexit inside a function called in condition context, which
#    previously let a failed mkdir/chmod/mv/chown continue into PostgreSQL with
#    unusable TLS files. An unwritable target must stop the boot.
# Directory permissions do not constrain root, so as root this would assert that a
# write which legitimately succeeds must fail. Skip rather than mislead.
if [[ "$(id -u)" == '0' ]]; then
  printf 'postgres-entrypoint test: running as root; skipping the unwritable-directory case\n'
else
  readonly LOCKED="$TEST_ROOT/locked"
  mkdir -p "$LOCKED"
  chmod 0500 "$LOCKED"
  expect_failure 'an unwritable TLS directory' env \
    PG_TLS_DIR="$LOCKED/tls" \
    PG_TLS_SERVER_CERT="$(cat "$PKI/good.crt")" \
    PG_TLS_SERVER_KEY="$(cat "$PKI/good.key")" \
    bash "$ENTRYPOINT" postgres
  chmod 0700 "$LOCKED"
fi

# 10. A failing openssl must not read as a matching pair. The validator runs in
#     condition context, where errexit is suspended, so an unchecked command
#     substitution would leave both public keys empty -- and two empty strings
#     compare equal, validating a completely broken pair.
REAL_OPENSSL="$(command -v openssl)"
readonly REAL_OPENSSL
readonly STUB_BIN="$TEST_ROOT/stub-bin"
mkdir -p "$STUB_BIN"
cat >"$STUB_BIN/openssl" <<STUB
#!/usr/bin/env bash
# Fail only the public-key extraction; everything the validator checks first still
# behaves, so this isolates the substitution path rather than the whole validator.
for argument in "\$@"; do
  if [[ "\$argument" == '-pubkey' || "\$argument" == '-pubout' ]]; then
    echo 'stub openssl: simulated failure' >&2
    exit 1
  fi
done
exec "$REAL_OPENSSL" "\$@"
STUB
chmod +x "$STUB_BIN/openssl"
expect_failure 'a pair whose public keys could not be read' env \
  PATH="$STUB_BIN:$PATH" \
  PG_TLS_DIR="$TEST_ROOT/case-openssl-fails" \
  PG_TLS_SERVER_CERT="$(cat "$PKI/good.crt")" \
  PG_TLS_SERVER_KEY="$(cat "$PKI/good.key")" \
  bash "$ENTRYPOINT" postgres
[[ ! -e "$TEST_ROOT/case-openssl-fails/server.key" ]] ||
  fail 'a pair that could not be validated was installed anyway'

printf 'postgres-entrypoint TLS contract passed\n'
