"""Audit the exact timezone rule files used by a disposable PostgreSQL container."""
import argparse
import base64
import io
import json
import re
import subprocess
from datetime import datetime, timezone
from hashlib import sha256
from zoneinfo import ZoneInfo
from zoneinfo._common import _TZifHeader, load_data
from zoneinfo._zoneinfo import _TZStr, _parse_tz_str

MIN_TRANSITION_SPACING = 3600
MAX_OFFSET_SECONDS = 36 * 3600
GREGORIAN_CYCLE_YEARS = 400

# Require the POSIX TZ grammar before delegating offset ranges and calendar
# arithmetic to CPython. Its private parser has accepted punctuation in names,
# missing standard offsets and malformed separators in some Python releases.
TZ_NAME = r"(?:[A-Za-z]{3,}|<[A-Za-z0-9+-]{3,}>)"
MINUTE_SECOND = r"(?::[0-5][0-9](?::[0-5][0-9])?)?"
TZ_OFFSET = rf"[+-]?[0-9]{{1,2}}{MINUTE_SECOND}"
# TZif v3+ extends POSIX transition hours to signed values up to 167.
TZ_RULE = rf"(?:J[0-9]{{1,3}}|[0-9]{{1,3}}|M[0-9]{{1,2}}\.[0-9]\.[0-9])(?:/[+-]?[0-9]{{1,3}}{MINUTE_SECOND})?"
POSIX_TZ = re.compile(rf"{TZ_NAME}{TZ_OFFSET}(?:{TZ_NAME}(?:{TZ_OFFSET})?,{TZ_RULE},{TZ_RULE})?")

READ_TIMEZONE_ARTIFACT_SQL = r"""
WITH configuration AS (
  SELECT coalesce(
    (SELECT (regexp_match(setting, '--with-system-tzdata=([^''[:space:]]+)'))[1]
      FROM pg_config() WHERE name = 'CONFIGURE'),
    (SELECT setting || '/timezone' FROM pg_config() WHERE name = 'SHAREDIR')
  ) AS root
)
SELECT json_build_object(
  'server', version(),
  'rules_root', root,
  'rules', (SELECT json_agg(json_build_object(
      'name', name, 'encoded', encode(pg_read_binary_file(root || '/' || name), 'base64')
    ) ORDER BY name)
    FROM pg_timezone_names
    WHERE name ~ '^[A-Za-z0-9_+-]+(/[A-Za-z0-9_+-]+)*$'
      AND name NOT LIKE 'posix/%' AND name NOT LIKE 'right/%'
  )
) FROM configuration
"""


def read_tzif(data):
    # CPython's TZif parser yields integer-second transitions from the 64-bit
    # data block. Check the authoritative header too, since load_data omits leaps.
    stream = io.BytesIO(data)
    header = _TZifHeader.from_file(stream)
    if header.version not in (1, 2, 3, 4):
        raise ValueError(f"unsupported TZif version {header.version}")
    if header.version >= 2:
        stream.seek(header.timecnt * 5 + header.typecnt * 6 + header.charcnt
                    + header.leapcnt * 8 + header.isstdcnt + header.isutcnt, 1)
        header = _TZifHeader.from_file(stream)
    if header.leapcnt:
        raise ValueError("leap-second tables are outside the reporting calendar")
    return load_data(io.BytesIO(data))


def offset_seconds(offset):
    return int(offset.total_seconds())


def gap_between(transitions):
    return min((right - left for left, right in zip(transitions, transitions[1:])), default=None)


def tail_points(tail, last_explicit):
    year = 1970 if last_explicit is None else datetime.fromtimestamp(last_explicit, timezone.utc).year
    standard = offset_seconds(tail.std.utcoff)
    daylight = offset_seconds(tail.dst.utcoff)
    transitions = []
    # Include the explicit seam and one full repeating Gregorian cycle, plus
    # adjacent years to check the recurrence seam across both cycle endpoints.
    for candidate_year in range(year - 1, year + GREGORIAN_CYCLE_YEARS + 2):
        start, end = tail.transitions(candidate_year)
        transitions.extend((start - standard, end - daylight))
    return sorted(stamp for stamp in transitions if last_explicit is None or stamp > last_explicit)


