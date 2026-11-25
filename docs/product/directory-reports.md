# Report a problem: board and gym reports

Any signed-in climber can report a problem with a board or a gym listing. The report goes to whoever can fix it: the board's creator, the gym's staff when the gym is run by the gym, or the Boardsesh admin queue. This doc covers the backend (the data, the routing, the API, the notifications, the hourly sweep, the admin's daily digest and the server flag that keeps it all dark until the apps can show it) and, under "On www", the website's entry points, staff review and admin queue.

The product decisions behind it are in [gym-board-governance.md](gym-board-governance.md), decision 2. Climb reports are a different system: [climb-moderation.md](climb-moderation.md).

Epic #8043. Built in PR 3 of 8; the mobile report and review sheets (PR 4), the web dialog, staff queue and admin queue (PR 5) and the claim notices (PR 6) build on it.

## What can be reported

| Target | Reasons (id → what the climber picks) |
|---|---|
| Board | `wrong_setup` set up wrong · `duplicate` listed twice · `gone` not on the wall anymore · `wrong_place` wrong gym or place · `other` something else |
| Board, creator only | `relist_request`: put my board back on the gym whose staff took it off |
| Gym | `duplicate` listed twice · `closed` closed for good · `wrong_details` wrong address or details · `not_a_gym` it's someone's home · `other` something else |

The ids are the database enum values, the GraphQL enum values and the `@boardsesh/directory-moderation` ids alike.

A note is optional, trimmed, and at most 500 characters. `other` needs a note of at least 10 characters. A "listed twice" report may name the other board (`duplicateOfBoardUuid`) or gym (`duplicateOfGymUuid`); the first reporter who names one sets it, and the board merge tool prefills its target from it.

## Routing

`routeBoardReport` and `routeGymReport` in `packages/shared/directory-moderation/src/routing.ts` are the one implementation. The backend routes with them and the apps word the sheet's "who will see this" line with them (`pickReportAudience`), so the sheet never promises a reader the server won't reach.

| Board | Gym | Goes to |
|---|---|---|
| Added by a climber | none, not claimed, or climber-listed | the creator |
| Added by a climber | run by the gym | the creator and the gym's staff |
| Synced (SYSTEM) | run by the gym | the gym's staff |
| Synced (SYSTEM) | none, not claimed, or climber-listed | the admin queue, at once |
| Any, reason `wrong_place` | any | as above, plus the admin queue at once |

- "Gym staff" is the gym's owner and its `admin` members. The climber who owns a climber-listed gym is not staff: they listed the place, they don't run it.
- A report never goes back to the person who filed it. When that leaves nobody (a creator reporting their own board at an unclaimed gym, a gym whose only admin is the reporter), it goes to the admin queue at once.
- `relist_request` goes to the staff of the gym in the board's latest staff removal (any gym with a real owner; whoever removed it can put it back), or to the admin queue for an unclaimed gym. Never to the creator.
- Gym reports: `wrong_details` goes to the staff of a gym run by the gym; everything else, and `wrong_details` on any other gym, to the admin queue.

`routed_to` is decided once, when the report opens. It is what the reporter was told, so it does not move when the gym is claimed later.

## Data

Migration 0334 (`packages/db/src/schema/app/directory-reports.ts`):

- `directory_reports`: one problem with one target. `target_kind` is `board` or `gym`; a check holds exactly one of `board_id` / `gym_id`, the one the kind names. A board report keeps `gym_id_at_report` (the gym it was at, or for `relist_request` the gym that removed it), because a removal clears the board's own link. `status` is `open`, `escalated` (in the admin queue), or an outcome: `fixed`, `removed`, `deleted`, `kept`, `merged`. A second check holds `resolved_at` set exactly when the status is an outcome. `resolved_by_role` is `creator`, `gym_staff`, `admin`, `auto` (the system) or `climber` (a climber's suggested setup changed the board). Two partial unique indexes allow one waiting (`open` or `escalated`) report per (board, reason) and per (gym, reason).
- `directory_report_reporters`: who reported, with their note and, since migration 0341, the setup they suggest (`suggested_setup`). Unique per (report, reporter) while the reporter's account exists; an account deletion nulls `reporter_id` and leaves the report.
- `directory_notification_context`: what a notification of this feature is about, keyed by the notification's uuid (report, board, gym, reminder flag, the staff role that acted). A side table, because `notifications` is large and hot; `app_feedback_messages.notification_uuid` is the same shape.
- `admin_daily_digests`: one row per UTC day the digest ran (`sending`, then `sent` or `empty`), with the window it covered.

Reports are never deleted by the app. A board's go with the board row (an account deletion removes its boards), a gym's with the gym row.

## Filing a report

`reportBoard` / `reportGym` (`packages/backend/src/graphql/resolvers/social/directory-reports/submit.ts`) copy `reportClimb`'s join semantics:

1. Signed in, the `directory-reports` flag on, 5 per minute.
2. The reporter must be able to read the target: the board by its uuid (`canAccessBoard` with the uuid as the link), the gym by the gym visibility rule. Anything else is "not found", so a report is never an oracle for which uuids exist.
3. In the filing transaction the board is read again under a share lock (`lockBoardFacts`); a report whose suggested setup may change the board takes it `FOR NO KEY UPDATE` instead (see "Suggested setup"). A delete or merge that committed since the checks makes it "not found"; a removal or move to another gym routes the report again against the board as it stands, so `gym_id_at_report` and `routed_to` never name a gym the board just left. The next delete or removal waits for the report to commit.
4. A climber whose report on the same target and reason closed less than 7 days ago (`REPORT_REFILE_COOLDOWN_DAYS`) can't open it again: they get `already_reported` with that closed report, and nothing is written (a suggested setup is not stored either, and `setupOutcome` is null). Every new report notifies and pushes its people, so this stops a reporter who disagrees with an outcome from pushing the creator over and over. A report someone else opened since is joined as usual. Two exceptions, both for "Set up wrong", where the setup the report closed over may not be the one on the wall: a report a climber's suggested setup closed (resolver role `climber`) holds nobody back, the climber who made the change included, and the board's 24 hours send a repeat suggestion to review (`RECENT_CHANGE`); and a report closed before a climber's setup change to the board was undone does not hold its reporters back (see "Undo").
5. `INSERT ... ON CONFLICT DO NOTHING` on the partial unique index. The first reporter gets `created`; a later reporter on the same target and reason joins the waiting report (`added`); a second report from the same climber writes nothing (`already_reported`) beyond replacing their suggested setup when it carries one (see "Suggested setup"). `otherReporterCount` feeds "2 other climbers flagged this too".
6. On `created`, the people it reaches get one `board_report_opened` / `gym_report_opened` notice each. Later reporters join quietly. A report routed to the admin queue is `escalated` from the start.

`reportGymDuplicate`, the older email-only path, also files a `duplicate` gym report, so reports from app builds before PR 4 reach the admin queue. Its email still goes out; the report is best effort, and is not gated on the flag (it reaches the admin queue only, and sends no notice while the flag is off).

## Who sees a report

