# Followed authors and Crew

Setter follows keep their existing global username identity. A setter does not
need a Boardsesh account. Following a linked Boardsesh user also includes that
user's native climbs and imported climbs matched by board type and board username.
The same predicate serves `searchClimbs`, `setterStats`, and `crewFeed`.

`onlyFollowedAuthors` is optional on search and setter inputs and requires an
authenticated viewer when true. It intersects with other filters and is applied
before counts and pagination. These searches bypass the shared Redis cache.

`followedAuthors` returns a complete, authenticated snapshot: `setterUsernames`
and `users { userId, boardAccounts { boardType, username } }`. A user with no
linked accounts is returned with an empty array. Reads use a repeatable-read
transaction so the snapshot cannot mix two versions of the follow list.

`crewFeed(input: { limit, cursor, timeZone })` returns a union of
`CrewSessionItem`, `CrewClimbItem` and `CrewClimbGroupItem`, newest first. It
includes existing session highlights and the last 30 days of canonical published
climbs from currently followed authors.
New-climb cards carry `renderBoard`, resolved from each climb's compatible sizes,
so their thumbnail and preview use the same geometry (including Woods 8x10).
Publication time wins over creation time, so publishing an old draft is new
activity. Imports use the source creation date; an old catalogue import is not
new activity. Invalid timestamps, drafts, hidden/unlisted climbs, and inaccessible
spray walls are excluded. New-climb metadata is checked again during enrichment.

## Setter day groups

One card covers everything a setter published on one day. The grouping key is
`(board type, author, local day)`, where the author is
`COALESCE(NULLIF(setter_username, ''), 'user:' || user_id)` — the username is
what the card shows and what two of the three follow paths match on, and the
user-id fallback keeps a native climb with no username from collapsing every
such climb into one group under SQL's "all NULLs are one group" rule.

`timeZone` is an IANA zone (the mobile client sends the device's) and decides
where the day breaks: a climb published at 23:00 local belongs to that local day.
It reaches `AT TIME ZONE`, so an unrecognised zone degrades to UTC rather than
failing the feed — Postgres raises on a name it does not know.

A card carries at most `CREW_CLIMB_GROUP_LIMIT` (10) climbs, newest first, plus
`totalCount` for the rest; the client links those to the setter page. A group of
exactly one is emitted as a `CrewClimbItem`, not a one-element group, so a client
that predates `CrewClimbGroupItem` keeps rendering single new climbs instead of
dropping them on a union member it cannot match. Keep that fallback until the
store fleet has moved.

Crew candidate selection starts with three author-index lookups (direct setter,
native user, linked board account), combined with `UNION` to remove overlaps.
A narrow `MATERIALIZED` CTE keeps publication-date validation outside those
lookups, so every page parses dates only for followed climbs instead of scanning
the whole catalogue. Do not inline that CTE or move date predicates into its
branches — the second CTE (`crew_climb_rows`) is materialized for the same
reason: the aggregate reads each row's parsed instant in its select, group,
having and order clauses.

Grouping runs **before** the page is cut, so a setter's day cannot be split
across two pages. That forces the cursor into a `HAVING` over `max(pub)`: as a
`WHERE` it would drop a group's newest members, move the group's timestamp
backwards, and hand the same setter a second card on a later page. Do not move it
back. A card's id is its group id, and the cursor carries that same id.

Selected groups are then expanded by a second query that ranks each group's
climbs with one window function over the same followed set and takes the top
`perGroup`; enrichment is a single `IN` over the uuids that survive, so a page
costs two queries however many climbs the groups hold. Visibility, the 30-day
window, and the exact cursor are applied before the candidate limit; enrichment
still rechecks current follows and visibility.
The intermediate rows scale with the viewer's complete followed catalogue, not
the page size. A viewer following prolific setters can therefore cost more than
the measured 1,963-row sample. Do not cap this intermediate set: doing so before
date validation and global ordering could drop newer climbs or break pagination.

Both sources supply at most `limit + 1` candidates to one backend merge. Only
selected candidates are enriched. The opaque cursor carries the viewer, initial
snapshot time, exact ordering timestamp, and stable prefixed ID. Session candidate
selection and every tick-backed enrichment query exclude ticks newer than the
snapshot, keeping totals, participants, grades, board types, and highlights aligned.
Existing `sessionGroupedFeed`
callers keep offset pagination and their current result shape.

A page can contain fewer than `limit` items after the visibility recheck, while
still carrying `hasMore: true`. The cursor advances past the selected candidates,
including any that disappeared. Clients request one page per end-reach; they
must not drain pages automatically to fill a viewport.

These APIs are additive. Deploy the backend before releasing the mobile client
that consumes them. Notification delivery and existing website follows retain
their current behavior.

## Mobile

Discover's For You shelf appends followed setters' computed playlists after
personal smart playlists. It uses the active board's type, layout, size, sets,
and angle with `onlyFollowedAuthors`, preserving the setter query's top-50
count-descending/name-ascending order. Setters without matching climbs are
omitted. Direct setter follows and linked followed users both contribute;
returning to Discover refreshes the shelf. These cards open the existing setter
playlist and do not offer pinning. The virtualized shelf keeps personal cards
visible while setters load, and locally available followed-setter results can
keep the shelf usable offline.

The setter picker separates selection (checkbox), opening a setter's computed
playlist (name), and following (Follow/Unfollow). Its All setters / Following
segments filter before the top-50 limit without changing the selected checkboxes.
Following also includes setters linked to followed Boardsesh users; these rows
explain the indirect follow separately from the direct setter-follow action.
The search sheet's followed-author switch intersects
with its other filters; setter playlists deliberately start with only the exact
setter and current board configuration, sorted newest first. Opening a playlist
does not hand the picker's draft back until the picker is removed.
If no board is active, choosing one returns to the same setter playlist via
the board picker's allow-listed, encoded return route.

Crew uses the mixed endpoint across boards. Gym/Everyone keeps the existing
session feed. New-climb previews use the server-resolved board geometry and fetch
the full climb through the existing reference-navigation path.

SQLite migration 9 adds an account-keyed author snapshot, cleared on sign-out.
It stores complete linked-account metadata, including users with no linked
accounts. Local following searches use the same three membership rules as the
server and require both a matching signed-in owner and complete author metadata.
An unknown Boardsesh user can be followed offline, but following-only search
asks for a sync until that user's linked accounts are known.
The boot warm-up runs after schema readiness and owner stamping, even if a
screen already fetched authors before SQLite was ready. Queued user unfollows
remove the person from the viewer's cached Following list and update their
following count without waiting for connectivity; other users' lists keep their
membership.

Follow writes update SQLite and enqueue the existing Follow/Unfollow operations
atomically. Opposite pending writes are cancelled, with a corrective final
mutation always queued. A snapshot refresh cannot overwrite pending changes or
a toggle that raced its response; the drain and sync invalidations refresh
author metadata, search/counts, setter lists, and Crew. Unfollowing a setter
also removes its known linked user follow locally, matching the backend side
effect; ambiguous linked usernames require a sync before Following searches.
Known linked-user removals also reconcile cached profiles and the viewer's
Following list immediately, just like a direct user unfollow.
Other setter-to-user follow side effects reconcile after delivery.
