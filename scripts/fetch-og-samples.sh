#!/bin/sh
#
# Fetch one real share card (`/og/*`) of every kind from a running dev stack.
#
#   vp run dev                      # db + backend + web
#   sh scripts/fetch-og-samples.sh  # writes tmp/og-samples/<run>/
#
# The cards are drawn by the backend (BACKEND_URL); www only serves the site's
# default card (BASE_URL/opengraph-image). Sample rows come from DATABASE_URL,
# through psql when it is installed and the dev compose Postgres when it is not.
# Every id can be pinned with its env var (CLIMB_SAMPLE, SESSION_ID, ...).
#
# For layout work with no database at all, render the gallery instead:
#   cd packages/backend && vp exec tsx scripts/og-card-gallery.ts

set -u

REPO_ROOT=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
BASE_URL=${BASE_URL:-http://127.0.0.1:3000}
BACKEND_URL=${BACKEND_URL:-http://127.0.0.1:8080}
DATABASE_URL=${DATABASE_URL:-postgresql://postgres:password@localhost:5432/main}
OUTPUT_ROOT=${OUTPUT_ROOT:-"$REPO_ROOT/tmp/og-samples"}
RUN_ID=${RUN_ID:-$(date +%Y%m%d-%H%M%S)}
RUN_DIR="$OUTPUT_ROOT/$RUN_ID"
README_FILE="$RUN_DIR/README.txt"

failures=0

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    printf 'Missing required command: %s\n' "$1" >&2
    exit 1
  fi
}

query_value() {
  if command -v psql >/dev/null 2>&1; then
    psql "$DATABASE_URL" -At -F '|' -c "$1"
  else
    docker compose -f "$REPO_ROOT/docker-compose.yml" exec -T postgres \
      psql -U postgres -d main -At -F '|' -c "$1"
  fi
}

write_readme_header() {
  cat > "$README_FILE" <<EOF
Boardsesh local OG sample capture

Base URL: $BASE_URL
Backend URL: $BACKEND_URL
Database URL: $DATABASE_URL
Run directory: $RUN_DIR

EOF
}

append_readme_entry() {
  label=$1
  effective_url=$2
  status=$3
  content_type=$4
  saved_path=$5

  cat >> "$README_FILE" <<EOF
$label
URL: $effective_url
Status: $status
Content-Type: $content_type
Saved: $saved_path

EOF
}

capture_failure() {
  label=$1
  body_file=$2
  stderr_file=$3
  error_file=$4
  headers_file=$5
  effective_url=$6
  status=$7
  content_type=$8

  if [ -s "$body_file" ]; then
    mv "$body_file" "$error_file"
  elif [ -s "$stderr_file" ]; then
    cp "$stderr_file" "$error_file"
  else
    printf 'Request failed with status %s and content type %s\n' "$status" "$content_type" > "$error_file"
  fi

  append_readme_entry "$label" "$effective_url" "$status" "$content_type" "$error_file"
  failures=$((failures + 1))
  rm -f "$stderr_file"
  [ -f "$headers_file" ] || : > "$headers_file"
}

# fetch_sample <label> <full url> [key=value ...]
fetch_sample() {
  label=$1
  url=$2
  shift 2

  body_file="$RUN_DIR/$label.body"
  headers_file="$RUN_DIR/$label.headers.txt"
  stderr_file="$RUN_DIR/$label.curl.stderr.txt"
  error_file="$RUN_DIR/$label-error.txt"
  pair_file="$RUN_DIR/.${label}.pairs"

  rm -f "$body_file" "$headers_file" "$stderr_file" "$error_file" "$pair_file"
  : > "$pair_file"
  for pair in "$@"; do
    printf '%s\n' "$pair" >> "$pair_file"
  done

  set -- -sS -L --get -o "$body_file" -D "$headers_file" -w '%{http_code}\n%{content_type}\n%{url_effective}'
  while IFS= read -r pair; do
    set -- "$@" --data-urlencode "$pair"
  done < "$pair_file"
  rm -f "$pair_file"
  set -- "$@" "$url"

  curl_status=0
  metadata=$(curl "$@" 2>"$stderr_file") || curl_status=$?

  status=$(printf '%s' "$metadata" | sed -n '1p')
  content_type=$(printf '%s' "$metadata" | sed -n '2p')
  effective_url=$(printf '%s' "$metadata" | sed -n '3p')

  if [ -z "$effective_url" ]; then
    effective_url="$url"
  fi

  if [ "$curl_status" -ne 0 ]; then
    capture_failure "$label" "$body_file" "$stderr_file" "$error_file" "$headers_file" "$effective_url" "curl-$curl_status" "$content_type"
    printf 'FAILED %s (%s)\n' "$label" "curl-$curl_status"
    return
  fi

  # Cards are JPEG by default; `/og/climb` also honours `format`.
  case "$content_type" in
    image/jpeg*) ext=jpg ;;
    image/png*) ext=png ;;
    image/webp*) ext=webp ;;
    *) ext= ;;
  esac

  case "$status" in
    2??)
      if [ -n "$ext" ] && [ -s "$body_file" ]; then
        mv "$body_file" "$RUN_DIR/$label.$ext"
        rm -f "$stderr_file"
        append_readme_entry "$label" "$effective_url" "$status" "$content_type" "$RUN_DIR/$label.$ext"
        printf 'OK %s (%s)\n' "$label" "$status"
      else
        capture_failure "$label" "$body_file" "$stderr_file" "$error_file" "$headers_file" "$effective_url" "$status" "$content_type"
        printf 'FAILED %s (%s)\n' "$label" "$status"
      fi
      ;;
    *)
      capture_failure "$label" "$body_file" "$stderr_file" "$error_file" "$headers_file" "$effective_url" "$status" "$content_type"
      printf 'FAILED %s (%s)\n' "$label" "$status"
      ;;
  esac
}

