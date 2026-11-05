# Wall devices: lighting Boardsesh climbs from your own hardware

This guide is for people building a device that shows the climb a Boardsesh user
has put on their wall: a laser projector, a custom LED rig, a display. The device
connects to the Boardsesh backend over a WebSocket, listens to one board's "now on
the wall" feed, and draws each climb's holds.

The device never logs in as a person. It uses a controller API key that the board's
owner creates. On the boards that owner owns, private spray walls included, the key
reads the live feed and the hold coordinates as the owner would. Everywhere else it
reads what a signed-out visitor reads, so boards the owner follows, was invited to,
or sees through a gym open no further for the key. It cannot log climbs, change the
queue, edit a wall, or read the owner's account.

## Where the climbs come from

Every climb on this feed is one a climber put on the wall in the Boardsesh app. A
phone connected to the board over Bluetooth reports each climb it lights. Without
Bluetooth, the board owner (or anyone who can edit the board) turns on **Edit board ›
Lights › Lit by a wall device** in the app. Every climber on that board then taps
**Take the wall** instead of connecting, and each climb they put up arrives here. A
board with no LED kit at all works the same way without the switch.

## 1. Get a key

The board's owner creates the key on the website:

1. Sign in at https://www.boardsesh.com and open **Settings**.
2. Scroll to **ESP32 Controllers** and press **Add Controller**.
3. Fill in the form and press **Register Controller**.
4. Copy the key from the **Controller Registered** dialog.

Things to know about this form:

- The key is shown once. Boardsesh does not show it again. If it is lost, delete the
  controller and register a new one.
- **Board Type** offers Kilter, Tension and Spraywall. Choose Spraywall and the form
  asks for nothing else. For Kilter or Tension it asks for a layout, size and hold
  sets, so pick anything that is valid. The feed described here ignores all of them:
  which board the device watches is decided by the `boardId` it subscribes to, and
  what it may read is decided by the key's owner.
- The key belongs to the account that created it. A device using it reads that
  account's own boards, private ones included, plus anything public. The boards it
  can open are exactly the ones `controllerBoards` (section 3) lists.
- Treat the key like a password. Anyone holding it can watch every board its owner
  owns. Deleting the controller in Settings revokes it. A socket that is already open
  loses the owner's boards within 30 seconds (its next event or query after that
  answers `Board not found` on a private board). A new socket using that key still
  connects, but only as a signed-out visitor (see section 2).

## 2. Connect

| Setting          | Value                                         |
| ---------------- | --------------------------------------------- |
| URL              | `wss://ws.boardsesh.com/graphql`              |
| Subprotocol      | `graphql-transport-ws` (the `graphql-ws` one) |
| Connection param | `{ "controllerApiKey": "<the key>" }`         |

Do not send an `Origin` header. The server accepts connections without one (native
and server clients) and rejects origins it does not know. Node's `ws` package sends
none by default.

**Check your user agent first.** A socket upgrade is a GET, and Cloudflare blocks a GET
whose user agent says it is automation: `python`, `bot`, `curl/`, `java/`,
`go-http-client`, `httpclient` and the rest of `AUTOMATION_SIGNATURE_TOKENS` in
`packages/web/app/lib/crawler-policy.ts`. The device gets a plain HTTP 403 with
`Server: cloudflare`, and the backend never sees its key. Node's `ws` sends no user
agent, so the example below gets through. Python's `websockets` sends
`Python/3.12 websockets/13.1` by default, which is blocked.

To get in, put your device's name at the front of its user agent and open a PR adding
that name to `CRAWLER_ALLOW_TOKENS` in the same file ("To let an agent in" in
`docs/cloudflare.md`). The LZRvision projector, for example, sends
`lzrvision-projector/1.0 Python/3.12 websockets/13.1`.

**A key that fails its check does not fail the connection.** A wrong or deleted key, or
a database error at that moment, leaves you with a working socket that reads as a
signed-out visitor. `controllerBoards` answers `UNAUTHENTICATED`, a private board
answers `Board not found`, and a public board keeps working. The socket stays that way
until it reconnects, so treat either answer as a reason to connect again with backoff.

