# Mobile logbook

The profile logbook is `packages/mobile/src/components/you/LogbookTab.tsx`.
`LogbookView`, rows, day dividers, chip/facet controls, the filter sheet, and the
edit/entry-chooser sheets live beside it. Pure filtering, grouping, row building,
and sort semantics live in `@boardsesh/logbook`.

Search and filters cover board/layout, name, grade, result status, dates, angle,
quality, and setters according to the current GraphQL inputs. Grouped and ordinary
feeds use the same filter semantics. Pagination remains bounded and virtualized;
account-scoped offline behavior follows [offline reads](../../data/offline-reads.md).

## Logging and editing

`packages/mobile/src/components/LogAscentSheet.tsx` hosts the tick form. Its
save/update/delete behavior is shared through `@boardsesh/board-react` with
platform I/O injected. A zero-degree angle is valid; nullable grade/quality and
send/attempt rules follow [ascents and attempts](../../data/ascents-and-attempts.md).
Do not restore the old web form's window confirmation or MUI field assumptions.

Tick logging from Queue History presents a child form without losing the Queue's
detent or scroll position; see [climb view options](../../product/climb-view-options.md).
User-initiated export is a separate settings task documented in
[data exports](../../product/user-data-exports.md).

## Data operations

- `ticks` / `userTicks` -- User's tick/ascent data (used by `BoardProvider`).
- `userAscentsFeed` / `GET_USER_ASCENTS_FEED` -- Paginated ascent feed with filters (board, grade range, status, date range, angle range, minimum stars, setters, sort). `minQuality` (1-5) compares the stars the row shows (`effectiveQuality`: the tick's own, else the climber's synced rating); `setterUsernames` takes exact usernames, up to 20. `userGroupedAscentsFeed` takes the same filters.
- `userLoggedSetters` / `GET_USER_LOGGED_SETTERS` -- Setters of the climbs in a user's logbook, most-logged first (`setterUsername`, `tickCount`), for the setter filter. Scoped by `boardTypes` / `layoutIds`, optional case-insensitive `search`, `limit` 1-200 (default 50). Same visibility as the feed, and each `tickCount` equals the feed's `totalCount` for that setter. Public.
- `saveTick` -- Creates a new tick/ascent.
- `updateTick` / `useUpdateTick` -- Updates an existing tick (quality, grade, attempts, comment).
- `deleteTick` / `DELETE_TICK` -- Deletes a tick.
- `attachBetaLink` -- Attaches a beta video URL to a tick.
- `followingClimbAscents` / `GET_FOLLOWING_CLIMB_ASCENTS` -- The 100 newest logs from followed users on a specific climb, plus `hasMore` and a `summary` of climber and sender counts (overall and per angle) that covers all of them. Signed-in only, 120 requests a minute.
- `climbLogs` / `GET_CLIMB_LOGS` -- Everyone's logs on a specific climb, newest first, 1 to 50 per page with a keyset cursor. Optional filters: angle, notes only, sends only, one row per climber, and (signed in) leaving out your own logs and the people you follow. Public, 60 requests a minute.