| Viewer | Reads | Closes |
|---|---|---|
| The board's creator | every report on their board, but their own relist requests | as `kept`, unless it is in the admin queue |
| Gym owner, admin | reports routed to `gym_staff` for their gym | as `kept`, unless it is in the admin queue |
| Gym editor | reports routed to `gym_staff` for their gym | no |
| Global admin | everything | with any outcome |

- **A report in the admin queue is the team's to close.** One routed to the admin queue when it opened (a synced board nobody runs, "wrong gym or place", which can be a home address) or escalated after 14 days is closed by a global admin only (`isInAdminQueue`). The creator and staff still read it, with `viewerCanResolve: false`; `resolveDirectoryReport` tells them "The Boardsesh team is looking at this report; it closes when they do."
- **Reporters are anonymous** to the creator and staff: they read the reasons, the notes and a count, never names. `DirectoryReportNote.reporter` is null for everyone but global admins. Reporters read nothing back except the outcome notice and `UserBoard.viewerHasOpenReport`.
- A board report also needs the board to be readable by the viewer: staff don't learn about a private board through its reports.
- Closed reports stay in `boardReports` and `myDirectoryReportsToReview` for 30 days.

## API

SDL: `packages/shared-schema/src/schema/directory-reports.ts`. Operation documents for the apps: `packages/shared/graphql/src/operations/directory-reports.ts`. The app selects them, `BOARD_FIELDS` carries `openReportCount` and `viewerHasOpenReport`, and the grouped notification feed carries `directoryNotice` (PR 4); www selects them too (see "On www"). Either client ships only once this backend is live: an unknown field fails the whole query.

| Operation | Who | What |
|---|---|---|
| `reportBoard(input: { boardUuid, reason, duplicateOfBoardUuid?, note? })` | signed in, can read the board, flag on | `{ status: created \| added \| already_reported, reportUuid, routedTo, otherReporterCount }` |
| `reportGym(input: { gymUuid, reason, duplicateOfGymUuid?, note? })` | signed in, can see the gym, flag on | same |
| `resolveDirectoryReport(input: { reportUuid, outcome, note? })` | creator or gym owner/admin: `kept`, on a report not in the admin queue; global admin: any outcome | the closed `DirectoryReport` |
| `boardReports(boardUuid)` | creator, routed gym staff, global admins; `[]` for anyone else | waiting and recently closed reports, newest first |
| `myDirectoryReportsToReview(includeResolved, first)` | signed in | reports on my boards and routed to gyms I staff: waiting first (oldest first), then closed (newest first) |
| `adminDirectoryReports(status, targetKind, first, after)` | global admins | the admin queue; `status` defaults to `escalated` |
| `reportBoard(input: { …, suggestedSetup? })` | as above | also `setupOutcome`, `setupReviewReason` and, when applied, `board` (see "Suggested setup"). `board` can be null on `APPLIED`: the change committed but the board couldn't be read back (logged); refetch it by uuid |
| `undoBoardSetupChange(eventId)` | global admins, the creator (not SYSTEM), the gym's owner and admins | the board with its old setup back; `BOARD_SETUP_ALREADY_UNDONE` or `BOARD_SETUP_CHANGED_SINCE` when it can't be |
| `adminBoardSetupChanges(first, after)` | global admins | climbers' setup changes, newest first |
| `UserBoard.openReportCount` | | waiting reports the viewer can act on; null unless they are the creator, staff of the board's gym or of a report's gym, or a global admin |
| `UserBoard.viewerHasOpenReport` | | the viewer is a reporter on a waiting report; null signed out |
| `Notification.directoryNotice`, `GroupedNotification.directoryNotice` | | what a directory notification is about (below) |

`openReportCount` and `viewerHasOpenReport` are computed in `enrichBoard` / `enrichBoards` with two reads for the whole list (`loadBoardReportFlags`), never a query per row.

An admin closing a report as `removed` or `deleted` must have done it first with the existing mutations (`detachBoardFromGym`, `deleteBoard`, `updateGym isListed: false`, `deleteGym`); the mutation checks the board or gym. `fixed` and `merged` are not checked.

## Suggested setup

