#!/bin/sh
set +x
set -eu

fail() {
  printf 'PgBouncer configuration error: %s\n' "$1" >&2
  exit 1
}

require_variable() {
  variable_name=$1
  eval "variable_value=\${${variable_name}:-}"
  [ -n "$variable_value" ] || fail "$variable_name is required"
}

validate_identifier() {
  variable_name=$1
  variable_value=$2
  case "$variable_value" in
    *[!A-Za-z0-9_.@-]*) fail "$variable_name contains unsupported characters" ;;
  esac
}

validate_host() {
  case "$PGBOUNCER_UPSTREAM_HOST" in
    *[!A-Za-z0-9_.:-]*) fail 'PGBOUNCER_UPSTREAM_HOST contains unsupported characters' ;;
  esac
}

validate_port() {
  variable_name=$1
  variable_value=$2
  case "$variable_value" in
    ''|*[!0-9]*) fail "$variable_name must be an integer from 1 through 65535" ;;
  esac
  [ "$variable_value" -ge 1 ] && [ "$variable_value" -le 65535 ] ||
    fail "$variable_name must be an integer from 1 through 65535"
}

validate_runtime_directory() {
  variable_value=$1
  case "$variable_value" in
    /*) ;;
    *) fail 'PGBOUNCER_RUNTIME_DIR must be an absolute path' ;;
  esac
  case "$variable_value" in
    *[!A-Za-z0-9_./-]*) fail 'PGBOUNCER_RUNTIME_DIR contains unsupported characters' ;;
  esac
  case "$variable_value" in
    */../*|*/..) fail "PGBOUNCER_RUNTIME_DIR must not contain '..' path segments" ;;
  esac
}

validate_password() {
  variable_name=$1
  variable_value=$2
  carriage_return=$(printf '\r')
  case "$variable_value" in
    *"$carriage_return"*|*'
'*) fail "$variable_name must not contain line breaks" ;;
  esac
}

escape_auth_field() {
  # PgBouncer's auth-file format escapes a double quote by doubling it.
  printf '%s' "$1" | sed 's/"/""/g'
}

append_credential() {
  credential_user=$1
  credential_password=$2
  escaped_user=$(escape_auth_field "$credential_user")
  escaped_password=$(escape_auth_field "$credential_password")
  printf '"%s" "%s"\n' "$escaped_user" "$escaped_password" >>"$userlist_temporary"
}

for required_variable in \
  PGBOUNCER_UPSTREAM_HOST \
  PGBOUNCER_DATABASE_NAME \
  PGBOUNCER_UPSTREAM_USER \
  PGBOUNCER_UPSTREAM_PASSWORD \
  PGBOUNCER_CLIENT_USER \
  PGBOUNCER_CLIENT_PASSWORD \
  PGBOUNCER_ADMIN_USER \
  PGBOUNCER_ADMIN_PASSWORD \
  PGBOUNCER_SERVER_TLS_CA; do
  require_variable "$required_variable"
done

PGBOUNCER_UPSTREAM_PORT=${PGBOUNCER_UPSTREAM_PORT:-5432}
PGBOUNCER_LISTEN_PORT=${PGBOUNCER_LISTEN_PORT:-6432}
PGBOUNCER_RUNTIME_DIR=${PGBOUNCER_RUNTIME_DIR:-/run/pgbouncer}

validate_host
validate_identifier PGBOUNCER_DATABASE_NAME "$PGBOUNCER_DATABASE_NAME"
validate_identifier PGBOUNCER_UPSTREAM_USER "$PGBOUNCER_UPSTREAM_USER"
validate_identifier PGBOUNCER_CLIENT_USER "$PGBOUNCER_CLIENT_USER"
validate_identifier PGBOUNCER_ADMIN_USER "$PGBOUNCER_ADMIN_USER"
validate_port PGBOUNCER_UPSTREAM_PORT "$PGBOUNCER_UPSTREAM_PORT"
validate_port PGBOUNCER_LISTEN_PORT "$PGBOUNCER_LISTEN_PORT"
validate_runtime_directory "$PGBOUNCER_RUNTIME_DIR"
validate_password PGBOUNCER_UPSTREAM_PASSWORD "$PGBOUNCER_UPSTREAM_PASSWORD"
validate_password PGBOUNCER_CLIENT_PASSWORD "$PGBOUNCER_CLIENT_PASSWORD"
validate_password PGBOUNCER_ADMIN_PASSWORD "$PGBOUNCER_ADMIN_PASSWORD"

