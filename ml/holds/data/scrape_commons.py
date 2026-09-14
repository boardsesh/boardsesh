#!/usr/bin/env python3
"""Collect real climbing-wall photos from Wikimedia Commons for the evaluation corpus.

Commons is the only large keyless source whose per-file licence is machine
readable, which is what makes the corpus traceable: every downloaded photo gets a
row in `sources.csv` with its file page, its licence, its author and the date it
was fetched. Non-commercial and no-derivatives licences are dropped, not warned
about.

The photos land in `.data/realwall/`, which is gitignored — scraped images are
never committed. Only a CC-licensed photo with its attribution recorded may be
promoted into `fixtures/`.
"""

from __future__ import annotations

import argparse
import csv
import json
import re
import sys
import time
import urllib.parse
import urllib.request
from datetime import date
from pathlib import Path

HOLDS_DIR = Path(__file__).resolve().parent.parent
API = "https://commons.wikimedia.org/w/api.php"
USER_AGENT = "boardsesh-hold-spike/1.0 (https://boardsesh.com; sales@boardsesh.com)"

# Categories and searches that actually return walls covered in holds rather than
# portraits of climbers. Ordered best-first; the caller caps the total.
CATEGORIES = [
    "Category:Spray wall",
    "Category:Climbing holds",
    "Category:Climbing walls",
    "Category:Indoor climbing",
    "Category:Rock climbing gyms",
    "Category:Bouldering walls",
    "Category:Campus boards",
]
SEARCHES = [
    "bouldering wall holds",
    "climbing wall holds indoor",
    "Klettergriffe Kletterwand",
    "boulder gym wall holds",
    "training board climbing holds",
]

UNUSABLE_LICENCE = re.compile(r"\bNC\b|\bND\b|non-?commercial|no-?deriv", re.IGNORECASE)


def call_api(params: dict[str, str]) -> dict:
    query = urllib.parse.urlencode({**params, "format": "json"})
    request = urllib.request.Request(f"{API}?{query}", headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(request) as response:
        return json.load(response)


def strip_markup(value: str) -> str:
    return re.sub(r"\s+", " ", re.sub(r"<[^>]+>", "", value or "")).strip()


def candidates(limit_per_source: int, width: int) -> dict[str, dict]:
    found: dict[str, dict] = {}

    def collect(params: dict[str, str], label: str) -> None:
        try:
            payload = call_api(
                {
                    **params,
                    "action": "query",
                    "prop": "imageinfo",
                    "iiprop": "url|extmetadata|size|mime",
                    "iiurlwidth": str(width),
                }
            )
        except Exception as error:  # noqa: BLE001 — one bad query must not kill the crawl
            print(f"  {label}: {type(error).__name__}: {error}", file=sys.stderr)
            return
        for page in payload.get("query", {}).get("pages", {}).values():
            if "imageinfo" not in page:
                continue
            info = page["imageinfo"][0]
            if not info.get("mime", "").startswith("image/") or info.get("mime") == "image/svg+xml":
                continue
            metadata = info.get("extmetadata", {})
            licence = strip_markup(metadata.get("LicenseShortName", {}).get("value", ""))
            if not licence or UNUSABLE_LICENCE.search(licence):
                continue
            found.setdefault(
                page["title"],
                {
                    "title": page["title"],
                    "licence": licence,
                    "author": strip_markup(metadata.get("Artist", {}).get("value", ""))[:160],
                    "page": info["descriptionurl"],
                    "download": info.get("thumburl") or info["url"],
                    "width": info.get("width"),
                    "height": info.get("height"),
                    "discovered_via": label,
                },
            )

    for category in CATEGORIES:
        collect(
            {
                "generator": "categorymembers",
                "gcmtitle": category,
                "gcmtype": "file",
                "gcmlimit": str(limit_per_source),
            },
            category,
        )
        time.sleep(0.6)  # Commons rate-limits an impatient client with 429s
    for search in SEARCHES:
        collect({"generator": "search", "gsrsearch": search, "gsrnamespace": "6", "gsrlimit": str(limit_per_source)}, search)
        time.sleep(0.6)
    return found


def slugify(title: str) -> str:
    stem = title.removeprefix("File:").rsplit(".", 1)[0].lower()
    return re.sub(r"-+", "-", re.sub(r"[^a-z0-9]+", "-", stem)).strip("-")[:70]


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", default=str(HOLDS_DIR / ".data" / "realwall"))
    parser.add_argument("--limit", type=int, default=60, help="cap on downloaded photos")
    parser.add_argument("--limit-per-source", type=int, default=40)
    parser.add_argument("--long-side", type=int, default=1280)
    args = parser.parse_args()

    from PIL import Image

    out = Path(args.out)
    images_dir = out / "images"
    images_dir.mkdir(parents=True, exist_ok=True)

    found = candidates(args.limit_per_source, args.long_side)
    print(f"{len(found)} candidates with a usable licence")

    rows: list[dict] = []
    for entry in list(found.values())[: args.limit]:
        file_name = f"{slugify(entry['title'])}.jpg"
        destination = images_dir / file_name
        if not destination.exists():
            try:
                request = urllib.request.Request(entry["download"], headers={"User-Agent": USER_AGENT})
                with urllib.request.urlopen(request) as response:
                    destination.write_bytes(response.read())
            except Exception as error:  # noqa: BLE001
                print(f"  skip {entry['title']}: {type(error).__name__}", file=sys.stderr)
                continue
            time.sleep(0.4)
        try:
            with Image.open(destination) as handle:
                handle = handle.convert("RGB")
                scale = min(1.0, args.long_side / max(handle.size))
                if scale < 1.0:
                    handle = handle.resize((round(handle.width * scale), round(handle.height * scale)), Image.LANCZOS)
                handle.save(destination, quality=88)
                size = handle.size
        except Exception as error:  # noqa: BLE001
            print(f"  unreadable {file_name}: {type(error).__name__}", file=sys.stderr)
            destination.unlink(missing_ok=True)
            continue

        rows.append(
            {
                "file_name": file_name,
                "commons_title": entry["title"],
                "page_url": entry["page"],
                "image_url": entry["download"],
                "licence": entry["licence"],
                "author": entry["author"],
                "width": size[0],
                "height": size[1],
                "orientation": "portrait" if size[1] > size[0] else "landscape",
                "discovered_via": entry["discovered_via"],
                "fetched_on": date.today().isoformat(),
            }
        )

    with (out / "sources.csv").open("w", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=list(rows[0]) if rows else ["file_name"])
        writer.writeheader()
        writer.writerows(rows)

    licences: dict[str, int] = {}
    for row in rows:
        licences[row["licence"]] = licences.get(row["licence"], 0) + 1
    print(f"downloaded {len(rows)} photos to {images_dir}")
    for licence, count in sorted(licences.items(), key=lambda item: -item[1]):
        print(f"  {count:3d}  {licence}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
