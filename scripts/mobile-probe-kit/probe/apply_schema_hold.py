#!/usr/bin/env python3
"""Keep a probe build from migrating the phone's offline database. See docs/mobile/mobile-visible-performance.md.

    apply_schema_hold.py <repo-root>

Installing a build that knows a newer on-device migration migrates the tester's
real database, and their store build then refuses the file until that migration
ships (the downgrade rule in docs/data/offline-sync.md). Check first:
`schema_check.py` prints the phone's version next to the checkout's.

This holds the build at version 12. It leaves out migration 13, which only adds
`idx_stats_ascents`, and points the climb list's ranked walk at the same index
under a probe-only name. Create that index once on the phone if it is missing
(the first #6313 measurement did, as `idx_stats_ascents_probe`); without it the
default climb list fails to load.

Delete this script once the store build knows version 13, and write its
successor for the next migration: what to leave out, and what stands in for it.
"""
import sys

if len(sys.argv) != 2:
    sys.exit(__doc__)
root = sys.argv[1].rstrip("/")


def edit(path, old, new):
    text = open(root + path).read()
    assert text.count(old) == 1, (path, old[:70], text.count(old))
    open(root + path, "w").write(text.replace(old, new))


migrations = "/packages/shared/offline-sync/src/db/migrations.ts"
text = open(root + migrations).read()
start_marker = "  {\n    // The climb list's default order as an index: one board at one angle, most\n"
end_marker = "    version: 13,\n    statements: [INDEX_STATS_ASCENTS],\n  },\n"
assert text.count(start_marker) == 1 and text.count(end_marker) == 1, "migration 13 has moved; re-fit apply_schema_hold.py"
start, end = text.index(start_marker), text.index(end_marker) + len(end_marker)
assert "version: 14" not in text, "a migration after 13 exists; this hold is out of date"
open(root + migrations, "w").write(text[:start] + text[end:])

edit("/packages/mobile/src/db/queries/search-climbs-local.ts",
     "const RANKED_WALK_INDEX = 'idx_stats_ascents';",
     "const RANKED_WALK_INDEX = 'idx_stats_ascents_probe';")

print("schema held at version 12")
