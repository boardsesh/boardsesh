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

`crewFeed(input: { limit, cursor })` returns a union of `CrewSessionItem` and
`CrewClimbItem`, newest first. It includes existing session highlights and the
last 30 days of canonical published climbs from currently followed authors.
New-climb cards carry `renderBoard`, resolved from each climb's compatible sizes,
so their thumbnail and preview use the same geometry (including Woods 8x10).
Publication time wins over creation time, so publishing an old draft is new
activity. Imports use the source creation date; an old catalogue import is not
new activity. Invalid timestamps, drafts, hidden/unlisted climbs, and inaccessible
spray walls are excluded. New-climb metadata is checked again during enrichment.

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

The setter picker separates selection (checkbox), opening a setter's computed
playlist (name), and following (Follow/Unfollow). Its Following toggle filters
before the top-50 limit. The search sheet's followed-author switch intersects
with its other filters; setter playlists deliberately start with only the exact
setter and current board configuration, sorted newest first. Opening a playlist
does not hand the picker's draft back until the picker is removed.

Crew uses the mixed endpoint across boards. Gym/Everyone keeps the existing
session feed. New-climb previews use the server-resolved board geometry and fetch
the full climb through the existing reference-navigation path.

SQLite migration 9 adds an account-keyed author snapshot, cleared on sign-out.
It stores complete linked-account metadata, including users with no linked
accounts. Local following searches use the same three membership rules as the
server and require both a matching signed-in owner and complete author metadata.
An unknown Boardsesh user can be followed offline, but following-only search
asks for a sync until that user's linked accounts are known.

Follow writes update SQLite and enqueue the existing Follow/Unfollow operations
atomically. Opposite pending writes are cancelled, with a corrective final
mutation always queued. A snapshot refresh cannot overwrite pending changes or
a toggle that raced its response; the drain and sync invalidations refresh
author metadata, search/counts, setter lists, and Crew. Unfollowing a setter
also removes its known linked user follow locally, matching the backend side
effect; ambiguous linked usernames require a sync before Following searches.
Other setter-to-user follow side effects reconcile after delivery.
