# Woods climb rules and authoring

Woods catalog problems carry independent `matching` and `anyFeet` booleans. The
scraper stores both in `woodsboard_8x10.json` and `woodsboard_12x12.json`; no new
scrape is required to repair the catalog imported before issue #4827.

## Stored rules

`board_climbs.characteristics` is the source of truth, shared by GraphQL, party
queues, and offline downloads. `matching: false` maps to `no_match`;
`anyFeet: true` maps to `any_feet`. An empty array on Woods means the rules are
known: matching is allowed and only marked holds may be used for feet. NULL
means the rules have not been imported, so the drawer shows unknown states.

The importer validates both booleans and refreshes only these two tokens on
re-import. Other app-authored tokens survive. Aurora catalog sync similarly
owns only `no_match` and preserves characteristics authored in Boardsesh.
MoonBoard imports similarly refresh only method tokens.

## Repair existing rows

Supply the catalog directory and a database connection through the environment.
The default mode opens a read-only transaction and reports matching, unmatched,
unchanged, and proposed update counts:

```sh
vp run db:repair-woods-rules -- /path/to/woodsboard-scraper/catalog
```

The audited September 2026 snapshot has 5,418 source records, including two
without holds and 24 duplicate identities, resolving to 5,392 stored climbs.
All 5,392 UUIDs matched. The reported "Treat yo self" (12×12, 40°) has matching
allowed and any feet off. A newer catalog or database may produce different
counts; inspect the dry-run before applying.

With a write-capable connection, apply exactly this repair:

```sh
WOODS_IMPORT_ALLOW_REMOTE=1 vp run db:repair-woods-rules -- /path/to/woodsboard-scraper/catalog --apply
```

The remote override is unnecessary for a local database. The read-only
connection used for investigation cannot apply the repair. The repair only
updates characteristics on existing imported Woods climbs whose UUID, hold
frames, and size match. It leaves authored climbs and unmatched records alone,
rejects conflicting catalog flags, and rolls back on concurrent row changes.
Re-running an applied repair reports no changes. Existing database triggers
advance the sync cursor, delivering repaired rules to downloaded boards.

## Authoring and compatibility

New Woods climbs are stored in Boardsesh; there is no upstream Woods publish
request. Board size is mandatory and immutable because the two physical sizes
reuse hold numbers at different positions. Creation uses existing geometry and
Woods role codes, one static frame, and normal ownership/edit-window rules.

New clients send explicit `noMatch` and `anyFeet` booleans. Omission preserves
the existing rule on update. The older characteristics input continues to own
only campus and no-kickboard, so an old client cannot clear any-feet by sending
an empty list. Backend support must ship before clients send the new fields.

Woods displays both rules in the drawer. Campus and any-feet are incompatible;
kickboard restrictions remain independent. Fork navigation carries structured
characteristics rather than reconstructing them from description text. Rules
participate in duplicate detection, so changing rules can produce a distinct
climb with identical holds. Woods duplicates and similar climbs are scoped to
physical board size. The editor refuses to preview on a different Woods wall,
and queue sending skips climbs whose recorded physical size differs.

Before enabling authoring in production, complete the repair and test painting,
saving, reopening, and lighting climbs on both Woods sizes. Fable review is required for Bluetooth changes. Automated geometry and protocol
checks do not establish physical LED behavior; verify both walls on hardware.