"Set up wrong" on a board that isn't a spray wall can carry the setup the climber says is right: the layout, the size, the hold sets and, on a board that doesn't tilt, the angle. All within the board's own type: a wrong board type stays "Listed twice" or "Something else". A spray wall keeps the note field; it has no layout to pick. The founder's decisions behind it (2026-11-23) are in [gym-board-governance.md](gym-board-governance.md#suggested-setups-2026-11-23).

| Board is at… | After Send | "Climb it now"? |
|---|---|---|
| A gym nobody runs (`UNCLAIMED` or `CLIMBER_LISTED`), no limit hit | The board changes for everyone. Its waiting "Set up wrong" reports close as `fixed`. The creator and the gym's owner and admins are told, with a push, and can undo. | Yes |
| A gym run by the gym (`RUN_BY_GYM`) | The suggestion waits on the report for the gym's staff, who get **Use this setup** | No: the "fixed" notice opens the board |
| No gym, or any limit hit | The suggestion waits on the report, routed as any report: the creator, then the admin queue after 14 days | No: the "fixed" notice opens the board |

The rule is `setupSuggestionDecision` in `packages/shared/directory-moderation/src/setup-suggestion.ts`, and the backend decides with it. The clients word the line above Send with `setupSuggestionPreview`, the gym half of the same rule ("This changes it for everyone at {gym}. It can be undone.", "{gym} staff check it first.", or the creator checks it; the app's wording differs slightly), and show the setup fields only where `isSetupSuggestionAllowed(reason, boardType)` holds. A limit can still send a suggestion the line promised would apply to review; the result says which (`setupOutcome`, `setupReviewReason`).

The fields hold their state in `@boardsesh/board-config`'s `setupSelection` (`packages/shared/board-config/src/setup-selection.ts`): the board builder's reset rules (a new layout picks its default size and every set of it, a new size picks every set of it), the options for each row over the catalogue cascade and `getBoardAngleOptions`, `isSetupChanged` (Send works once the setup differs) and `toSuggestedSetup`, which writes the sets in `normaliseSetIds` order. `initialSetupSelection` keeps only the sets the catalogue lists for the board's layout and size, so every selected set is one the Holds row shows and can untick; `isSetupChanged` leaves an unlisted set out of the board's side too, so a board carrying one opens unchanged. The words for each option and a one-line summary of a setup come from `setup-labels.ts` (`boardSetupSummary`, "Original · 12×14 · Commercial · Bolt Ons · 40°"), never raw ids.

### Limits

Once the gym allows a change, these send it to review instead, checked in this order; the first one hit is the reason:

| Reason | When |
|---|---|
| `RECENTLY_UNDONE` | A climber change to this board was undone in the last 90 days (`SETUP_CHANGE_REVIEW_DAYS_AFTER_UNDO`), or the board's latest climber change, made in the last 90 days, is no longer on the board: someone edited it back by hand, which counts as an undo from the time the change was made (`lastClimberChangeOverriddenAt`) |
| `RECENT_CHANGE` | A climber changed this board in the last 24 hours (`SETUP_CHANGE_BOARD_COOLDOWN_HOURS`) |
| `DAILY_LIMIT` | This climber made 3 changes, on any boards, in the last 24 hours (`SETUP_CHANGES_PER_CLIMBER_PER_DAY`, a rolling window) |
| `CLASHES` | Backend only: the new setup would make the board a copy of another board with the same owner (`findOwnedBlockingDuplicate`), or clash with a serial number (`lockAndAssertBoardSerialAvailable`) |

The gym reasons are `CLAIMED_GYM` (run by the gym) and `NO_GYM`. A gym whose listing state isn't known counts as no gym. The listing state is the one `Gym.listingState` shows (`loadGymFacts`, over `gymListingState`). The windows are read from `board_moderation_events`; the per-climber count is served by `board_moderation_events_actor_created_idx` (`actor_user_id, created_at`, plain, not partial on the action: Postgres refuses an enum value in the transaction that added it).

Locks. Before the filing transaction, a cheap pre-check (`suggestionMayChangeBoard`) asks whether the suggestion may change the board at all: the flag is on and the board's gym is live and not `RUN_BY_GYM`. Only then does the transaction take the board row `FOR NO KEY UPDATE` (which changes no key, so a tick or event that only references the board doesn't wait on it); otherwise it takes the usual share lock. Under the stronger lock the reporter must still be able to read the board (`canAccessResource`, the creator exempt), as `updateBoard` asks of an editor; a board that turned private meanwhile is "not found". The gym and the limits are then read again under the lock and decide. Of two suggestions on one board queued on the lock, the first applies and the second reads its change and goes to review as `RECENT_CHANGE`. When the pre-check was stale (the gym changed hands between it and the lock) and the decision says apply under a share lock, the transaction rolls back and files again with the stronger lock (`SuggestionNeedsChangeLock`), rather than upgrading the lock, which could deadlock with another filer. The per-climber count takes no lock: one climber's suggestions on several boards at the same moment can pass it by one or two, as the report push cap can.

`CLASHES` is checked after the rule says apply and before anything is written. Both checks only read (the serial check also takes the serial's advisory lock, as `updateBoard` does), so a clash leaves the filing transaction intact and the report waits as any other.

There is no account-age gate: it would block the climber standing at the wall. The limits and undo cover abuse instead.

### Refused, never sent to review

`reportBoard` refuses these with `BAD_USER_INPUT`, and files nothing:

- a suggestion with a reason other than `wrong_setup`, or on a spray wall;
- an unknown layout, size or sets for the board's type (`assertKnownBoardConfig`), or an angle the board's type doesn't support (`isBoardAngleSupported`);
- an angle other than the board's own that no Angle row offers for its type (`isOfferedSetupAngle` in `@boardsesh/board-config`: `getBoardAngleOptions` with the `moonboard-wide-angles` flag off or on, since the server can't see the viewer's flag). Stricter than the write contracts' "any routable angle". The board's own angle always passes, so a climber who only changed the layout of a board sitting at an odd angle (42°) isn't refused;
- the setup the board has now (sets compared in `normaliseSetIds` order; the angle only on a board that doesn't tilt), with `extensions.reason: SETUP_UNCHANGED` so a client can tell it from an invalid setup (`isBoardSetupUnchangedError` in `@boardsesh/graphql/errors`). It usually means the page was read before someone else fixed the board: read it again and say it may already be fixed. This is checked again under the board's row lock, so a suggestion of the setup another climber's change just gave the board is refused too.

On a board that tilts the angle is not part of the setup: an angle sent with it is checked, then dropped, and the suggestion is stored with `angle: null`. On a board that doesn't tilt, leaving the angle out keeps the board's angle.

### What a change writes

In the filing transaction:

1. The board's `layout_id`, `size_id`, `set_ids` and, on a board that doesn't tilt, `angle`, with `updated_at` and `sync_frozen_at`. The freeze is the one staff edits set, so the location sync can't put the old setup back.
2. `onBoardEdited` with the actor role `climber` (`board_owner` when the creator suggested a setup on their own board). The board's waiting `wrong_setup` reports close as `fixed` with resolver role `climber` (`creator` for the creator) and `resolved_by` the climber, the one just filed included. Their reporters hear `board_report_resolved`, except the climber who made the change. A report the change opened and closed at once sends no `board_report_opened`: the people who can undo it hear about the change instead.
3. A `board_moderation_events` row: `setup_changed_by_climber`, actor role `climber` (or `board_owner`), `details` `{ before, after, reportUuid, syncFrozenAtBefore, syncFrozenAtSet }`. `after` is the setup the board is left with, so on a board that doesn't tilt it carries the angle even when the suggestion left it out. `syncFrozenAtBefore` is the board's freeze before the change (ISO, or null for none) and `syncFrozenAtSet` the freeze the change set, so an undo can put the first back.
4. `board_setup_changed_by_climber` to everyone who can undo it: the creator, unless the board is synced (SYSTEM), and the owner and admins of the board's gym (`gymManagerIds`, the set `viewerGymManagerRole` admits minus the SYSTEM import account; editors may not undo, so they aren't told). Each once, never the climber who made the change, and only those who can read the board. Every recipient passes the undo rule at the moment it is sent, so the app can offer Undo on every such notice; the rule is checked again when they tap it (the board may have moved gyms since). It also goes out as a push (below). Its context row's `board_moderation_event_id` points at the event, so `directoryNotice` carries `setupChangeEventId`, `setupBefore`, `setupAfter` and `setupChangeState` for the notice's Undo. The app words it "A climber changed the setup of your board {{board}}" for the creator (`items.boardSetupChangedByClimber`) and "A climber changed the setup of {{board}} at {{gym}}" for the gym's staff (`items.boardSetupChangedByClimberAtGym`, `recipientIsCreator: false`), and opens the board's detail sheet.

Everyone else who has the board active picks up the new setup the next time the app opens or comes to the foreground: `use-active-board-self-heal.ts` reverts the stored config to the server's, the angle excepted. `reportBoard` returns the changed `board` for Climb it now.

A suggestion that goes to review is kept on the reporter's row (`directory_report_reporters.suggested_setup`) and shown to the people the report reached as `DirectoryReportNote.suggestedSetup`. Reporters stay anonymous, as for notes. A note row with only a suggestion has an empty `note`. Staff's **Use this setup** sends the existing `updateBoard`, which closes the report as `fixed`. Both clients read the suggestions through `@boardsesh/directory-moderation`'s `suggested-setups.ts`: `groupSuggestedSetups(notes)` (one group per equal setup, the most suggested first, a tie to the one suggested most recently), `setupKey`, `setupMatches(setup, board)` (to leave out a setup the board already has) and `suggestedSetupUpdateInput(boardUuid, setup)` (the `updateBoard` input, with `allowDuplicateConfig` on request).

A reporter already on the waiting report (`already_reported`) who sends a suggestion replaces the one on their row, and it is decided again. It only ever touches their own row and reaches nobody new (joining is quiet), and it lets a climber whose suggestion waited on a limit try again once the limit has passed, or one who reported before the setup fields existed add the setup.

The code: `setup-suggestion.ts` (the checks, the decision, the change), `setup-snapshot.ts` (snapshots and where a change stands), `setup-changes.ts` (undo and the admin list), all in `packages/backend/src/graphql/resolvers/social/directory-reports/`.

### Undo

`undoBoardSetupChange(eventId)` puts back the setup a climber's change replaced. Global admins, the board's creator (not for a synced board) and the owner and admins of the gym the board is at now (not the gym it was at when the climber changed it) may undo; staff must also be able to read the board. Gym staff here is `viewerGymManagerRole`, the gym authority behind board edits, so whoever may undo a change could have edited the setup back by hand; gym editors may do neither. Anyone else, the climber who made the change included, reads `NOT_FOUND`, so the call is no oracle for which changes exist. 20 a minute.

It is a compare-and-set under the board's row lock (`FOR NO KEY UPDATE`): the change must still be `LIVE`. A change someone already undid is refused with `BOARD_SETUP_ALREADY_UNDONE` (`isBoardSetupAlreadyUndoneError`; the old setup is back, so a client treats it as done), and one the board changed again since with `BOARD_SETUP_CHANGED_SINCE` (`isBoardSetupChangedSinceError`), both in `@boardsesh/graphql/errors`. Of two undos at once, one puts it back and the other reads `BOARD_SETUP_ALREADY_UNDONE`. It restores `before` (the angle only when `before` has one) and the sync freeze the change replaced (`syncFrozenAtBefore`, often none, so the location sync may update the board again), but only while the board still has the change's own freeze (`syncFrozenAtSet`): a freeze written since, by an edit that left the setup alone, stays, and so the board stays frozen. It writes `setup_change_undone` in the undoer's role (`board_owner`, `gym_owner`, `gym_admin` or `global_admin`; `details` `{ before, after, undoesEventId }`) and starts the board's 90 days of review. The report the change closed stays closed. Like any setup edit, the undo closes the board's waiting "Set up wrong" reports as `fixed`. The serial guard `updateBoard` runs still applies (`BOARD_SERIAL_EXISTS`); the owner-duplicate prompt does not, since this is the board's own earlier setup. The refile cooldown ("Filing a report", step 4) doesn't hold after an undo: a climber can suggest again straight away, and for 90 days that goes to review. Editing the setup back by hand instead of using Undo counts the same for the 90 days (`RECENTLY_UNDONE`).

A change's state, on the creator's notice and in the admin list: `UNDONE` once a `setup_change_undone` names it; otherwise `LIVE` while the board is live and still has the change's `after` (a later edit that puts it back makes it `LIVE` again); otherwise `CHANGED_SINCE`, which also covers a board deleted or merged since.

`adminBoardSetupChanges(first, after)` lists every change, newest first, for the admin's Setup changes by climbers tab: the board, its gym (null once that gym is deleted), before and after, the climber's name, when, and `state`. It pages by event id (`nextCursor` is the page's last id): ids follow the order the changes were made, since each takes its board's row lock first.

### In the app

The report sheet (`ReportDirectorySheet`, `packages/mobile/src/components/report-problem/`):

- **Fields.** "Set up wrong" shows `SetupSuggestionFields`: Layout, Size, Holds and, on a board that doesn't tilt, Angle. Each row is a label and a native menu (`AppMenu`), opening on the board's setup. Holds ticks the picked sets; a tap toggles one, and the last one can't be removed. Labels are `@boardsesh/board-config`'s setup labels (`setupLayoutLabel`, `setupSizeLabel`, `setupAngleLabel`), which www's fields use too and the board builder re-exports. A value the catalogue doesn't list reads "Choose". A board type the build doesn't know keeps the note field.
- **Send.** Works once the setup differs. A climber who leaves it as it is can still send with a note of at least 10 characters (the "Something else" minimum). Only a changed setup is sent as `suggestedSetup`.
- **The line under Send.** Once the setup differs, it reads `setupSuggestionPreview`: "Changes it for everyone at {gym}. It can be undone.", "{gym}'s staff check it first." or "Whoever added it checks it first." While the board's gym state is unknown (still loading, or its read failed) a changed setup shows no line, so it never says the creator checks a board that has a gym. An unchanged setup shows the usual "who will see this" line.
- **`APPLIED`.** The same sheet becomes "Setup updated" / "Everyone at {gym} now climbs {setup}." with **Climb it now**. The returned board goes into the board reads straight away, and into the active board when it is the one in use, so the climb list re-keys even if the climber taps Done. When `board` comes back null (the change committed but the server couldn't read the board back), the sheet reads it with `fetchBoardByUuid`: the line is worded from the setup that was sent, Climb it now spins until the board arrives, and a failed read keeps the line and drops the button. Climb it now waits for the sheet to slide away (`dismissManagedSheetAndWait`), then binds the board with `useActivateBoard` (`recognizesHeldBox: false`: a board picked from a report names no box the In range slot holds) and lands on Climbs. That bind is its only write. On a board that tilts, the climber's own angle stays (`boardKeepingLocalAngle`).
- **Already set up.** A refusal with `isBoardSetupUnchangedError` (someone fixed the board while the sheet was open) reads the board again, says "It's already set up that way." and offers Climb it now the same way. Any other refusal keeps the form and the error line.
- **`SENT_FOR_REVIEW`.** One line per `setupReviewReason`, e.g. `CLAIMED_GYM`: "Sent to {gym}'s staff. We'll tell you when it's fixed." No reason (the server flag is off) keeps the plain "Sent" line.
- **Opened from the builder.** The board builder's near-miss "Use it and fix its setup" (#8151, `docs/product/existing-wall-check.md`) opens the sheet through `useReportProblemHost().openReport(target, options)`. It opens with "Set up wrong" already picked (`initialReason`) and the climber's own setup in the fields (`initialSetup`), so Send is ready at once but still needs the tap. With the setup fields off, the setup goes into the note as "The wall is set up as: {setup}". The builder has already bound the board, so it passes `climbNowOffered: false` and leaves on `onClosed`. With `onClosed` set, the host passes `closeAfterDismissed`, so the sheet tells it it has closed only after it has fully slid away. `onClosed` also fires after the claim sheet the report handed over to closes, at once when signed out (login opens instead), and when the host goes away mid-handoff. A report opened this way counts as untouched until the climber changes its reason, note or setup.

The review sheet (`ReportReviewSheet`) groups the suggestions on the waiting "Set up wrong" reports by setup with `@boardsesh/directory-moderation`'s `groupSuggestedSetups`, most suggested first: "2 climbers suggested Original · 12×12 · Bolt Ons". A setup the board already has is left out (`setupMatches`). The five most suggested get a row each (`MAX_SUGGESTED_SETUPS_SHOWN`); any more are one line, "2 other setups suggested", so the sheet's scroll view never maps an unbounded list. **Use this setup**, for a viewer who can edit the board, sends `updateBoard` with `suggestedSetupUpdateInput`: the layout, size and sets, and the angle when the suggestion has one. A duplicate of the owner's other board asks the edit screen's question before saving with `allowDuplicateConfig`. While that save is in flight, a swipe can't close the sheet and every other answer (the other Use this setup buttons, "Edit it yourself", remove, delete and "It's right as it is") is disabled and refuses a tap, so a report never closes as kept while its setup changes. "Fix the setup" reads "Edit it yourself" only when Use this setup shows beside it.

The `board_setup_changed_by_climber` row (the board's creator and the gym's owner and admins get it, and its push opens the board's detail sheet) says what the board climbs now and offers **Undo** while `setupChangeState` is `LIVE`. Undo asks first, checks the row is still `LIVE` in the loaded inbox once the confirm closes, then writes the restored board where the app reads it. A double tap asks once and sends once. How a refusal reads:

- `BOARD_SETUP_CHANGED_SINCE`: "It changed again since. Open the board to check it." The row moves to `CHANGED_SINCE`.
- `BOARD_SETUP_ALREADY_UNDONE`: "Someone already put the old setup back." The row moves to `UNDONE` and the board is read again by uuid and written the way a successful undo writes it, the stored active board included. A failed read leaves the line as it is; the active board heals on the next foreground.
- `NOT_FOUND` (the board moved gyms or went private, or the viewer's role at the gym ended): "You can't undo this any more." Undo goes from the row.
- No connection, or any other failure: "Couldn't undo it. Try again when connected." Undo stays.

The inbox cache holds `CHANGED_SINCE` and `UNDONE`, so those lines survive a scroll. Who undid it and a refused Undo are the row's own state.

The "fixed after your report" notice opens the board's detail sheet. Its **Set active** binds the board and returns to Climbs, so it is that notice's Climb it now.

All of this is behind the app's copy of `directory-setup-suggestions` (`useDirectorySetupSuggestionsEnabled`, positive and fail-closed). Off, the sheet is the note field, and the review sheet and the notice show no suggestion actions. `Report Problem Sent` carries `hadSuggestion` and `setupOutcome`, and **Climb it now** sends `Board Setup Climbed Now` {boardType, gymListingState}.

### The `directory-setup-suggestions` flag

A server flag with the same rules as [`directory-reports`](#the-directory-reports-flag): one switch for the whole service, evaluated for the fixed id `system:directory-setup-suggestions`, cached 60 s, decided by `FEATURE_FLAG_OVERRIDES` when that names it, and off when PostHog can't answer. Turn it on with a plain 100% condition.

While it is off, a suggestion is still checked, stored and shown to the people who review the report, but it never changes a board: `setupOutcome` is `SENT_FOR_REVIEW` with no `setupReviewReason`. The app reads the same flag before it shows the setup fields, and www does the same. Turn it on once this backend is deployed and the app and www builds that show the fields are live. Turning it off leaves www list pages the CDN already cached offering the fields for up to a day; a suggestion sent from one goes to review.

The backend reads it in `services/directory-setup-suggestions-flag.ts`, on the same resolver as `directory-reports` (`createSystemServerFlag` in `services/system-server-flag.ts`). `reportBoard` awaits it before its transaction opens, and only for a report that carries a suggestion, so nothing keeps it warm at boot.

Backend events (see "Analytics"): `Board Setup Suggested` {outcome, reason, boardType, gymState} and `Board Setup Change Undone` {by}.

## Closing a report

Most reports close on their own, in the same transaction as the action that settles them (`directory-reports/lifecycle.ts`):

| Action | Closes | As |
|---|---|---|
| `updateBoard` (and the spray wall commits) that changes setup, name, place or angle | `wrong_setup` on the board | `fixed` |
| The board comes off a gym: staff `detachBoardFromGym`, a staff `updateSprayWall`, or the creator's own unlink | the board's reports filed at that gym (not relist requests; for the creator's own unlink, not reports in the admin queue either) | `removed` |
| `deleteBoard` / `deleteSprayWall`, by anyone | every report on the board | `deleted` |
| Staff put a removed board back (`attachBoardToGym`, a staff link) | `relist_request` for that gym | `fixed` |
| `updateGym` that changes the name, address, coordinates, website, phone or hours | `wrong_details` on that gym | `fixed` |
| The board merge tool (below) | every report on the merged board, and "listed twice" reports on the survivor that named it | `merged` |
| The hourly sweep finds the board or gym deleted or merged | every waiting report on it | `deleted` / `merged` |

The fixing fields are `name`, `layoutId`, `sizeId`, `setIds`, `angle`, `isAngleAdjustable`, `locationName`, `latitude`, `longitude` (`REPORT_FIXING_BOARD_FIELDS`). A timer-only edit (`TimersSettingsScreen` sends `{ boardUuid, timerName }`) changes none of them, so it closes nothing.

The gym fields are `name`, `address`, `latitude`, `longitude`, `website`, `contactPhone`, `hours` (`REPORT_FIXING_GYM_FIELDS`). The manage form posts every field on every save, so `updateGym` reads the gym under its row lock first and only a value that actually changed counts. Anyone who passes the gym edit gate closes it: the owner, admins and editors as `gym_staff`, a community or global admin as `admin`.

The removal, relink and staff-edit hooks run from `recordBoardModerationEvent` / `recordStaffBoardEdit` (`board-moderation-events.ts`), so every writer of a moderation event closes reports without a call of its own. The creator's own unlink (`linkBoardToGym` with no gym, an owner's `updateSprayWall`, an owner moving the board to another gym) closes them through the `board_owner` `removed_from_gym` event that `recordOwnerGymLinkChange` writes for every creator link change. It leaves reports in the admin queue open: taking a board off a gym does not move a home address. A staff removal is the gym's own call and closes those too. Deletes call `onBoardDeleted` at both delete sites, because a creator's own delete records no event. A staff edit resolves the staff member's role before any report closes, so an edit refused because the role was revoked closes nothing.

Every close tells the reporters (`board_report_resolved` / `gym_report_resolved`) and is counted (`Board Report Resolved`).

### Board merge tool hand-off

The board merge tool is built separately. When it folds board A into board B, it calls, in its own transaction:

```ts
// packages/backend/src/graphql/resolvers/social/directory-reports/index.ts
import { resolveReportsForMergedBoard } from '../social/directory-reports';
import { transactionWithAfterCommit } from '../../../db/after-commit';
await transactionWithAfterCommit(async (tx) => {
  // ...fold the board...
  await resolveReportsForMergedBoard(mergedBoardId, survivorBoardId, tx);
});
```

Open the transaction with `transactionWithAfterCommit`, not `db.transaction`: the closes are counted once it commits (see Analytics).

It returns how many reports closed. A "listed twice" report carries `duplicate_of_board_id`, which the tool can use to prefill its target; `DirectoryReport.duplicateOfBoardUuid` exposes it. Until the tool calls the hook, the sweep closes reports on a merged board (`user_boards.merged_into_board_uuid` set) within the hour.

## Notifications

All in-app; `board_report_opened` and `board_setup_changed_by_climber` also go out as a push (opt-in: only devices registered with `registerNotificationDevice`). The push rides the shared delivery worker (`notification-push-delivery`, the branch in `services/spray-detection-notifications.ts`), which rechecks before every attempt that the flag is on (awaiting PostHog when its cached answer is stale, so a cold cache never skips a delivery for good) and that the recipient can still read the board, and also, for a report, that it is still waiting (`directoryReportPushTarget`) and, for a setup change, that the change is still `LIVE` (`directorySetupChangePushTarget`): once it is undone or the board changed again, there is nothing to undo and the push is skipped. The setup change push reads "A climber changed the setup of {{board}}" / "Check the new setup, and undo it if it's wrong." (`push.boardSetupChanged*`) and carries `{ type: 'board_setup_changed_by_climber', boardUuid, setupChangeEventId }`, which the app opens on the board's detail sheet.

At most 10 directory pushes reach one person in 24 hours (`DIRECTORY_REPORT_PUSHES_PER_DAY`, counting `board_report_opened` and `board_setup_changed_by_climber` notices that were queued to a device, reminders included). Past that the notice still lands in the inbox, without a push. Two reports filed at the same moment can both see one below the cap, so it can be passed by one or two.

| Type | To | When |
|---|---|---|
| `board_report_opened` | creator, gym staff | a board report opens, and once more at 7 days (`isReminder`) |
| `gym_report_opened` | gym staff | a `wrong_details` report on a gym run by the gym opens, and at 7 days |
| `board_report_resolved` | reporters | a board report closes (outcome, resolver role, and for `kept` the note) |
| `gym_report_resolved` | reporters | a gym report closes |
| `board_removed_from_gym` | creator | someone else takes their board off a gym |
| `board_deleted_by_staff` | creator | someone else deletes their board |
| `board_edited_by_staff` | creator | someone else changes their board |
| `gym_claimed_with_your_board` | creators with a board at the gym | the gym is claimed (entity: the gym; names their oldest board there) |
| `gym_claim_denied` | the claimant | their claim is denied, expires or is reverted (entity: the gym) |
| `board_setup_changed_by_climber` | creator (not SYSTEM), the gym's owner and admins | a climber's suggested setup changed the board (see "Suggested setup"); also a push |

The two claim notices are described in [gym-claims.md](gym-claims.md).

Rules every notice follows (`directory-reports/notices.ts`):

- **No actor.** The feed names a notification's actor, and for a report that is the reporter. Who acted is carried as a role instead (`directoryNotice.actorRole`: `gym_staff` or `moderator`; `resolvedByRole`).
- **Only while the flag is on.**
- **Never about a board the recipient cannot read.** The creator always can. About a board that is deleted when the notice is written, only its creator and the reporters on the notice's report hear; gym staff and anyone else do not. The inbox applies the same rule at read time (`notificationPrivacyCondition`), with one addition: a notice about a board or gym deleted since keeps showing to the people it went to, who could read it when it was sent.
- **Written in the action's transaction**, so a change that rolls back sends nothing. The live feed publish waits for the commit (it publishes the rows visible after 200 ms, then 2 s); a notice missed there shows on the next feed read.

`directoryNotice` carries what a client needs to word the row: `targetKind`, board uuid, name and type, gym uuid and name, report uuid, `reason`, `outcome`, `resolvedByRole`, `resolutionNote` (kept only), `actorRole`, `isReminder`, `recipientIsCreator`. The copy keys are in `packages/shared/i18n/locales/*/notifications.json` (`items.boardReported*`, `items.boardReport*`, `items.board*ByStaff` / `*ByModerator`, `items.gymReport*`, and `push.boardReport*` / `push.boardRelist*`); the backend reads only the push copy.

## In the app

PR 4 of #8043. Everything below is behind the app's copy of the `directory-reports` flag (`useDirectoryReportsEnabled`, positive and fail-closed: off, missing or unresolved shows none of it), the same PostHog flag the backend reads. Code: `packages/mobile/src/components/report-problem/`.

**Report a problem** (`ReportDirectorySheet` on the shared `ReportProblemSheet`, which the Spraywall report also uses now). Cancel / "Report a problem" / ✓ Send; the reasons in the native `RadioGroup`; under the chosen reason a note (required, 10 characters, for "Something else") and, for "Listed twice" on a board at a gym, "Which board is the same wall?" over the gym's other boards plus "Not sure". The foot says who will see it, worded from `routeBoardReport` / `routeGymReport` through `pickReportAudience` (`report.route*` keys), and on a gym the viewer may claim that the gym doesn't run yet adds "Run {{gym}}? Claim it and fix it yourself", which dismisses the sheet, waits for it to settle (`dismissManagedSheetAndWait`), then opens `ClaimGymSheet`. Done says sent, "N other climbers flagged this too", or "you already reported this".

Who is offered it (`report-problem-model.ts`): a viewer who can't fix the board themselves. The creator and anyone the server lets edit, remove or delete the board get those actions instead. Signed out, the row opens login. Entry points, never on the climb, the player or the board art:

| Where | Row |
|---|---|
| Board picker card ⋯ (Your boards, Near you, At {gym} for your boards) | First row after the divider: Report a problem; Reported (disabled) once the viewer's report waits; See reports for the creator and staff while one waits on them |
| Board detail sheet | Last row, every board type but a Spraywall (which keeps its own report) |
| Climbs ⋯ | About this board, which opens the active board's detail sheet in the picker |
| `/boards/edit`, `/gyms/edit` lock state | "You can't edit this board / gym": who can change it, Report a problem, Claim, Go back |
| Gym page (PR 8) | The gym: header ⋯ and the last row of the page, through `useGymReportAction` over `useReportProblem({ target: { kind: 'gym', gym } })`, which returns `{ open, sheet }` or null and stays non-null while a sheet it opened is up, so a target that goes away mid-report (the detail sheet's board, when the report sheet displaces it) doesn't unmount the report. Each board row's ⋯: the card menu's rows (Report a problem, Reported, See reports), with the report and review sheets hosted in the page's route (`useGymBoardReports`); the review keeps the board it opened with if the board leaves the list. Staff see boards with a waiting report first |

**Report review** (`ReportReviewSheet`, hosted in the board picker and on the gym page). Opened from the `board_report_opened` notice and push (`/boards?board=<uuid>&review=1`), the card's See reports row, and the detail sheet. A link into the picker reads its board fresh (`staleTime: 0`) and waits for that read and for the flag bag to resolve before it opens a sheet; with the flag off, `review=1` opens the board's plain detail sheet. An open sheet shows the linked board as the latest read has it, not the copy it opened with. It lists each waiting report as "reason · N climbers" and the notes, never a name, then "If it's still open on {{date}}, our team takes a look" (or "Our team is looking at this one" when a report is in the admin queue and `viewerCanResolve` is false). Actions follow the board's flags: Fix the setup (`/boards/edit?fromReport=1`, whose save toasts "We'll tell the climbers who flagged it"), Remove from {{gym}} and Delete board (the picker's own confirms and mutations), and "It's right as it is", which closes every report the viewer may close as `kept` with one optional note. Each report closes on its own (`Promise.allSettled`); when only some do, the sheet says how many of how many and stays on the note, and the board's reports and report flags are read again whatever happened, so Send again tries only what is still open. Remove and Delete act on the board the sheet showed, which need not sit in any list the picker loaded. Creator and staff boards show a warning "Reported" pill beside the row title while `openReportCount > 0`.

**Notices** (`notification-copy.ts`, `directory-notice-route.ts`): report opened and reminders open the review sheet; an outcome, a staff edit and `gym_claimed_with_your_board` open the board's detail sheet; `board_removed_from_gym` opens it, and when the gym's staff did it (`actorRole: gym_staff`, not a moderator) offers the board's creator "Ask {{gym}} to list it again", which files a `relist_request`. The link carries the gym's uuid; the sheet names the gym as it loads it (the notice's name only fills the moment before), offers nothing for a gym that no longer resolves, and sends the ask once, after which the row says it was sent; a staff delete and `gym_claim_denied` explain in an alert; `gym_report_opened` opens the gym's edit screen. Every type has a sentence without names for a row missing them. With the flag off, a tap on any of them opens the board's plain detail sheet instead of the review sheet or the relist row, and the report push does the same once the flag is known to be off.

The app counts `Report Problem Sent` {targetKind, reason, status, platform}, the climber's side of a report. It is deliberately not named `Board Report Submitted`, so an insight on either never counts a report twice.

## The sweep and the daily digest

`directory-report-sweep` (pg-boss, `exclusive`, hourly at :47 UTC; `services/directory-report-sweep.ts`). Every step reads what is due, so a missed hour or a retry changes nothing twice. Each report is closed or reminded in its own transaction, and a failure is logged and counted (`failures`) without stopping the others; every step, the digest included, runs whatever happened in the one before:

1. Waiting reports on a board or gym that has been deleted or merged close as `deleted` / `merged` (`auto`).
2. `open` reports older than 14 days become `escalated` (`escalated_at` set). Admin-routed reports are escalated when they open.
3. `open` reports older than 7 days with no reminder get one: a second `board_report_opened` / `gym_report_opened` with `isReminder`, to the same people as they stand now.
4. Admin-path gym claims still waiting 30 days after they were filed expire, and the claimant hears ([gym-claims.md](gym-claims.md)).
5. Once a UTC day, from 08:00, the admin daily digest (`sendAdminDailyDigestEmail` in `email/email-service.ts`, to `ADMIN_EMAIL`): reports that reached the admin queue since the last digest and are still there (count, the first 20 with links to `/admin/board-reports?report=<uuid>`), and the setups climbers changed since the last digest (below). No email when every section is empty. One replica sends: the day's `admin_daily_digests` row is claimed before the email goes out. A digest that fails before or while sending gives the claim back for the next hour. One whose email went out keeps it even when recording `sent` fails, so the day's email never goes out twice; a claim left in `sending` (that, or a crash mid-send) holds its day and is cleared the next day, whose digest covers the window from the last finished one.

The digest is built from `ADMIN_DIGEST_SECTION_PROVIDERS`: `escalatedReportsSection`, then `autoApprovedClaimsSection` (claims that approved themselves, each with a link to `/admin/gym-claims?revert=<claim id>`; see [gym-claims.md](gym-claims.md)), then `climberSetupChangesSection` ("Setups climbers changed": the count, and the newest 10, `SETUP_CHANGES_DIGEST_ROWS`, each "{board} at {gym}: {before} → {after}" in words from `boardSetupSummary`, "(already undone)" on one undone since; every row and the section link open `/admin/board-reports?tab=setup-changes`, where each can be undone). A provider returns `{ key, heading, total, rows, moreUrl, moreLabel }` or null.

To stop the sweep: `DELETE FROM pgboss.schedule WHERE name = 'directory-report-sweep';`. Every boot schedules it again; to keep it off, revert its registration in `packages/backend/src/index.ts`.

## On www

Built in PR 5. Every entry point renders only while the `directory-reports` flag is on (below): www asks PostHog the same question for the same fixed id through `isDirectoryReportsEnabled()` (`packages/web/app/lib/directory-reports/directory-reports-flag.ts`, registered in `SERVER_FEATURE_FLAG_KEYS`), so a page never offers a report the server would refuse. The answer is not per person, so it is safe in a page the CDN shares.

- **Gym page** (`/gym/{slug}`). A 44px flag at the end of each board row ("Report a problem with {board}") and a **Report a problem** text button in the details column, where Report a duplicate was ("Listed twice" is one of the gym reasons). Hidden for anyone who can edit the gym (they have Manage gym). Signed out, a tap opens the login modal first; a social sign-in returns on `?report=gym` or `?report=<board uuid>` and the dialog reopens (`use-report-request.ts`, `report-return-param.ts`). With the flag off the page still shows Report a duplicate. One provider (`gym-report-problem.tsx`) holds the dialog and the board list for every row. The public board listing carries no creator names, so the routing line there says "the climber who added this board".
The admin queue and the staff Review dialog work while the `directory-reports` flag is off, on purpose: closing reports must keep working, and legacy duplicate-gym reports reach the queue regardless. Only the entry points that create reports are flag-gated.

- **Board list** (`/b/{slug}/{angle}/list`). "Something wrong with this board? Report a problem" at the end of the details (`board-report-link.tsx`). The page is in a shared 24 h CDN cache, so the island is the same markup for every reader: it reads the board (`GET_BOARD`), its gym (`GET_GYM`, for `listingState` and `canClaim`) and the gym's other boards (`GET_GYM_BOARDS`) with the reader's own session once the dialog opens. A flag flip reaches cached list pages as their cache turns over.
- **The dialog** (`components/directory-reports/report-problem-dialog.tsx`, rules in `report-problem-logic.ts`). The reasons as a radio list; for "Listed twice", the other boards at the gym plus "Not sure", or a search of similar gyms (`findSimilarGyms`) for a gym; a note, required (10 characters) for "Something else"; the routing line from `routeBoardReport` / `routeGymReport` through `pickReportAudience`; and, on a gym nobody runs that the viewer can claim, "Run {gym}? Claim it and fix it yourself", which opens the gym page's claim dialog. Sent, it says created, joined ("2 other climbers flagged this too") or already reported. A failure says "Your report didn't go through" (or to connect, offline), never the server's English.
- **Suggested setup on www** (PR 3 of the suggested-setup work). Behind `directory-setup-suggestions`, read for the same fixed id through `isDirectorySetupSuggestionsEnabled()` (`lib/directory-reports/directory-setup-suggestions-flag.ts`, in `SERVER_FEATURE_FLAG_KEYS`) on the gym page and the board list, and handed to the dialog as `setupSuggestionsEnabled`. Off, the dialog is the note-only one. On, "Set up wrong" on a board that isn't a spray wall shows Layout, Size, Holds (a multi-select that never goes to zero) and, on a board that doesn't tilt, Angle (`setup-suggestion-fields.tsx`), driven by `setupSelection` and starting on the board's current setup. The gym page passes each board's setup from the listing it renders; the board list reads it from the `GET_BOARD` it already sends when the dialog opens, so neither costs a new request. The labels come from `setup-labels.ts` in `@boardsesh/board-config`. Send waits for a setup that differs and sends `suggestedSetup`; the line above it comes from `setupSuggestionPreview` and takes the routing line's place, with no line at all when the board's gym is known but its listing state didn't load (the board list's `GET_GYM` failed), since the rule would read that as no gym. Sent, `APPLIED` says "Setup updated for everyone at {gym}", the new setup, and "Climb it now in the Boardsesh app" with the phone's store badge first (both badges from md, `placement = 'setup-report'`); `SENT_FOR_REVIEW` words the reason (`setupReviewLine`), and a null reason keeps the old done copy. A `SETUP_UNCHANGED` refusal (`isBoardSetupUnchangedError`: the page read the board before someone fixed it) is a done state too: "It's already set up that way.", with the setup and the app link, and the page reads the board again.
- **Manage gym → Boards.** The Reported chip, reported rows first, and the Review dialog with **Use this setup** for suggested setups: see [gym-board-management.md](../web/gym-board-management.md#manage-gym--boards-on-www).
- **Manage gym, no access.** The lock state says who can change the gym and offers Claim this gym and Report a problem: see [gym-board-management.md](../web/gym-board-management.md#manage-gym-for-someone-who-cant-manage-it).
- **`/admin/board-reports`** (`components/admin/board-reports-panel.tsx`, global admins, `checkAdmin()` like the other admin pages, noindex through the admin layout). `adminDirectoryReports` with a status filter (escalated by default) and a board/gym filter; reports routed to the team when they opened come first, then those that waited 14 days, oldest first. Each shows the target, reason, climber count, the notes with the reporters' names, its age and who it was sent to. Actions (`board-reports-actions.ts`): **Delete board** (`deleteBoard`), **Remove from gym** (`detachBoardFromGym` on the gym it was reported at; not for a relist request), **Hide gym from search** (`updateGym isListed: false`) and **Keep as it is** (with a note), each followed by `resolveDirectoryReport` with the matching outcome. A delete or removal has usually closed the report already, so `REPORT_CLOSED` there counts as done. A "listed twice" gym report links to `/admin/gym-duplicates` for the merge, and every report with a gym links to its Manage gym page. The daily digest's `?report=<uuid>` link highlights that report. A second tab, **Setup changes by climbers** (`board-setup-changes-panel.tsx`, rules in `board-setup-changes-logic.ts`, `?tab=setup-changes` opens it), lists `adminBoardSetupChanges` newest first with Load more: the board and gym as links, the setup before and after, the climber's name, how long ago, and Live / Undone / Changed since. Switching tabs writes `?tab=` back with `router.replace`. **Undo** asks first, then sends `undoBoardSetupChange`; a message says what happened (put back, `BOARD_SETUP_ALREADY_UNDONE` "Someone already put the old setup back.", `BOARD_SETUP_CHANGED_SINCE`, or a failure) and the first page is read again, so every row shows the state the server has. Without a token the tab says the list couldn't load rather than spinning.

## The `directory-reports` flag

A server flag in the backend (`services/directory-reports-flag.ts`), off by default, fails closed. It gates `reportBoard`, `reportGym` and every notice above, so nothing reaches an app build that can't word it. Closing reports and the sweep run either way.

It is one switch for the whole service, not a per-account rollout: a report reaches people other than the reporter, and the old builds it must stay away from are theirs.

1. `FEATURE_FLAG_OVERRIDES` naming it decides, in every environment: `directory-reports` turns it on, `directory-reports=false` is the kill switch. This is the lever for tests, a laptop and an emergency.
2. Otherwise PostHog project 412845, flag `directory-reports`, evaluated for the fixed id `system:directory-reports` and cached 60 s. **Turn it on with a plain 100% release condition**: a condition on a person property or a cohort never matches that id. An answer that leaves the flag out (deleted, never created) is off at once.
3. No PostHog key: off. No answer (a timeout, a non-2xx, an unreadable body, PostHog reporting errors while it evaluated): the last answer stands for one more interval, so one slow request does not flap it, then off until PostHog answers again.

Boot awaits the first answer (at most 1.5 s) before the server and the workers start, so the first minute's notices and pushes don't read a cold cache as off.

www reads the same flag for the same id to show its entry points (see "On www"); `FEATURE_FLAG_OVERRIDES` on the web deployment decides there.

Turn it on once the mobile PR's copy and routes are in a production build (and the web PR's dialog is live), after this backend is deployed.

## Analytics

Backend events, anonymised by `captureBackendEvent` (no board, gym or account id; docs/analytics/analytics-consent.md):

- `Board Report Submitted` {targetKind, reason, status, routedTo}
- `Board Report Resolved` {targetKind, reason, outcome, resolvedBy: creator | gym_staff | admin | auto, hoursOpen}. The launch metric is the share resolved without `admin`.
- `Board Removed From Gym` {by} and `Board Deleted` {by}, `by` being creator | gym_staff | moderator | admin.
- `Board Setup Suggested` {outcome: APPLIED | SENT_FOR_REVIEW, reason: a `BoardSetupReviewReason` or null, boardType, gymState: UNCLAIMED | CLIMBER_LISTED | RUN_BY_GYM | NO_GYM}, once per report that carried a suggestion and was filed (not one the refile cooldown answered).
- `Board Setup Change Undone` {by: creator | gym_staff | admin}.

They are sent once the action's transaction commits, so an action that rolls back counts nothing. The hooks queue them with `afterCommit` on the transaction handle, and every transaction that reaches the hooks is opened with `transactionWithAfterCommit` (`packages/backend/src/db/after-commit.ts`), which runs them after `db.transaction` resolves. A hook given `db` itself sends at once; one given a transaction opened with plain `db.transaction` also sends at once, before the commit, and logs a warning.

## Where it lives

- Routing, reasons, note rules, timing, the suggested setup rule: `packages/shared/directory-moderation/`.
- The setup fields' state: `packages/shared/board-config/src/setup-selection.ts`.
- Tables: `packages/db/src/schema/app/directory-reports.ts`.
- Resolvers: `packages/backend/src/graphql/resolvers/social/directory-reports/` (`submit.ts`, `read.ts`, `lifecycle.ts`, `notices.ts`, `core.ts`, and for suggested setups `setup-suggestion.ts`, `setup-snapshot.ts`, `setup-changes.ts`).
- The two server flags: `packages/backend/src/services/directory-reports-flag.ts` and `directory-setup-suggestions-flag.ts`, on `system-server-flag.ts`.
- Sweep and digest: `packages/backend/src/services/directory-report-sweep.ts`; the email in `email/email-service.ts`.
- Commit-time effects: `packages/backend/src/db/after-commit.ts`.
- www: `packages/web/app/components/directory-reports/` (dialog, rules, setup fields, sign-in return), `packages/web/app/gym/[gym_slug]/gym-report-problem.tsx`, `packages/web/app/components/gym-entity/manage/board-report-review-dialog.tsx`, `packages/web/app/gym/[gym_slug]/manage/manage-no-access.tsx`, `packages/web/app/admin/board-reports/`, `packages/web/app/components/admin/board-reports-panel.tsx` and `board-setup-changes-panel.tsx`.
- Tests: `packages/backend/src/__tests__/directory-reports.test.ts`, `packages/backend/src/__tests__/directory-reports-flag.test.ts`, `packages/backend/src/__tests__/directory-setup-suggestions.test.ts`, `packages/shared/directory-moderation/src/__tests__/`, and the location sync keeping a climber's change in `packages/location-sync/src/upsert.freeze.integration.test.ts`.
