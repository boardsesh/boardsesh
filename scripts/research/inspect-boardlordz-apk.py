#!/usr/bin/env python3
"""Inventory an APK without loading its code or fetching any embedded URL.

The output records bounded negative searches, not proof of runtime behavior.
Use --output outside the repository for the complete member hash manifest.
"""

import argparse
import hashlib
import json
import re
import zipfile
from pathlib import Path


MAX_MEMBER_BYTES = 64 * 1024 * 1024
MAX_TOTAL_BYTES = 512 * 1024 * 1024
INDICATORS = (
    "boardsesh",
    "ws.boardsesh.com",
    "updates.boardsesh.com",
    "ota-assets.boardsesh.com",
    "x-boardsesh-client",
    "boardsesh-mobile",
    "graphql",
)
APACHE_MARKERS = (
    "apache license",
    "version 2.0, january 2004",
    "terms and conditions for use, reproduction, and distribution",
    "end of terms and conditions",
)
ORIGIN_PATTERN = re.compile(rb"(?:https?|wss?)://[a-zA-Z0-9._:-]+")


def inspect_apk(apk_path: Path) -> dict:
    manifest = []
    indicator_matches = []
    origins = {}
    apache_license_candidates = []
    capacitor_config = None
    capacitor_plugins = None
    total_bytes = 0

    with zipfile.ZipFile(apk_path) as archive:
        members = archive.infolist()
        if sum(member.file_size for member in members) > MAX_TOTAL_BYTES:
            raise ValueError("Archive exceeds the 512 MiB inspection limit")
        for member in members:
            if member.is_dir():
                continue
            if member.file_size > MAX_MEMBER_BYTES:
                raise ValueError(f"Member exceeds the 64 MiB limit: {member.filename}")
            # Reading checks each member's CRC. Nothing is extracted or executed.
            content = archive.read(member)
            total_bytes += len(content)
            manifest.append(
                {
                    "path": member.filename,
                    "bytes": len(content),
                    "sha256": hashlib.sha256(content).hexdigest(),
                }
            )
            lowercase_content = content.lower()
            for indicator in INDICATORS:
                for encoding in ("utf-8", "utf-16le"):
                    encoded_indicator = indicator.encode(encoding)
                    for match in re.finditer(re.escape(encoded_indicator), lowercase_content):
                        indicator_matches.append(
                            {
                                "member": member.filename,
                                "indicator": indicator,
                                "encoding": encoding,
                                "byte_offset": match.start(),
                            }
                        )
            if all(marker.encode() in lowercase_content for marker in APACHE_MARKERS):
                apache_license_candidates.append(member.filename)
            # Literal URL origins are candidates; schema/documentation URLs also match.
            # Deliberately omit query parameters, bodies, cookies and headers.
            for match in ORIGIN_PATTERN.finditer(content):
                origin = match.group().decode("ascii")
                origins.setdefault(origin, set()).add(member.filename)
            if member.filename == "assets/capacitor.config.json":
                capacitor_config = json.loads(content)
            if member.filename == "assets/capacitor.plugins.json":
                capacitor_plugins = json.loads(content)

    ordered_manifest = sorted(manifest, key=lambda entry: entry["path"])
    manifest_bytes = json.dumps(
        ordered_manifest, sort_keys=True, separators=(",", ":")
    ).encode()
    with apk_path.open("rb") as apk_file:
        apk_sha256 = hashlib.file_digest(apk_file, "sha256").hexdigest()
    return {
        "schema_version": 1,
        "artifact": {
            "filename": apk_path.name,
            "bytes": apk_path.stat().st_size,
            "sha256": apk_sha256,
        },
        "coverage": {
            "zip_entries": len(members),
            "regular_members_scanned": len(manifest),
            "uncompressed_bytes_scanned": total_bytes,
            "all_regular_member_crcs_verified": True,
            "indicator_encodings": ["utf-8", "utf-16le"],
            "javascript_members": sum(entry["path"].endswith(".js") for entry in manifest),
            "native_libraries": [entry["path"] for entry in manifest if entry["path"].endswith(".so")],
            "limitations": [
                "No target execution, HTTP requests, signature verification or decryption.",
                "Only decompressed ZIP member bytes are scanned, not APK signing blocks.",
                "Computed, remotely configured, encoded or encrypted destinations can be missed.",
                "Literal origins include documentation and schema URLs, not only network targets.",
                "Four Apache text markers identify candidates, not completeness or compliance.",
            ],
        },
        "capacitor_config": capacitor_config,
        "capacitor_plugins": capacitor_plugins,
        "indicator_matches": indicator_matches,
        "apache_license_candidate_members": apache_license_candidates,
        "license_named_members": [
            entry["path"]
            for entry in manifest
            if re.search(r"license|notice|copying|acknowledge", entry["path"], re.IGNORECASE)
        ],
        "literal_origins": {
            origin: sorted(member_names) for origin, member_names in sorted(origins.items())
        },
        "member_manifest_sha256": hashlib.sha256(manifest_bytes).hexdigest(),
        "member_manifest": ordered_manifest,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("apk", type=Path)
    parser.add_argument("--output", type=Path, required=True)
    arguments = parser.parse_args()
    if arguments.output.resolve() == arguments.apk.resolve():
        parser.error("Output must not overwrite the APK")
    result = inspect_apk(arguments.apk)
    arguments.output.write_text(json.dumps(result, indent=2) + "\n")
    print(
        f"Scanned {result['coverage']['regular_members_scanned']} members; "
        f"SHA256 {result['artifact']['sha256']}"
    )


if __name__ == "__main__":
    main()
