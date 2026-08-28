#!/usr/bin/env bash

# Shared libpq credential transport for migration tooling. Callers must disable
# inherited xtrace before reading URL variables and must remove the containing
# credential directory on every exit.

boardsesh_libpq_fail() {
  printf 'error: %s\n' "$*" >&2
  return 1
}

boardsesh_decode_uri_component() {
  local encoded_component="$1"
  local decoded_component=""
  local decoded_byte hex_pair

  while [[ -n "$encoded_component" ]]; do
    if [[ "${encoded_component:0:1}" == '%' ]]; then
      [[ "${#encoded_component}" -ge 3 ]] ||
        boardsesh_libpq_fail 'database URL contains an invalid percent escape' || return
      hex_pair="${encoded_component:1:2}"
      [[ "$hex_pair" =~ ^[0-9A-Fa-f]{2}$ ]] ||
        boardsesh_libpq_fail 'database URL contains an invalid percent escape' || return
      [[ "$hex_pair" != '00' ]] ||
        boardsesh_libpq_fail 'database URL cannot contain a NUL byte' || return
      printf -v decoded_byte '%b' "\\x${hex_pair}"
      decoded_component+="$decoded_byte"
      encoded_component="${encoded_component:3}"
    else
      decoded_component+="${encoded_component:0:1}"
      encoded_component="${encoded_component:1}"
    fi
  done

  [[ "$decoded_component" != *$'\n'* && "$decoded_component" != *$'\r'* ]] ||
    boardsesh_libpq_fail 'database URL cannot contain a newline' || return
  REPLY="$decoded_component"
}

boardsesh_escape_pgpass_field() {
  local field="$1"
  field="${field//\\/\\\\}"
  field="${field//:/\\:}"
  REPLY="$field"
}

boardsesh_escape_conninfo_value() {
  local field="$1"
  field="${field//\\/\\\\}"
  field="${field//\'/\\\'}"
  REPLY="$field"
}

boardsesh_libpq_env_option_name() {
  case "$1" in
    PGAPPNAME) REPLY='application_name' ;;
    PGCHANNELBINDING) REPLY='channel_binding' ;;
    PGCLIENTENCODING) REPLY='client_encoding' ;;
    PGCONNECT_TIMEOUT) REPLY='connect_timeout' ;;
    PGGSSENCMODE) REPLY='gssencmode' ;;
    PGGSSLIB) REPLY='gsslib' ;;
    PGKEEPALIVES) REPLY='keepalives' ;;
    PGKEEPALIVESCOUNT) REPLY='keepalives_count' ;;
    PGKEEPALIVESIDLE) REPLY='keepalives_idle' ;;
    PGKEEPALIVESINTERVAL) REPLY='keepalives_interval' ;;
    PGKRBSRVNAME) REPLY='krbsrvname' ;;
    PGLOADBALANCEHOSTS) REPLY='load_balance_hosts' ;;
    PGOPTIONS) REPLY='options' ;;
    PGREQUIREAUTH) REPLY='require_auth' ;;
    PGREQUIREPEER) REPLY='requirepeer' ;;
    PGSSLCERT) REPLY='sslcert' ;;
    PGSSLCERTMODE) REPLY='sslcertmode' ;;
    PGSSLCOMPRESSION) REPLY='sslcompression' ;;
    PGSSLCRL) REPLY='sslcrl' ;;
    PGSSLCRLDIR) REPLY='sslcrldir' ;;
    PGSSLKEY) REPLY='sslkey' ;;
    PGSSLMAXPROTOCOLVERSION) REPLY='ssl_max_protocol_version' ;;
    PGSSLMINPROTOCOLVERSION) REPLY='ssl_min_protocol_version' ;;
    PGSSLMODE) REPLY='sslmode' ;;
    PGSSLNEGOTIATION) REPLY='sslnegotiation' ;;
    PGSSLROOTCERT) REPLY='sslrootcert' ;;
    PGSSLSNI) REPLY='sslsni' ;;
    PGTARGETSESSIONATTRS) REPLY='target_session_attrs' ;;
    PGTCPUSER_TIMEOUT) REPLY='tcp_user_timeout' ;;
    *) boardsesh_libpq_fail "cannot serialize unexpected libpq option $1" || return ;;
  esac
}