def analyze_tzif(data):
    types, raw_transitions, offsets, _, _, encoded_tail = read_tzif(data)
    if sorted(set(raw_transitions)) != list(raw_transitions):
        raise ValueError("unordered explicit transitions")
    transitions = list(raw_transitions)
    max_offsets = list(offsets)
    seam = None
    if encoded_tail:
        tz_string = encoded_tail.decode("ascii")
        if not POSIX_TZ.fullmatch(tz_string):
            raise ValueError(f"{tz_string!r} is not a valid TZ string")
        tail = _parse_tz_str(tz_string)
        last_explicit = transitions[-1] if transitions else None
        last_offset = offsets[types[-1]] if types else None
        if isinstance(tail, _TZStr):
            max_offsets.extend((offset_seconds(tail.std.utcoff), offset_seconds(tail.dst.utcoff)))
            recurring = tail_points(tail, last_explicit)
            if last_explicit is not None:
                last_year = datetime.fromtimestamp(last_explicit, timezone.utc).year
                state, _ = tail.get_trans_info_fromutc(last_explicit, last_year)
                if offset_seconds(state.utcoff) != last_offset:
                    raise ValueError("recurring footer is discontinuous at the last explicit transition")
                seam = recurring[0] - last_explicit
            transitions.extend(recurring)
        else:
            fixed_offset = offset_seconds(tail.utcoff)
            max_offsets.append(fixed_offset)
            if last_offset is not None and fixed_offset != last_offset:
                raise ValueError("fixed footer is discontinuous at the last explicit transition")

    minimum_gap = gap_between(transitions)
    max_offset = max(map(abs, max_offsets))
    if minimum_gap is not None and minimum_gap <= MIN_TRANSITION_SPACING:
        raise ValueError(f"transitions too close together ({minimum_gap} seconds)")
    if max_offset >= MAX_OFFSET_SECONDS:
        raise ValueError(f"offset outside the UTC envelope ({max_offset} seconds)")

    # Check every recurring boundary against the interpreter of the complete
    # TZif file, in addition to the standalone POSIX-rule parser.
    if encoded_tail and isinstance(tail, _TZStr):
        zone = ZoneInfo.from_file(io.BytesIO(data))
        for stamp in recurring:
            before = datetime.fromtimestamp(stamp - 1, timezone.utc).astimezone(zone).utcoffset()
            after = datetime.fromtimestamp(stamp, timezone.utc).astimezone(zone).utcoffset()
            if before == after:
                raise ValueError(f"footer offset does not change at {stamp}")
    return minimum_gap, seam, max_offset, encoded_tail


def audit(artifact):
    hashes = []
    gaps = []
    seams = []
    offsets = []
    tails = set()
    names = set()
    for rule in sorted(artifact["rules"], key=lambda rule: rule["name"]):
        name = rule["name"]
        if name in names:
            raise ValueError(f"duplicate zone {name}")
        names.add(name)
        data = base64.b64decode(rule["encoded"])
        hashes.append(f"{name}\0{sha256(data).hexdigest()}\n".encode())
        try:
            gap, seam, offset, tail = analyze_tzif(data)
        except (ValueError, EOFError, OSError) as error:
            raise ValueError(f"{name}: {error}") from error
        if gap is not None:
            gaps.append(gap)
        if seam is not None:
            seams.append(seam)
        offsets.append(offset)
        if tail:
            tails.add(tail)
    if "UTC" not in names or len(names) < 300 or not gaps or not seams:
        raise ValueError("incomplete PostgreSQL standard IANA artifact")
    return {
        "timezone_file_count": len(names),
        "timezone_manifest_sha256": sha256(b"".join(hashes)).hexdigest(),
        "distinct_posix_footers": len(tails),
        "minimum_transition_spacing_seconds": min(gaps),
        "minimum_explicit_to_footer_spacing_seconds": min(seams),
        "maximum_offset_seconds": max(offsets),
    }


def docker_output(*command):
    return subprocess.check_output(["docker", *command], text=True)


def disposable_artifact(container, database):
    return json.loads(docker_output(
        "exec", container, "psql", "-X", "-Atq", "-v", "ON_ERROR_STOP=1",
        "-h", "/var/run/postgresql", "-U", "postgres", "-d", database,
        "-c", READ_TIMEZONE_ARTIFACT_SQL,
    ))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("container", help="Disposable running Docker container name or ID")
    parser.add_argument("database", help="Database name in that container, never a connection string")
    args = parser.parse_args()
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]*", args.container):
        parser.error("container must be a local Docker name or ID")
    if not re.fullmatch(r"[A-Za-z0-9_]+", args.database):
        parser.error("database must be a local database name")
    inspect, = json.loads(docker_output("inspect", "--type=container", args.container))
    artifact = disposable_artifact(args.container, args.database)
    print(json.dumps({
        "image_reference": inspect["Config"]["Image"],
        "image_config_digest": inspect["Image"],
        "server": artifact["server"],
        "timezone_root": artifact["rules_root"],
        **audit(artifact),
    }, indent=2))


if __name__ == "__main__":
    main()