require_command curl
command -v psql >/dev/null 2>&1 || require_command docker

mkdir -p "$RUN_DIR"
write_readme_header

PROFILE_USER_ID=${PROFILE_USER_ID:-$(query_value "SELECT id FROM users ORDER BY created_at ASC LIMIT 1;")}

CLIMB_SAMPLE=${CLIMB_SAMPLE:-$(query_value "
  SELECT
    bc.board_type,
    bc.layout_id,
    bc.compatible_size_ids[1],
    array_to_string(bc.required_set_ids, ','),
    COALESCE(bcs.angle, 40),
    bc.uuid,
    COALESCE(NULLIF(bc.setter_username, ''), '')
  FROM board_climbs bc
  LEFT JOIN board_climb_stats bcs ON bcs.climb_uuid = bc.uuid AND bcs.board_type = bc.board_type
  WHERE bc.frames_count = 1
    AND bc.required_set_ids IS NOT NULL
    AND array_length(bc.required_set_ids, 1) > 0
    AND bc.compatible_size_ids IS NOT NULL
    AND array_length(bc.compatible_size_ids, 1) > 0
  ORDER BY bc.created_at DESC NULLS LAST
  LIMIT 1;
")}

if [ -n "$CLIMB_SAMPLE" ]; then
  IFS='|' read -r CLIMB_BOARD_NAME CLIMB_LAYOUT_ID CLIMB_SIZE_ID CLIMB_SET_IDS CLIMB_ANGLE CLIMB_UUID CLIMB_SETTER_USERNAME <<EOF
$CLIMB_SAMPLE
EOF
else
  CLIMB_BOARD_NAME=
  CLIMB_LAYOUT_ID=
  CLIMB_SIZE_ID=
  CLIMB_SET_IDS=
  CLIMB_ANGLE=
  CLIMB_UUID=
  CLIMB_SETTER_USERNAME=
fi

SETTER_USERNAME=${SETTER_USERNAME:-$CLIMB_SETTER_USERNAME}
if [ -z "$SETTER_USERNAME" ]; then
  SETTER_USERNAME=$(query_value "
    SELECT setter_username
    FROM board_climbs
    WHERE setter_username IS NOT NULL AND setter_username <> ''
    ORDER BY created_at DESC NULLS LAST
    LIMIT 1;
  ")
fi

SESSION_ID=${SESSION_ID:-$(query_value "
  SELECT bt.session_id
  FROM boardsesh_ticks bt
  WHERE bt.session_id IS NOT NULL
  ORDER BY bt.updated_at DESC NULLS LAST
  LIMIT 1;
")}

PLAYLIST_UUID=${PLAYLIST_UUID:-$(query_value "
  SELECT uuid
  FROM playlists
  WHERE is_public = TRUE
  ORDER BY updated_at DESC NULLS LAST
  LIMIT 1;
")}

GYM_SLUG=${GYM_SLUG:-$(query_value "
  SELECT slug
  FROM gyms
  WHERE is_public = TRUE AND deleted_at IS NULL AND slug IS NOT NULL
  ORDER BY updated_at DESC NULLS LAST
  LIMIT 1;
")}

BOARD_SLUG=${BOARD_SLUG:-$(query_value "
  SELECT slug
  FROM user_boards
  WHERE is_public = TRUE AND board_type <> 'spray'
  ORDER BY created_at DESC NULLS LAST
  LIMIT 1;
")}

cat >> "$README_FILE" <<EOF
Samples
Profile user: $PROFILE_USER_ID
Climb board: $CLIMB_BOARD_NAME
Climb layout: $CLIMB_LAYOUT_ID
Climb size: $CLIMB_SIZE_ID
Climb sets: $CLIMB_SET_IDS
Climb angle: $CLIMB_ANGLE
Climb uuid: $CLIMB_UUID
Setter username: $SETTER_USERNAME
Session id: $SESSION_ID
Playlist uuid: $PLAYLIST_UUID
Gym slug: $GYM_SLUG
Board slug: $BOARD_SLUG

EOF

if [ -z "$PROFILE_USER_ID" ] || [ -z "$CLIMB_BOARD_NAME" ] || [ -z "$CLIMB_LAYOUT_ID" ] || [ -z "$CLIMB_SIZE_ID" ] || [ -z "$CLIMB_SET_IDS" ] || [ -z "$CLIMB_ANGLE" ] || [ -z "$CLIMB_UUID" ] || [ -z "$SETTER_USERNAME" ] || [ -z "$SESSION_ID" ] || [ -z "$PLAYLIST_UUID" ]; then
  printf 'Missing one or more sample identifiers. See %s\n' "$README_FILE" >&2
  exit 1
fi

fetch_sample "climb" "$BACKEND_URL/og/climb" \
  "board_name=$CLIMB_BOARD_NAME" \
  "layout_id=$CLIMB_LAYOUT_ID" \
  "size_id=$CLIMB_SIZE_ID" \
  "set_ids=$CLIMB_SET_IDS" \
  "angle=$CLIMB_ANGLE" \
  "climb_uuid=$CLIMB_UUID"

fetch_sample "profile" "$BACKEND_URL/og/profile" \
  "user_id=$PROFILE_USER_ID"

fetch_sample "setter" "$BACKEND_URL/og/setter" \
  "username=$SETTER_USERNAME"

fetch_sample "session" "$BACKEND_URL/og/session" \
  "sessionId=$SESSION_ID"

fetch_sample "session-join" "$BACKEND_URL/og/session" \
  "sessionId=$SESSION_ID" \
  "variant=join"

fetch_sample "playlist" "$BACKEND_URL/og/playlist" \
  "uuid=$PLAYLIST_UUID"

if [ -n "$GYM_SLUG" ]; then
  fetch_sample "place-gym" "$BACKEND_URL/og/place" "kind=gym" "slug=$GYM_SLUG"
else
  printf 'SKIPPED place-gym (no public gym with a slug)\n'
fi

if [ -n "$BOARD_SLUG" ]; then
  fetch_sample "place-board" "$BACKEND_URL/og/place" "kind=board" "slug=$BOARD_SLUG"
else
  printf 'SKIPPED place-board (no public board)\n'
fi

fetch_sample "default-site" "$BASE_URL/opengraph-image"

printf 'Artifacts saved in %s\n' "$RUN_DIR"

if [ "$failures" -ne 0 ]; then
  printf 'Completed with %s failure(s).\n' "$failures" >&2
  exit 1
fi

printf 'All OG samples fetched successfully.\n'
