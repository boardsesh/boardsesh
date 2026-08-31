# Aurora gym location sync

How gym boards for the Aurora board family (Tension, Decoy, Grasshopper, So iLL,
Touchstone) get onto the map, and how their configuration is kept true.

Kilter is **not** covered here — it has its own richer per-wall importer in
`packages/kilter-sync`, because Kilter's backend serves wall data without auth.

## The problem this solves

`GET /pins?gyms=1` is unauthenticated and returns only `id`, `username`, `name`,
`latitude`, `longitude`. It carries no board configuration at all, so every
Aurora gym board used to be published from a hardcoded per-board default
(`resolveDefaultAuroraLocationConfig`). For Tension that pinned **every gym in
the world** to layout 10, *Tension Board 2 Mirror*:

| | gym boards | on the default | carrying a serial |
|---|---|---|---|
| tension | 477 | 402 | 17 |

A Spray wall (layout 11) was unrepresentable — the Benchmark Climbing report
that started this work. The missing serials matter just as much: with no serial
a BLE connect resolves nothing, binds the climber's *route* config instead, and
the remembered pointer sends them to the wrong board from then on (#4864).

## Where the truth comes from

`GET https://{board}.com/users/{pin id}` with a session cookie. The pin id **is**
the gym's Aurora user id, and the response carries `walls[]`:

```
layout_id  product_size_id  set_ids[]  angle  is_adjustable  serial_number  is_listed
```

which is exactly what `resolveAuroraWallConfig` consumes. The endpoint returns
**401 unauthenticated** — that is why the public `@hangtime/climbing-boards`
dataset has walls for Kilter but not for any Aurora board.

## The two paths

**Hourly, unauthenticated (discovery).** `syncAuroraBoardLocations` piggybacks on
the shared-sync slot and walks every pin. It keeps new gyms appearing and is what
publishes the default config for a gym nobody has read yet.

**Continuous, authenticated (enrichment).** Each shared-sync cycle also reads a
bounded slice (`GYM_WALL_CRAWL_SLICE`, 25) of the stalest gyms and publishes
their real configuration.

### How the crawl paces itself

- `location_sync_gym_sources.walls_crawled_at` records when a gym's walls were
  last read. Deliberately **not** `updated_at`, which moves whenever the alias
  row is touched and so cannot distinguish real wall data from another guess.
- Never-read gyms come first, then oldest, skipping anything read inside
  `GYM_WALL_RECRAWL_INTERVAL_MS` (7 days).
- Ordering **is** the resume mechanism. There is no stored position, so a
  restart, a redeploy or a second daemon instance simply asks again for whatever
  is stalest. Two instances racing mostly re-read the same handful.
- The hourly cooldown paces it; the weekly floor throttles it once the fleet is
  covered. A first pass over the ~450 Aurora gyms takes about a day, after which
  most cycles find nothing due and cost nothing.

## Rules that are load-bearing

**Crawl failures never touch the credential.** The daemon crawls on the *borrowed*
credential the shared sync is already using, which belongs to a real climber. The
crawl step swallows every error: an escaping one would be recorded against their
credential and could quarantine their personal sync. Catalog upkeep must never
cost a user their account sync.

**An enriched gym is never re-guessed.** The hourly pins-only run cannot read
walls, so without a guard it would republish the default over every enriched row
an hour after the crawl fixed it. `buildAuroraLocationRecords` takes the set of
already-crawled gyms and emits nothing for them. Both paths stamp
`walls_crawled_at` for gyms they read — the daemon crawl *and* the explicit
command.

**Unknown configs are rejected, not coerced.** A wall naming a layout, size or
hold set the catalogue does not know is skipped and reported. Publishing a
plausible-looking guess is the failure this whole system replaces.

**Source keys are stable.** `boardUuidForSource` hashes the key into a
deterministic board UUID, so changing one mints a new row and orphans the live
one along with its ticks, wall history and any printed QR code. The gym's first
wall — by `created_at` over **all** walls, listed or not — keeps the original
`{board}:{pin id}` key; additional walls get `{board}:{pin id}:{wall uuid}`.

**Frozen rows keep their config, but may gain a serial.** A human edit sets
`sync_frozen_at` and the sync never overwrites that row's configuration. It will
still fill a *missing* `serial_number`, because a serial is hardware identity
rather than a curation choice. An already-set serial is never replaced.

## Configuration

The explicit `syncLocations` command authenticates from dedicated per-board
credentials; Aurora accounts do not span board apps:

```
AURORA_LOCATION_USERNAME_TENSION
AURORA_LOCATION_PASSWORD_TENSION
```

With none configured the crawl is a no-op and every gym keeps the default config,
which is exactly the pre-enrichment behaviour — dev and CI need no secrets.

The daemon path needs no secret at all: it reuses the shared sync's borrowed
session.

## Running it by hand

```
vp run sync:aurora -- locations tension     # one board
vp run sync:aurora -- locations all         # every Aurora board
```

Aurora rate-limits per board app, so requests are paced at one every 2.1s with a
per-gym retry and a cap. A crawl of several thousand gyms is measured in hours;
progress is logged every 50 gyms and on the last one.

## Known gaps

- A wall removed upstream is never unlisted — its row stays public. Tracked in
  **#4966**, which needs a decision about the removed board's ticks and history.
- Frozen rows never have their *config* re-synced, even where the crawl now has
  ground truth. Unfreezing them is a separate call (92 Aurora gym boards).