A short Node example with [`graphql-ws`](https://github.com/enisdenjo/graphql-ws)
6.x and `ws`:

```js
import { createClient } from 'graphql-ws';
import WebSocket from 'ws';

const client = createClient({
  url: 'wss://ws.boardsesh.com/graphql',
  webSocketImpl: WebSocket,
  connectionParams: { controllerApiKey: process.env.BOARDSESH_CONTROLLER_KEY },
  retryAttempts: Infinity,
  // 1 s, 2 s, 4 s ... capped at 60 s, with jitter.
  retryWait: async (retries) => {
    const base = Math.min(60_000, 1_000 * 2 ** retries);
    await new Promise((resolve) => setTimeout(resolve, base / 2 + Math.random() * (base / 2)));
  },
  shouldRetry: () => true,
});

const NOW_PLAYING = /* GraphQL */ `
  subscription NowPlaying($boardId: Int!, $boardUuid: ID) {
    boardNowPlaying(boardId: $boardId, boardUuid: $boardUuid) {
      __typename
      ... on BoardClimbSet {
        climb { climbUuid name grade frames angle mirrored seq sentAt }
      }
      ... on BoardClimbCleared { clearedAt seq climbUuid }
    }
  }
`;

let lastSeq = 0;
function followWall() {
  // `retryAttempts` only covers a dropped socket. When the server ends this
  // subscription, nothing retries it for you.
  const tryAgainSoon = () => setTimeout(followWall, 30_000);
  client.subscribe(
    { query: NOW_PLAYING, variables: { boardId: 1234, boardUuid: 'the-wall-uuid' } },
    {
      next: ({ data, errors }) => {
        if (errors) return console.error(errors);
        const event = data.boardNowPlaying;
        const seq = event.__typename === 'BoardClimbSet' ? event.climb.seq : event.seq;
        if (seq <= lastSeq) return; // stale or duplicate
        lastSeq = seq;
        if (event.__typename === 'BoardClimbSet') light(event.climb);
        if (event.__typename === 'BoardClimbCleared') clearWall();
      },
      error: (error) => {
        console.error('subscription failed', error);
        tryAgainSoon();
      },
      complete: () => {
        console.warn('server ended the feed');
        tryAgainSoon();
      },
    },
  );
}
followWall();
```

The same socket can run queries too (`client.subscribe` with a `query { ... }`
document, or `client.iterate`), so the device can fetch hold coordinates without a
second connection.

## 3. Find the board

The device lists its owner's boards itself, so nobody has to copy an id. In your
setup screen, run this once the socket is connected, show the names, and let the
owner pick one:

```graphql
query MyBoards {
  controllerBoards {
    boardId
    uuid
    name
    boardType
    layoutId
    sizeId
    setIds
    angle
    hasLeds
  }
}
```

`controllerBoards` returns every board the key's owner owns: home boards (Kilter,
Tension, MoonBoard and the rest) and spray walls, private ones included. Deleted
boards and archived spray walls (the old wall after a reset) are left out. It lists
only boards the owner owns, not boards they follow or were invited to. It works only
on a socket connected with a controller key; anything else gets an `UNAUTHENTICATED`
error. If the owner deletes the controller in Settings, it stops answering on sockets
that are already open too.

Store the chosen board's `boardId` and `uuid`. Then:

- Subscribe with `boardNowPlaying(boardId: <boardId>, boardUuid: "<uuid>")`. For the
  owner's own boards `boardId` alone is enough; sending the uuid as well does no harm.
- For a spray wall (`boardType: "spray"`), the `uuid` is also the key for
  `sprayWall(uuid)` and `sprayWallRenderData(uuid)` in section 5.
- For any other board, `boardType`, `layoutId`, `sizeId` and `setIds` are what
  section 5 needs for the hold coordinates.