if [ "$PGBOUNCER_CLIENT_USER" = "$PGBOUNCER_UPSTREAM_USER" ] ||
  [ "$PGBOUNCER_CLIENT_USER" = "$PGBOUNCER_ADMIN_USER" ] ||
  [ "$PGBOUNCER_UPSTREAM_USER" = "$PGBOUNCER_ADMIN_USER" ]; then
  fail 'client, upstream, and admin users must be pairwise distinct'
fi

if [ -n "${PGBOUNCER_CLIENT_USER_NEXT:-}" ] || [ -n "${PGBOUNCER_CLIENT_PASSWORD_NEXT:-}" ]; then
  [ -n "${PGBOUNCER_CLIENT_USER_NEXT:-}" ] && [ -n "${PGBOUNCER_CLIENT_PASSWORD_NEXT:-}" ] ||
    fail 'PGBOUNCER_CLIENT_USER_NEXT and PGBOUNCER_CLIENT_PASSWORD_NEXT must be set together'
  validate_identifier PGBOUNCER_CLIENT_USER_NEXT "$PGBOUNCER_CLIENT_USER_NEXT"
  validate_password PGBOUNCER_CLIENT_PASSWORD_NEXT "$PGBOUNCER_CLIENT_PASSWORD_NEXT"
  if [ "$PGBOUNCER_CLIENT_USER_NEXT" = "$PGBOUNCER_CLIENT_USER" ] ||
    [ "$PGBOUNCER_CLIENT_USER_NEXT" = "$PGBOUNCER_UPSTREAM_USER" ] ||
    [ "$PGBOUNCER_CLIENT_USER_NEXT" = "$PGBOUNCER_ADMIN_USER" ]; then
    fail 'PGBOUNCER_CLIENT_USER_NEXT must be distinct from all active users'
  fi
fi

if [ -n "${PGBOUNCER_SERVER_TLS_CERT:-}" ] || [ -n "${PGBOUNCER_SERVER_TLS_KEY:-}" ]; then
  [ -n "${PGBOUNCER_SERVER_TLS_CERT:-}" ] && [ -n "${PGBOUNCER_SERVER_TLS_KEY:-}" ] ||
    fail 'PGBOUNCER_SERVER_TLS_CERT and PGBOUNCER_SERVER_TLS_KEY must be set together'
fi

if [ -n "${PGBOUNCER_CLIENT_TLS_CERT:-}" ] || [ -n "${PGBOUNCER_CLIENT_TLS_KEY:-}" ]; then
  [ -n "${PGBOUNCER_CLIENT_TLS_CERT:-}" ] && [ -n "${PGBOUNCER_CLIENT_TLS_KEY:-}" ] ||
    fail 'PGBOUNCER_CLIENT_TLS_CERT and PGBOUNCER_CLIENT_TLS_KEY must be set together'
fi

umask 077
mkdir -p "$PGBOUNCER_RUNTIME_DIR"
[ -d "$PGBOUNCER_RUNTIME_DIR" ] || fail 'PGBOUNCER_RUNTIME_DIR is not a directory'

config_file="$PGBOUNCER_RUNTIME_DIR/pgbouncer.ini"
userlist_file="$PGBOUNCER_RUNTIME_DIR/userlist.txt"
auth_hba_file="$PGBOUNCER_RUNTIME_DIR/auth_hba.conf"
client_certificate_file="$PGBOUNCER_RUNTIME_DIR/client.crt"
client_key_file="$PGBOUNCER_RUNTIME_DIR/client.key"
server_ca_file="$PGBOUNCER_RUNTIME_DIR/server-ca.crt"
server_certificate_file="$PGBOUNCER_RUNTIME_DIR/server.crt"
server_key_file="$PGBOUNCER_RUNTIME_DIR/server.key"
userlist_temporary="$PGBOUNCER_RUNTIME_DIR/.userlist.txt.$$"
auth_hba_temporary="$PGBOUNCER_RUNTIME_DIR/.auth_hba.conf.$$"
config_temporary="$PGBOUNCER_RUNTIME_DIR/.pgbouncer.ini.$$"

trap 'rm -f "$userlist_temporary" "$auth_hba_temporary" "$config_temporary"' EXIT HUP INT TERM

: >"$userlist_temporary"
append_credential "$PGBOUNCER_CLIENT_USER" "$PGBOUNCER_CLIENT_PASSWORD"

append_credential "$PGBOUNCER_UPSTREAM_USER" "$PGBOUNCER_UPSTREAM_PASSWORD"
append_credential "$PGBOUNCER_ADMIN_USER" "$PGBOUNCER_ADMIN_PASSWORD"
if [ -n "${PGBOUNCER_CLIENT_USER_NEXT:-}" ]; then
  append_credential "$PGBOUNCER_CLIENT_USER_NEXT" "$PGBOUNCER_CLIENT_PASSWORD_NEXT"
fi