boardsesh_libpq_query_env_name() {
  case "$1" in
    application_name) REPLY='PGAPPNAME' ;;
    channel_binding) REPLY='PGCHANNELBINDING' ;;
    client_encoding) REPLY='PGCLIENTENCODING' ;;
    connect_timeout) REPLY='PGCONNECT_TIMEOUT' ;;
    gssencmode) REPLY='PGGSSENCMODE' ;;
    gsslib) REPLY='PGGSSLIB' ;;
    keepalives) REPLY='PGKEEPALIVES' ;;
    keepalives_count) REPLY='PGKEEPALIVESCOUNT' ;;
    keepalives_idle) REPLY='PGKEEPALIVESIDLE' ;;
    keepalives_interval) REPLY='PGKEEPALIVESINTERVAL' ;;
    krbsrvname) REPLY='PGKRBSRVNAME' ;;
    load_balance_hosts) REPLY='PGLOADBALANCEHOSTS' ;;
    options) REPLY='PGOPTIONS' ;;
    require_auth) REPLY='PGREQUIREAUTH' ;;
    requirepeer) REPLY='PGREQUIREPEER' ;;
    sslcert) REPLY='PGSSLCERT' ;;
    sslcertmode) REPLY='PGSSLCERTMODE' ;;
    sslcompression) REPLY='PGSSLCOMPRESSION' ;;
    sslcrl) REPLY='PGSSLCRL' ;;
    sslcrldir) REPLY='PGSSLCRLDIR' ;;
    sslkey) REPLY='PGSSLKEY' ;;
    ssl_max_protocol_version) REPLY='PGSSLMAXPROTOCOLVERSION' ;;
    ssl_min_protocol_version) REPLY='PGSSLMINPROTOCOLVERSION' ;;
    sslmode) REPLY='PGSSLMODE' ;;
    sslnegotiation) REPLY='PGSSLNEGOTIATION' ;;
    sslpassword) REPLY='PGSSLPASSWORD' ;;
    sslrootcert) REPLY='PGSSLROOTCERT' ;;
    sslsni) REPLY='PGSSLSNI' ;;
    target_session_attrs) REPLY='PGTARGETSESSIONATTRS' ;;
    tcp_user_timeout) REPLY='PGTCPUSER_TIMEOUT' ;;
    *) boardsesh_libpq_fail "unsupported database URL query option: $1" || return ;;
  esac
}

boardsesh_store_libpq_env() {
  local prefix="$1"
  local env_name="$2"
  local env_value="$3"
  local env_names_variable="BOARDSESH_LIBPQ_${prefix}_ENV_NAMES"
  local stored_variable="BOARDSESH_LIBPQ_${prefix}_${env_name}"
  local current_names="${!env_names_variable:-}"

  if [[ " $current_names " == *" $env_name "* ]]; then
    boardsesh_libpq_fail "database URL sets $env_name more than once"
    return
  fi
  printf -v "$stored_variable" '%s' "$env_value"
  printf -v "$env_names_variable" '%s' "${current_names:+$current_names }$env_name"
  export -n "${stored_variable?}" "${env_names_variable?}"
}