Boardsesh's app and website never show a board's numeric id, so this query is the
way to get it.

## 4. The events

`boardNowPlaying` streams a union, `BoardPresenceEvent`. Every member carries `seq`,
a per-board counter shared by all event kinds that only increases. Use it to order
events and drop duplicates; do not expect it to step by exactly one.

| Event                    | When                                                                                          | Fields                                              |
| ------------------------ | --------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| `BoardClimbSet`          | Someone put a climb on the wall.                                                              | `climb: BoardPresenceClimb!` (the `seq` is inside)  |
| `BoardClimbCleared`      | The phone driving the wall turned off all its lights.                                         | `clearedAt`, `seq`, `climbUuid` (null when unknown) |
| `BoardStatsUpdated`      | Someone logged a tick on this wall.                                                           | `stats`, `seq`                                      |
| `BoardConnectionChanged` | A different person took over the wall, or the holder disconnected (`holder: null`).           | `holder`, `seq`                                     |
| `BoardHistoryUpdated`    | Climbs lit from Kilter's own app were merged in (public Kilter boards, see below).            | `climbs`, `seq`                                     |

Climbs lit from Kilter's own app (not Boardsesh) reach this feed only through Kilter
live sync. A device cannot start that sync: it runs only while a signed-in Boardsesh
user with a linked Kilter account has the board's feed open, for example the owner's
phone. With nobody like that watching, a device sees only climbs lit through
Boardsesh.

A wall device usually needs only `BoardClimbSet` and `BoardClimbCleared`. Select the
others only if you show them. A phone disconnecting does not clear the wall: the last
climb stays lit until a new `BoardClimbSet` or a `BoardClimbCleared`.

### `BoardPresenceClimb`

