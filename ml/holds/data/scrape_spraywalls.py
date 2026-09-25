#!/usr/bin/env python3
"""Collect real spray-wall photos for the evaluation corpus.

The gap the first pass left: 28 Commons photos with exactly one tagged
`spray-wall`. A spray wall — a home or gym wall covered edge to edge with holds
from many routes at once — is the product's actual subject and barely exists on
Commons. It does exist on Reddit, where climbers post their home walls.

Licensing, stated plainly because it decides what these photos may be used for:
Reddit submissions are **not** openly licensed. Everything this script fetches is
**evaluation only**. It lands in the gitignored `.data/spraywalls/`, is never
committed, is never used as training data, and is never redistributed. Each photo
gets a `sources.csv` row with its permalink so any of it can be removed on
request. Only a CC-licensed photo with recorded attribution may ever be promoted
into `fixtures/` — and none of these qualify.

Commons results, which do carry a licence, are fetched by `scrape_commons.py`
instead and kept separate.
"""

from __future__ import annotations

import argparse
import csv
import json
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import date, datetime, timezone
from pathlib import Path

HOLDS_DIR = Path(__file__).resolve().parent.parent
USER_AGENT = "boardsesh-hold-spike/1.0 (research; sales@boardsesh.com)"

# Subreddits where a photo of a whole wall is the normal kind of post, paired with
# the queries that pull spray walls rather than portraits of climbers.
FEEDS: list[tuple[str, dict[str, str]]] = [
    ("r/homewalls/top", {"t": "all", "limit": "100"}),
    ("r/homewalls/top", {"t": "year", "limit": "100"}),
    ("r/homewalls/hot", {"limit": "100"}),
    ("r/homewalls/new", {"limit": "100"}),
]
SEARCHES: list[tuple[str, str]] = [
    ("homewalls", "spray wall"),
    ("homewalls", "home wall"),
    ("climbharder", "spray wall"),
    ("bouldering", "spray wall"),
    ("bouldering", "home wall"),
    ("climbing", "spray wall"),
]

IMAGE_HOST = re.compile(r"^https://(i\.redd\.it|preview\.redd\.it)/")
TITLE_HINT = re.compile(
    r"spray|home ?wall|woody|garage|shed|board|basement|wall build|finished", re.IGNORECASE
)


def fetch_json(url: str) -> dict | None:
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            return json.load(response)
    except (urllib.error.URLError, json.JSONDecodeError, TimeoutError) as error:
        print(f"  {type(error).__name__}: {url}", file=sys.stderr)
        return None


def image_urls(post: dict) -> list[str]:
    """Every full-size image a submission carries, gallery posts included."""
    urls: list[str] = []
    direct = post.get("url_overridden_by_dest") or post.get("url") or ""
    if IMAGE_HOST.match(direct) and direct.split("?")[0].lower().endswith((".jpg", ".jpeg", ".png")):
        urls.append(direct)

    media_metadata = post.get("media_metadata") or {}
    for entry in media_metadata.values():
        source = (entry or {}).get("s") or {}
        candidate = source.get("u") or source.get("gif")
        if candidate:
            urls.append(candidate.replace("&amp;", "&"))
    return urls


def harvest(limit: int, min_score: int) -> dict[str, dict]:
    posts: dict[str, dict] = {}

    def take(listing: dict | None, origin: str) -> None:
        if not listing:
            return
        for child in listing.get("data", {}).get("children", []):
            post = child.get("data", {})
            if post.get("over_18") or post.get("is_video"):
                continue
            if post.get("score", 0) < min_score:
                continue
            title = post.get("title", "")
            # Search feeds are already on-topic; the generic subreddit feeds are not.
            if origin.startswith("r/") and not TITLE_HINT.search(title):
                continue
            for index, url in enumerate(image_urls(post)):
                posts.setdefault(
                    url,
                    {
                        "url": url,
                        "permalink": f"https://www.reddit.com{post.get('permalink', '')}",
                        "title": title[:180],
                        "subreddit": post.get("subreddit", ""),
                        "score": post.get("score", 0),
                        "created": datetime.fromtimestamp(post.get("created_utc", 0), timezone.utc).date().isoformat(),
                        "origin": origin,
                        "gallery_index": index,
                    },
                )

    for feed, params in FEEDS:
        url = f"https://www.reddit.com/{feed}.json?{urllib.parse.urlencode(params)}"
        print(f"[{feed}]")
        take(fetch_json(url), feed)
        time.sleep(2.0)  # Reddit rate-limits an anonymous client hard

    for subreddit, query in SEARCHES:
        params = {"q": query, "restrict_sr": "1", "sort": "top", "t": "all", "limit": "100"}
        url = f"https://www.reddit.com/r/{subreddit}/search.json?{urllib.parse.urlencode(params)}"
        print(f"[search r/{subreddit}: {query}]")
        take(fetch_json(url), f"search:{subreddit}:{query}")
        time.sleep(2.0)

    ranked = sorted(posts.values(), key=lambda entry: -entry["score"])
    return {entry["url"]: entry for entry in ranked[:limit]}


def slugify(entry: dict) -> str:
    stem = re.sub(r"[^a-z0-9]+", "-", entry["title"].lower()).strip("-")[:48] or "wall"
    suffix = entry["url"].rsplit("/", 1)[-1].split("?")[0].rsplit(".", 1)[0][:12]
    return f"{entry['subreddit'].lower()}-{stem}-{suffix}"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--out", default=str(HOLDS_DIR / ".data" / "spraywalls"))
    parser.add_argument("--limit", type=int, default=120)
    parser.add_argument("--min-score", type=int, default=5)
    parser.add_argument("--long-side", type=int, default=1280)
    args = parser.parse_args()

    from PIL import Image

    out = Path(args.out)
    images_dir = out / "images"
    images_dir.mkdir(parents=True, exist_ok=True)

    candidates = harvest(args.limit, args.min_score)
    print(f"{len(candidates)} candidate images")

    rows: list[dict] = []
    for entry in candidates.values():
        file_name = f"{slugify(entry)}.jpg"
        destination = images_dir / file_name
        if not destination.exists():
            request = urllib.request.Request(entry["url"], headers={"User-Agent": USER_AGENT})
            try:
                with urllib.request.urlopen(request, timeout=45) as response:
                    destination.write_bytes(response.read())
            except Exception as error:  # noqa: BLE001 — one dead link must not end the crawl
                print(f"  skip {file_name}: {type(error).__name__}", file=sys.stderr)
                continue
            time.sleep(0.8)
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
                "image_url": entry["url"],
                "page_url": entry["permalink"],
                "title": entry["title"],
                "subreddit": entry["subreddit"],
                "score": entry["score"],
                "posted_on": entry["created"],
                "licence": "not stated (Reddit user content) — evaluation only, never redistributed, never training data",
                "width": size[0],
                "height": size[1],
                "orientation": "portrait" if size[1] > size[0] else "landscape",
                "discovered_via": entry["origin"],
                "fetched_on": date.today().isoformat(),
            }
        )

    if rows:
        with (out / "sources.csv").open("w", newline="") as handle:
            writer = csv.DictWriter(handle, fieldnames=list(rows[0]))
            writer.writeheader()
            writer.writerows(rows)

    portraits = sum(1 for row in rows if row["orientation"] == "portrait")
    print(f"downloaded {len(rows)} photos to {images_dir}")
    print(f"  {portraits} portrait, {len(rows) - portraits} landscape")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