boardsesh_prepare_libpq_connection() {
  local prefix="$1"
  local connection_uri="$2"
  local credential_directory="$3"
  local authority suffix userinfo host_port host port remainder
  local encoded_username encoded_password encoded_database username password database
  local query parameter encoded_name encoded_value option_name option_value env_name
  local escaped_host escaped_port escaped_database escaped_username escaped_password
  local passfile="$credential_directory/${prefix,,}.pgpass"

  [[ "$prefix" =~ ^[A-Z][A-Z0-9_]*$ ]] ||
    boardsesh_libpq_fail 'libpq connection prefix must be uppercase ASCII' || return
  [[ "$connection_uri" != *$'\n'* && "$connection_uri" != *$'\r'* ]] ||
    boardsesh_libpq_fail 'database URL cannot contain a newline' || return
  [[ "$connection_uri" != *'#'* ]] ||
    boardsesh_libpq_fail 'database URL fragments are not supported' || return
  [[ "$connection_uri" =~ ^(postgres|postgresql)://([^/?#]*)(.*)$ ]] ||
    boardsesh_libpq_fail 'database connection must be a postgres:// or postgresql:// URI' || return
  authority="${BASH_REMATCH[2]}"
  suffix="${BASH_REMATCH[3]}"

  encoded_username=''
  encoded_password=''
  if [[ "$authority" == *@* ]]; then
    userinfo="${authority%@*}"
    host_port="${authority##*@}"
    if [[ "$userinfo" == *:* ]]; then
      encoded_username="${userinfo%%:*}"
      encoded_password="${userinfo#*:}"
    else
      encoded_username="$userinfo"
    fi
  else
    host_port="$authority"
  fi

  [[ "$host_port" != *','* ]] ||
    boardsesh_libpq_fail 'multi-host database URLs are not supported by migration tooling' || return
  port='5432'
  if [[ "$host_port" == \[* ]]; then
    [[ "$host_port" == *']'* ]] ||
      boardsesh_libpq_fail 'database URL has an unterminated IPv6 host' || return
    host="${host_port#\[}"
    host="${host%%]*}"
    remainder="${host_port#*]}"
    if [[ -n "$remainder" ]]; then
      [[ "$remainder" =~ ^:([0-9]+)$ ]] ||
        boardsesh_libpq_fail 'database URL has an invalid IPv6 port' || return
      port="${BASH_REMATCH[1]}"
    fi
  elif [[ "$host_port" == *:* ]]; then
    host="${host_port%:*}"
    port="${host_port##*:}"
    [[ "$host" != *:* && "$port" =~ ^[0-9]+$ ]] ||
      boardsesh_libpq_fail 'database URL host/port is invalid; bracket IPv6 hosts' || return
  else
    host="$host_port"
  fi
  [[ "$port" =~ ^[0-9]+$ && "$port" -ge 1 && "$port" -le 65535 ]] ||
    boardsesh_libpq_fail 'database URL port must be between 1 and 65535' || return

  encoded_database="${suffix%%\?*}"
  encoded_database="${encoded_database#/}"
  [[ "$encoded_database" != */* ]] ||
    boardsesh_libpq_fail 'database name must encode slash characters' || return
  [[ -n "$encoded_database" ]] || encoded_database="$encoded_username"

  boardsesh_decode_uri_component "$host" || return
  host="$REPLY"
  [[ "$host" != *','* && "$host" != */* && ! "$host" =~ [[:space:]] ]] ||
    boardsesh_libpq_fail 'database URL decoded host cannot contain commas, slashes, or whitespace' || return
  boardsesh_decode_uri_component "$encoded_username" || return
  username="$REPLY"
  boardsesh_decode_uri_component "$encoded_database" || return
  database="$REPLY"
  boardsesh_decode_uri_component "$encoded_password" || return
  password="$REPLY"

  [[ -n "$host" && -n "$username" && -n "$database" ]] ||
    boardsesh_libpq_fail 'database URL must include host, username, and database' || return

  : >"$passfile"
  chmod 0600 "$passfile"
  boardsesh_escape_pgpass_field "$host"
  escaped_host="$REPLY"
  boardsesh_escape_pgpass_field "$port"
  escaped_port="$REPLY"
  boardsesh_escape_pgpass_field "$database"
  escaped_database="$REPLY"
  boardsesh_escape_pgpass_field "$username"
  escaped_username="$REPLY"
  boardsesh_escape_pgpass_field "$password"
  escaped_password="$REPLY"
  printf '%s:%s:%s:%s:%s\n' \
    "$escaped_host" "$escaped_port" "$escaped_database" "$escaped_username" "$escaped_password" \
    >"$passfile"

  boardsesh_store_libpq_env "$prefix" PGHOST "$host" || return
  boardsesh_store_libpq_env "$prefix" PGPORT "$port" || return
  boardsesh_store_libpq_env "$prefix" PGDATABASE "$database" || return
  boardsesh_store_libpq_env "$prefix" PGUSER "$username" || return
  boardsesh_store_libpq_env "$prefix" PGPASSFILE "$passfile" || return
  local password_variable="BOARDSESH_LIBPQ_${prefix}_PASSWORD"
  printf -v "$password_variable" '%s' "$password"
  export -n "${password_variable?}"

  [[ "$suffix" == *'?'* ]] || return 0
  query="${suffix#*\?}"
  while [[ -n "$query" ]]; do
    parameter="${query%%&*}"
    encoded_name="${parameter%%=*}"
    encoded_value=''
    [[ "$parameter" != *'='* ]] || encoded_value="${parameter#*=}"
    boardsesh_decode_uri_component "$encoded_name" || return
    option_name="${REPLY,,}"
    boardsesh_decode_uri_component "$encoded_value" || return
    option_value="$REPLY"
    case "$option_name" in
      password | passfile | service | host | hostaddr | port | dbname | user | sslpassword)
        boardsesh_libpq_fail "database URL query option $option_name would bypass validated URI fields"
        return
        ;;
    esac
    boardsesh_libpq_query_env_name "$option_name" || return
    env_name="$REPLY"
    boardsesh_store_libpq_env "$prefix" "$env_name" "$option_value" || return
    if [[ "$query" == *'&'* ]]; then
      query="${query#*&}"
    else
      query=''
    fi
  done
}

boardsesh_write_libpq_conninfo() {
  local prefix="$1"
  local output_file="$2"
  local include_password="${3:-true}"
  local env_names_variable="BOARDSESH_LIBPQ_${prefix}_ENV_NAMES"
  local env_names="${!env_names_variable:-}"
  local env_name stored_variable option_name option_value escaped_value
  local -a ordered_options=(
    PGAPPNAME PGCHANNELBINDING PGCLIENTENCODING PGCONNECT_TIMEOUT PGGSSENCMODE PGGSSLIB
    PGKEEPALIVES PGKEEPALIVESCOUNT PGKEEPALIVESIDLE PGKEEPALIVESINTERVAL PGKRBSRVNAME
    PGLOADBALANCEHOSTS PGOPTIONS PGREQUIREAUTH PGREQUIREPEER PGSSLCERT PGSSLCERTMODE
    PGSSLCOMPRESSION PGSSLCRL PGSSLCRLDIR PGSSLKEY PGSSLMAXPROTOCOLVERSION
    PGSSLMINPROTOCOLVERSION PGSSLMODE PGSSLNEGOTIATION PGSSLROOTCERT PGSSLSNI
    PGTARGETSESSIONATTRS PGTCPUSER_TIMEOUT
  )

  [[ -n "$env_names" ]] || boardsesh_libpq_fail "libpq connection $prefix was not prepared" || return
  : >"$output_file"
  chmod 0600 "$output_file"
  for env_name in PGHOST PGPORT PGDATABASE PGUSER; do
    stored_variable="BOARDSESH_LIBPQ_${prefix}_${env_name}"
    boardsesh_escape_conninfo_value "${!stored_variable}"
    escaped_value="$REPLY"
    case "$env_name" in
      PGHOST) option_name='host' ;;
      PGPORT) option_name='port' ;;
      PGDATABASE) option_name='dbname' ;;
      PGUSER) option_name='user' ;;
    esac
    printf "%s='%s' " "$option_name" "$escaped_value" >>"$output_file"
  done
  if [[ "$include_password" == 'true' ]]; then
    stored_variable="BOARDSESH_LIBPQ_${prefix}_PASSWORD"
    boardsesh_escape_conninfo_value "${!stored_variable}"
    printf "password='%s' " "$REPLY" >>"$output_file"
  fi
  for env_name in "${ordered_options[@]}"; do
    [[ " $env_names " == *" $env_name "* ]] || continue
    stored_variable="BOARDSESH_LIBPQ_${prefix}_${env_name}"
    option_value="${!stored_variable}"
    boardsesh_libpq_env_option_name "$env_name" || return
    option_name="$REPLY"
    boardsesh_escape_conninfo_value "$option_value"
    printf "%s='%s' " "$option_name" "$REPLY" >>"$output_file"
  done
  printf '\n' >>"$output_file"
}