mv "$userlist_temporary" "$userlist_file"

cat >"$auth_hba_temporary" <<EOF
local all all reject
hostnossl all all 0.0.0.0/0 reject
hostssl $PGBOUNCER_DATABASE_NAME $PGBOUNCER_CLIENT_USER 0.0.0.0/0 scram-sha-256
EOF
if [ -n "${PGBOUNCER_CLIENT_USER_NEXT:-}" ]; then
  printf 'hostssl %s %s 0.0.0.0/0 scram-sha-256\n' \
    "$PGBOUNCER_DATABASE_NAME" "$PGBOUNCER_CLIENT_USER_NEXT" >>"$auth_hba_temporary"
fi
cat >>"$auth_hba_temporary" <<EOF
hostssl pgbouncer $PGBOUNCER_ADMIN_USER 0.0.0.0/0 scram-sha-256
hostssl all all 0.0.0.0/0 reject
EOF
mv "$auth_hba_temporary" "$auth_hba_file"

if [ -n "${PGBOUNCER_CLIENT_TLS_CERT:-}" ]; then
  printf '%s\n' "$PGBOUNCER_CLIENT_TLS_CERT" >"$client_certificate_file"
  printf '%s\n' "$PGBOUNCER_CLIENT_TLS_KEY" >"$client_key_file"
else
  openssl req \
    -x509 \
    -newkey rsa:2048 \
    -sha256 \
    -nodes \
    -days 365 \
    -subj '/CN=pgbouncer' \
    -addext 'subjectAltName=DNS:pgbouncer' \
    -keyout "$client_key_file" \
    -out "$client_certificate_file" \
    >/dev/null 2>&1 || fail 'could not generate the client-facing TLS certificate'
fi
printf '%s\n' "$PGBOUNCER_SERVER_TLS_CA" >"$server_ca_file"

server_identity_config=''
if [ -n "${PGBOUNCER_SERVER_TLS_CERT:-}" ]; then
  printf '%s\n' "$PGBOUNCER_SERVER_TLS_CERT" >"$server_certificate_file"
  printf '%s\n' "$PGBOUNCER_SERVER_TLS_KEY" >"$server_key_file"
  server_identity_config="server_tls_cert_file = $server_certificate_file
server_tls_key_file = $server_key_file"
fi

cat >"$config_temporary" <<EOF
[databases]
$PGBOUNCER_DATABASE_NAME = host=$PGBOUNCER_UPSTREAM_HOST port=$PGBOUNCER_UPSTREAM_PORT dbname=$PGBOUNCER_DATABASE_NAME user=$PGBOUNCER_UPSTREAM_USER

[pgbouncer]
listen_addr = 0.0.0.0
listen_port = $PGBOUNCER_LISTEN_PORT
unix_socket_dir = $PGBOUNCER_RUNTIME_DIR
pidfile = $PGBOUNCER_RUNTIME_DIR/pgbouncer.pid

auth_type = hba
auth_file = $userlist_file
auth_hba_file = $auth_hba_file
admin_users = $PGBOUNCER_ADMIN_USER
stats_users = $PGBOUNCER_ADMIN_USER

pool_mode = transaction
default_pool_size = 40
min_pool_size = 0
reserve_pool_size = 5
reserve_pool_timeout = 3
max_db_connections = 45
max_user_connections = 45
max_client_conn = 500
max_prepared_statements = 0
query_wait_timeout = 5
client_login_timeout = 5
server_connect_timeout = 5
server_login_retry = 3
server_idle_timeout = 300
idle_transaction_timeout = 60

client_tls_sslmode = require
client_tls_cert_file = $client_certificate_file
client_tls_key_file = $client_key_file
client_tls_protocols = secure

server_tls_sslmode = verify-full
server_tls_ca_file = $server_ca_file
server_tls_protocols = secure
$server_identity_config
EOF

mv "$config_temporary" "$config_file"
trap - EXIT HUP INT TERM

# Do not leave secret values in PgBouncer's process environment. Docker health
# checks receive the container's configured environment independently.
unset \
  PGBOUNCER_UPSTREAM_PASSWORD \
  PGBOUNCER_CLIENT_PASSWORD \
  PGBOUNCER_CLIENT_PASSWORD_NEXT \
  PGBOUNCER_ADMIN_PASSWORD \
  PGBOUNCER_CLIENT_TLS_CERT \
  PGBOUNCER_CLIENT_TLS_KEY \
  PGBOUNCER_SERVER_TLS_CA \
  PGBOUNCER_SERVER_TLS_CERT \
  PGBOUNCER_SERVER_TLS_KEY

if [ "$#" -gt 0 ]; then
  exec "$@"
fi

exec pgbouncer "$config_file"
