# Climbing data exports

Signed-in climbers open **Settings → Export climbing data**, select a board and
format, then download JSON through their system browser. No linked manufacturer
account is required. Native save/share is tracked in
[#5892](https://github.com/boardsesh/boardsesh/issues/5892).

## Formats and freshness

Boardsesh JSON supports every shared `SUPPORTED_BOARDS` entry, including
MoonBoard, Woods, and spray walls. Schema version 1 contains account identity,
ticks, favorites, owned playlists, and authored climbs including drafts. It
preserves raw/canonical identifiers, statuses, notes, mirror flags, ratings,
dates, board/layout references, playlist order, and raw climb frames. Bigint IDs
are strings; unresolved climb references remain present. This is a personal
climbing archive, not a board catalogue, authentication backup, or wall-photo
export.

Spray-wall climb metadata follows wall access when the snapshot is generated.
If a wall becomes private or gym membership ends, personal tick notes, favorites,
and playlist references remain in the export, while inaccessible climb names and
authored definitions are omitted. Climbs on the climber's own private walls remain
available.

Aurora JSON is an additional format for Kilter, Tension, Decoy, Touchstone,
Grasshopper, and So iLL. Its existing `user`, `ascents`, `attempts`, `circuits`,
`climbs`, and `likes` shape is preserved. It identifies climbs by name and omits
some Boardsesh details; availability does not promise manufacturer-app import.

Generation only follows a request. The first snapshot for a user and board in a
UTC ISO week is reused until the next week; repeated downloads do not regenerate
it. The screen shows generation, refresh, and expiry dates. Changes waiting to
sync are absent from a server snapshot; the app warns about pending changes and
does not automatically drain them as part of exporting.

## Backend contract

Three authenticated GraphQL operations are shared with mobile:

1. `userDataExport(boardType, period?)` reads weekly status and file metadata;
   omitting the period selects the current week.
2. `requestUserDataExport(boardType)` coalesces generation with existing work.
3. `userDataExportDownload(boardType, period, format)` issues a fresh five-minute
   private browser-download link.

Identity always comes from authentication. The service verifies the account
still exists, including on retained legacy Aurora HTTP export/download routes.
A validated period lets a job crossing Monday finish polling and download its
original snapshot. Refreshing a completed older snapshot selects the current week.

The period lookup window is 21 days from the ISO week's Monday; file availability
is separately limited to 14 days from snapshot creation. This preserves a
late-Sunday snapshot into the third calendar week. A valid period can return
`files: []` after expiry or when no file was prepared. Clients use the returned
status and file metadata rather than treating an accepted period as a ready file.

The legacy `downloadUrl` field remains an authenticated Aurora-only REST proxy
for existing clients and is deprecated. New clients request
`userDataExportDownload` to obtain a direct private-storage link.

The `user-data-export` family uses the existing `maintenance-delivery` worker.
Producers serialize on the account row and reuse matching queued/running/retrying
ledger jobs. pg-boss `stately` alone permits an active plus queued twin. The worker
reads its injected primary database, loads personal collections once, and uses
the immutable archive to produce a missing Aurora companion. Conditional uploads
preserve a winning snapshot across retries and overlapping attempts.

Limits: one active job per existing worker process; two runs per user/board/week;
one automatic retry per run; five-minute attempt lease; 30-second heartbeat;
30-minute overall deadline. Terminal failure permits another run after five
minutes while budget remains. User-filtered queries are indexed including drafts.
Storage failures do not masquerade as cache misses and cause regeneration.

Queries return the climber's own records. Playlist result rows grow linearly with
climb memberships in owned playlists, plus one row for each empty playlist. The
full archive and its serialized output are materialized in memory, so peak memory
grows with personal history. Monitor large logbooks; generation has no record cap
or pagination and does not silently truncate records.

## Private storage and retention

Objects remain under `user-data-exports/` in `boardsesh-user-private`, with no
public domain or `r2.dev` URL. Uploads carry attachment filenames and
`private, no-store`. Each download tap signs a direct GET: bytes bypass backend
proxying, and browser navigation needs no private-bucket CORS. Never log or cache
signed URLs or archive contents.

Cloudflare manages rule `boardsesh-user-data-exports-14d`, expiring that prefix
after 1,209,600 seconds. The apply tool re-reads and merges only its own rule ID,
preserving all unrelated rules. Unreadable policies, duplicate IDs, and conflicting
prefix ownership block changes. Link issuance enforces the 14-day age while R2's
physical cleanup is pending. Only generated copies expire; source records remain.

## Rollout

1. Apply generated indexes and rerun worker grants with the
   `maintenance-delivery` login configured; its export reads have a restricted-role
   integration test.
2. Supply the private bucket's `PRIVATE_*` configuration to the existing worker.
   Deploy the new family before producers; verify storage and an unpaused worker.
3. Converge Cloudflare retention using its existing dry-run/apply workflow. Verify
   the prefix and age; a newly created bucket needs a second converge. Resolve any
   blocked policy before enabling exports.
4. Add `user-data-export` to the backend's existing `BATCH_FAMILIES_ENABLED`
   comma-separated list, preserving its other enabled families. Deploy
   backend/mobile; verify a named browser download and repeated-download cache reuse.
5. Observe duration, bytes, cache reuse, and failures. Validate large logbooks and
   actual iOS/Android browser downloads before completing device QA.

See [user-media-storage.md](./user-media-storage.md) for bucket configuration and
[background-workers.md](./background-workers.md) for queue/grant deployment.