boardsesh_md5_conninfo_file() {
  local conninfo_file="$1"
  local conninfo digest_output
  conninfo="$(<"$conninfo_file")"
  if command -v md5sum >/dev/null 2>&1; then
    digest_output="$(printf '%s' "$conninfo" | md5sum)"
    REPLY="${digest_output%% *}"
  elif command -v md5 >/dev/null 2>&1; then
    REPLY="$(printf '%s' "$conninfo" | md5 -q)"
  elif command -v openssl >/dev/null 2>&1; then
    digest_output="$(printf '%s' "$conninfo" | openssl dgst -md5)"
    REPLY="${digest_output##* }"
  else
    boardsesh_libpq_fail 'md5sum, md5, or openssl is required to fingerprint canonical conninfo'
    return
  fi
  [[ "$REPLY" =~ ^[0-9a-f]{32}$ ]] ||
    boardsesh_libpq_fail 'could not calculate the canonical conninfo digest' || return
  unset conninfo digest_output
}

boardsesh_run_libpq_connection() {
  local prefix="$1"
  shift
  local env_names_variable="BOARDSESH_LIBPQ_${prefix}_ENV_NAMES"
  local env_names="${!env_names_variable:-}"
  local env_name stored_variable stored_value

  [[ -n "$env_names" ]] || boardsesh_libpq_fail "libpq connection $prefix was not prepared" || return
  (
    set +x
    unset PGAPPNAME PGCHANNELBINDING PGCLIENTENCODING PGCONNECT_TIMEOUT PGDATABASE \
      PGDATESTYLE PGGEQO PGGSSDELEGATION PGGSSENCMODE PGGSSLIB PGHOST PGHOSTADDR \
      PGKEEPALIVES PGKEEPALIVESCOUNT \
      PGKEEPALIVESIDLE PGKEEPALIVESINTERVAL PGKRBSRVNAME PGLOADBALANCEHOSTS \
      PGLOCALEDIR PGMAXPROTOCOLVERSION PGMINPROTOCOLVERSION PGOAUTHCAFILE PGOAUTHDEBUG \
      PGOPTIONS PGPASSFILE PGPASSWORD PGPORT PGREALM PGREQUIREAUTH \
      PGREPLICATION PGREQUIREPEER PGREQUIRESSL PGSERVICE PGSERVICEFILE PGSSLCERT PGSSLCERTMODE \
      PGSSLCOMPRESSION PGSSLCRL PGSSLCRLDIR \
      PGSSLKEY PGSSLMAXPROTOCOLVERSION PGSSLMINPROTOCOLVERSION PGSSLMODE \
      PGSSLNEGOTIATION PGSSLPASSWORD PGSSLROOTCERT PGSSLSNI PGSYSCONFDIR \
      PGTARGETSESSIONATTRS PGTCPUSER_TIMEOUT PGTZ PGUSER
    for env_name in $env_names; do
      stored_variable="BOARDSESH_LIBPQ_${prefix}_${env_name}"
      stored_value="${!stored_variable}"
      printf -v "$env_name" '%s' "$stored_value"
      export "${env_name?}"
    done
    if [[ -n "${BOARDSESH_LIBPQ_EXTRA_OPTIONS:-}" ]]; then
      PGOPTIONS="${PGOPTIONS:+$PGOPTIONS }${BOARDSESH_LIBPQ_EXTRA_OPTIONS}"
      export PGOPTIONS
    fi
    if [[ -n "${BOARDSESH_LIBPQ_CONNECT_TIMEOUT:-}" ]]; then
      PGCONNECT_TIMEOUT="$BOARDSESH_LIBPQ_CONNECT_TIMEOUT"
      export PGCONNECT_TIMEOUT
    fi
    "$@"
  )
}