| Field                                                 | Meaning                                                                                                                            |
| ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `climbUuid: String!`                                  | The climb.                                                                                                                         |
| `name`, `grade`, `gradeColor`, `setter`               | Display fields. Null when the key may not see the climb (for example someone else's draft).                                       |
| `frames: String`                                      | The holds. See below. Null when the key may not see the climb; there is nothing to draw, so treat it like a clear.               |
| `angle: Int`                                          | Board angle in degrees. Null means unknown; 0 is a real angle.                                                                     |
| `mirrored: Boolean`                                   | `true` when the climb was lit mirrored. Null means the sender did not say (older apps); treat it as not mirrored.                  |
| `queueItemUuid: String`                               | The queue entry that lit it, if any.                                                                                               |
| `source: String`                                      | `boardsesh` or `kilter`. Missing means `boardsesh`.                                                                                |
| `sentByUserId`, `sentByDisplayName`, `sentByAvatarUrl` | Who lit it. A key is not signed in, so these follow the sender's own privacy settings as seen by a signed-out viewer, and are often null. |
| `sentAt: String!`                                     | ISO 8601, server time.                                                                                                             |
| `seq: Int!`                                           | Ordering, as above.                                                                                                                |

### Decoding `frames`

A frames string is a list of `p<holdId>r<roleCode>` tokens with no separator, for
example `p1083r1p1121r2p1200r3p1370r4`.

- `holdId` is the board's placement id. On a spray wall it is the wall's hold id,
  the `id` in `sprayWallRenderData.holds`.
- `roleCode` says what the hold is for. The codes depend on the board type:

| Board                    | Start | Hand | Finish | Foot |
| ------------------------ | ----- | ---- | ------ | ---- |
| Spray wall               | 1     | 2    | 3      | 4    |
| Tension                  | 1, 5  | 2, 6 | 3, 7   | 4, 8 |
| Kilter (current boards)  | 42    | 43   | 44     | 45   |
| Kilter (older products)  | 12, 20, 24, 28, 32 | 13, 21, 25, 29, 33 | 14, 22, 26, 30, 34 | 15, 23, 27, 31, 35 |
| Kilter Tycho (colour only) | none | 36 to 41 | none | none |
| MoonBoard                | 42    | 43   | 44     | none |

  The full table, with the colours the apps use, is `HOLD_STATE_MAP` in
  `packages/board-constants/src/hold-states.ts`.

A spray climb is always one frame. A few Kilter and Tension catalogue climbs (about
0.1%) have several frames, separated by commas. A segment that starts with `"` is a
change to the previous frame, and `x<holdId>` turns a hold off. For a still picture,
light every hold that any frame lights, with the last frame's role winning. That is
what the apps and the ESP32 do (`toFlatFrames` in the same file).

### `mirrored`

Mirroring swaps each hold for its partner on the other side of the board. Only
Tension (all layouts except layout 11), Decoy and Woods boards mirror. Kilter,
MoonBoard and spray walls never do, so ignore `mirrored` for them. On a
board that mirrors, replace every `holdId` with that hold's `mirroredHoldId` from the
board's hold data in `@boardsesh/board-constants` before you look up coordinates.
The `frames` string itself is always the unmirrored climb.

### What arrives when you subscribe

The subscription does not replay the climb that is already on the wall. Right after
it subscribes, the server sends one thing: a `BoardClimbCleared`, if the wall was
cleared and nothing has been lit since. After that you get live events only.

To show the current climb straight away, read the recent history with
`boardRecentClimbs(boardId, boardUuid)`, using the same arguments and the same key as
the subscription. It returns the last 50 climbs from the past week, newest first; the
newest one is on the wall unless a later `BoardClimbCleared` says otherwise.
Subscribe first, then fetch, then apply both in `seq` order, so a climb set in
between is not lost. The climbers' names in it follow the same signed-out rule as the
live events.

### When the feed ends

- A `Board not found` error (code `NOT_FOUND`) means the key may not read this board,
  or it does not exist. Check the `boardId` against `controllerBoards`; the board may
  have been deleted. The socket itself may also be signed out (section 2), so connect
  again before you decide.
- The server can also end the stream without an error (`complete`). That happens when
  the key loses access while subscribed, for example the wall changed owner, or it is
  a gym's wall and the key's owner left the gym. Do not reconnect in a tight loop. Wait, then try again
  with backoff.

The example in section 2 retries after both. With nothing left to listen to, `graphql-ws`
closes the socket, so the retry opens a new one and the key is checked again. If your
client keeps its socket open, close it yourself first.

## 5. Hold coordinates

### Spray walls

```graphql
query RenderData($uuid: ID!) {
  sprayWallRenderData(uuid: $uuid) {
    versionNumber
    boardWidth
    boardHeight
    homography
    holds { id cx cy r outline }
    photo { url width height expiresAt }
  }
}
```

- Omit `version` to get the published version. A key only ever sees published
  versions. A wall that has never been published (the owner is still marking holds)
  returns `null`; so does a deleted wall.
- A wall a moderator has hidden stays readable by its owner's key, like it does for
  the owner. It disappears for everybody else.
- `holds` are the holds on the wall at that version. `cx`, `cy` and `r` are in the
  wall's **canonical frame**: a rectangle `boardWidth` x `boardHeight` that version 1
  of the wall defines from its photo, origin top left, y down. There are no real-world
  units. To project onto the wall, map the canonical frame's four corners to the
  wall's four corners in your projector's space (one homography you calibrate once).
- `outline`, when present, is the hold's shape: a closed ring `[x0, y0, x1, y1, ...]`
  in units of the hold's own radius, relative to its centre. Null means a circle.
- `homography` is a row-major 3x3 matrix (nine numbers) from the photo's pixels to the
  canonical frame. You need it only if you draw on top of `photo`. Draw holds by
  mapping canonical points through its inverse.
- `photo.url` is a signed link that expires at `photo.expiresAt`. Never store it.

Cache the hold list per wall uuid and `versionNumber`. When the owner edits holds, a
new version is published and `sprayWall(uuid) { currentVersion { number } }` changes;
re-fetch then. A climb's hold ids stay valid across versions, but a hold removed in a
later version is no longer in `holds`. Skip ids you cannot find.

### Kilter, Tension and MoonBoard

The ESP32 controller fetches a small binary geometry file:

```
GET https://ws.boardsesh.com/render/controller-preview
    ?board_name=kilter|tension|moonboard
    &layout_id=<layoutId>&size_id=<sizeId>&set_ids=<comma-separated, at most 16>
    &kind=geometry
```

No key is needed. `kind=image` returns the matching board picture as a JPEG. The
response has an `ETag` holding the file's SHA-256. Add `&v=<that hash>` and the
response is cacheable forever; the server answers `409` if the file changed.

The file (`BSGM`, version 1) is little-endian:

| Offset          | Size | Field                               |
| --------------- | ---- | ----------------------------------- |
| 0               | 4    | ASCII `BSGM`                        |
| 4               | 2    | format version, `1`                 |
| 6               | 2    | `count`, number of positions        |
| 8               | 2    | image width in pixels               |
| 10              | 2    | image height in pixels              |
| 12 + 8*i        | 2    | LED position                        |
| 12 + 8*i + 2    | 2    | x, pixels from the left             |
| 12 + 8*i + 4    | 2    | y, pixels from the top              |
| 12 + 8*i + 6    | 2    | radius, pixels                      |

Entries are sorted by LED position. Two limits matter for a projector:

- The pixel space is small: the long side is at most 330 px. Fine for a target on a
  wall, coarse for precise spot placement.
- Entries are keyed by **LED position**, the order of LEDs on the board's strip, not
  by the hold id in `frames`. Map hold ids to LED positions with the board's
  placement table: `getLedPlacements(board, layoutId, sizeId)` in
  `packages/board-constants/src/led-placements.ts` for Kilter and Tension, and
  `getMoonboardSerialPosition(holdId, numRows)` in
  `packages/shared/ble-protocol/src/moonboard.ts` for MoonBoard. The repository is
  Apache-2.0 licensed. `getBoardDetails` in
  `packages/shared/board-render/src/board-details.ts` gives each hold's position in
  the full-size board image (`holdsData`: `id`, `mirroredHoldId`, `cx`, `cy`, `r`),
  which is higher resolution and keyed by hold id directly.

Cache geometry per `(board_name, layout_id, size_id, set_ids)`.

## 6. Staying connected

- **Reconnect with backoff.** Networks drop. Retry forever, starting near 1 second and
  doubling to about a minute, with jitter. The example above does this, and `graphql-ws`
  resubscribes on its own after a reconnect. A client that does not has to subscribe
  again. Either way, repeat the history fetch from section 4.
- **Keepalive.** The server pings every socket every 30 seconds and drops one that
  misses a pong. Node's `ws` answers pings for you.
- **Rate limits.** A key is not signed in, so its limits are counted per public IP
  address and shared with every other signed-out client behind that address:
  - subscribing to `boardNowPlaying`: 60 per minute;
  - `controllerBoards`, `sprayWall`, `sprayWallRenderData`: 60 per minute each;
  - `boardRecentClimbs`: 60 per minute;
  - `/render/controller-preview`: 60 per minute.

  Over the limit, the server answers with code `RATE_LIMITED` and
  `extensions.retryAfterSeconds`. Wait that long. One long-lived subscription per board
  is the intended use; do not resubscribe on a timer.
- **Polling is a fallback only.** If the socket cannot stay up, polling
  `boardRecentClimbs` every 10 to 30 seconds works, but it is slower and counts against
  the same limits.
- **Queries per message.** The server rejects documents nested deeper than 10 levels.
  The documents in this guide are well within that.

## Related

- `docs/websocket-implementation.md`, "Board Presence Wall Feed": how the feed works
  on the server and in the apps.
- `docs/board-connection-holder.md`: the holder and the clear-replay rules.
- `docs/spray-walls.md`: spray walls, the canonical frame and wall versions.
- `docs/embedded-architecture.md`: the ESP32 controller, which uses the same key on a
  different feed (`controllerEvents`).
