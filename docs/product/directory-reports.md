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

- `directory_reports`: one problem with one target. `target_kind` is `board` or `gym`; a check holds exactly one of `board_id` / `gym_id`, the one the kind names. A board report keeps `gym_id_at_report` (the gym it was at, or for `relist_request` the gym that removed it), because a removal clears the board's own link. `status` is `open`, `escalated` (in the admin queue), or an outcome: `fixed`, `removed`, `deleted`, `kept`, `merged`. A second check holds `resolved_at` set exactly when the status is an outcome. `resolved_by_role` is `creator`, `gym_staff`, `admin` or `auto` (the system). Two partial unique indexes allow one waiting (`open` or `escalated`) report per (board, reason) and per (gym, reason).
- `directory_report_reporters`: who reported, with their note. Unique per (report, reporter) while the reporter's account exists; an account deletion nulls `reporter_id` and leaves the report.
- `directory_notification_context`: what a notification of this feature is about, keyed by the notification's uuid (report, board, gym, reminder flag, the staff role that acted). A side table, because `notifications` is large and hot; `app_feedback_messages.notification_uuid` is the same shape.
- `admin_daily_digests`: one row per UTC day the digest ran (`sending`, then `sent` or `empty`), with the window it covered.

Reports are never deleted by the app. A board's go with the board row (an account deletion removes its boards), a gym's with the gym row.

## Filing a report

`reportBoard` / `reportGym` (`packages/backend/src/graphql/resolvers/social/directory-reports/submit.ts`) copy `reportClimb`'s join semantics:

1. Signed in, the `directory-reports` flag on, 5 per minute.
2. The reporter must be able to read the target: the board by its uuid (`canAccessBoard` with the uuid as the link), the gym by the gym visibility rule. Anything else is "not found", so a report is never an oracle for which uuids exist.
3. In the filing transaction the board is read again under a share lock (`lockBoardFacts`). A delete or merge that committed since the checks makes it "not found"; a removal or move to another gym routes the report again against the board as it stands, so `gym_id_at_report` and `routed_to` never name a gym the board just left. The next delete or removal waits for the report to commit.
4. A climber whose report on the same target and reason closed less than 7 days ago (`REPORT_REFILE_COOLDOWN_DAYS`) can't open it again: they get `already_reported` with that closed report, and nothing is written. Every new report notifies and pushes its people, so this stops a reporter who disagrees with an outcome from pushing the creator over and over. A report someone else opened since is joined as usual.
5. `INSERT ... ON CONFLICT DO NOTHING` on the partial unique index. The first reporter gets `created`; a later reporter on the same target and reason joins the waiting report (`added`); a second report from the same climber writes nothing (`already_reported`). `otherReporterCount` feeds "2 other climbers flagged this too".
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
| `UserBoard.openReportCount` | | waiting reports the viewer can act on; null unless they are the creator, staff of the board's gym or of a report's gym, or a global admin |
| `UserBoard.viewerHasOpenReport` | | the viewer is a reporter on a waiting report; null signed out |
| `Notification.directoryNotice`, `GroupedNotification.directoryNotice` | | what a directory notification is about (below) |

`openReportCount` and `viewerHasOpenReport` are computed in `enrichBoard` / `enrichBoards` with two reads for the whole list (`loadBoardReportFlags`), never a query per row.

An admin closing a report as `removed` or `deleted` must have done it first with the existing mutations (`detachBoardFromGym`, `deleteBoard`, `updateGym isListed: false`, `deleteGym`); the mutation checks the board or gym. `fixed` and `merged` are not checked.

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

All in-app; only `board_report_opened` also goes out as a push (opt-in: only devices registered with `registerNotificationDevice`). The push rides the shared delivery worker (`notification-push-delivery`, the branch in `services/spray-detection-notifications.ts`), which rechecks the flag (awaiting PostHog when its cached answer is stale, so a cold cache never skips a delivery for good), that the report is still waiting and that the recipient can still read the board before every attempt.

At most 10 report pushes reach one person in 24 hours (`DIRECTORY_REPORT_PUSHES_PER_DAY`, counting `board_report_opened` notices that were queued to a device, reminders included). Past that the notice still lands in the inbox, without a push. Two reports filed at the same moment can both see one below the cap, so it can be passed by one or two.

| Type | To | When |
|---|---|---|
| `board_report_opened` | creator, gym staff | a board report opens, and once more at 7 days (`isReminder`) |
| `gym_report_opened` | gym staff | a `wrong_details` report on a gym run by the gym opens, and at 7 days |
| `board_report_resolved` | reporters | a board report closes (outcome, resolver role, and for `kept` the note) |
| `gym_report_resolved` | reporters | a gym report closes |
| `board_removed_from_gym` | creator | someone else takes their board off a gym |
| `board_deleted_by_staff` | creator | someone else deletes their board |
| `board_edited_by_staff` | creator | someone else changes their board |
| `gym_claimed_with_your_board`, `gym_claim_denied` | | reserved; the claim guardrails PR sends them (entity: the gym) |

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
4. Once a UTC day, from 08:00, the admin daily digest (`sendAdminDailyDigestEmail` in `email/email-service.ts`, to `ADMIN_EMAIL`): reports that reached the admin queue since the last digest and are still there (count, the first 20 with links to `/admin/board-reports?report=<uuid>`). No email when every section is empty. One replica sends: the day's `admin_daily_digests` row is claimed before the email goes out. A digest that fails before or while sending gives the claim back for the next hour. One whose email went out keeps it even when recording `sent` fails, so the day's email never goes out twice; a claim left in `sending` (that, or a crash mid-send) holds its day and is cleared the next day, whose digest covers the window from the last finished one.

The digest is built from `ADMIN_DIGEST_SECTION_PROVIDERS`. The claim guardrails PR fills `autoApprovedClaimsSection` (claims that approved themselves, each with a revert link); a provider returns `{ key, heading, total, rows, moreUrl, moreLabel }` or null.

To stop the sweep: `DELETE FROM pgboss.schedule WHERE name = 'directory-report-sweep';`. Every boot schedules it again; to keep it off, revert its registration in `packages/backend/src/index.ts`.

## On www

Built in PR 5. Every entry point renders only while the `directory-reports` flag is on (below): www asks PostHog the same question for the same fixed id through `isDirectoryReportsEnabled()` (`packages/web/app/lib/directory-reports/directory-reports-flag.ts`, registered in `SERVER_FEATURE_FLAG_KEYS`), so a page never offers a report the server would refuse. The answer is not per person, so it is safe in a page the CDN shares.

- **Gym page** (`/gym/{slug}`). A 44px flag at the end of each board row ("Report a problem with {board}") and a **Report a problem** text button in the details column, where Report a duplicate was ("Listed twice" is one of the gym reasons). Hidden for anyone who can edit the gym (they have Manage gym). Signed out, a tap opens the login modal first; a social sign-in returns on `?report=gym` or `?report=<board uuid>` and the dialog reopens (`use-report-request.ts`, `report-return-param.ts`). With the flag off the page still shows Report a duplicate. One provider (`gym-report-problem.tsx`) holds the dialog and the board list for every row. The public board listing carries no creator names, so the routing line there says "the climber who added this board".
The admin queue and the staff Review dialog work while the `directory-reports` flag is off, on purpose: closing reports must keep working, and legacy duplicate-gym reports reach the queue regardless. Only the entry points that create reports are flag-gated.

- **Board list** (`/b/{slug}/{angle}/list`). "Something wrong with this board? Report a problem" at the end of the details (`board-report-link.tsx`). The page is in a shared 24 h CDN cache, so the island is the same markup for every reader: it reads the board (`GET_BOARD`), its gym (`GET_GYM`, for `listingState` and `canClaim`) and the gym's other boards (`GET_GYM_BOARDS`) with the reader's own session once the dialog opens. A flag flip reaches cached list pages as their cache turns over.
- **The dialog** (`components/directory-reports/report-problem-dialog.tsx`, rules in `report-problem-logic.ts`). The reasons as a radio list; for "Listed twice", the other boards at the gym plus "Not sure", or a search of similar gyms (`findSimilarGyms`) for a gym; a note, required (10 characters) for "Something else"; the routing line from `routeBoardReport` / `routeGymReport` through `pickReportAudience`; and, on a gym nobody runs that the viewer can claim, "Run {gym}? Claim it and fix it yourself", which opens the gym page's claim dialog. Sent, it says created, joined ("2 other climbers flagged this too") or already reported. A failure says "Your report didn't go through" (or to connect, offline), never the server's English.
- **Manage gym → Boards.** The Reported chip, reported rows first, and the Review dialog: see [gym-board-management.md](../web/gym-board-management.md#manage-gym--boards-on-www).
- **Manage gym, no access.** The lock state says who can change the gym and offers Claim this gym and Report a problem: see [gym-board-management.md](../web/gym-board-management.md#manage-gym-for-someone-who-cant-manage-it).
- **`/admin/board-reports`** (`components/admin/board-reports-panel.tsx`, global admins, `checkAdmin()` like the other admin pages, noindex through the admin layout). `adminDirectoryReports` with a status filter (escalated by default) and a board/gym filter; reports routed to the team when they opened come first, then those that waited 14 days, oldest first. Each shows the target, reason, climber count, the notes with the reporters' names, its age and who it was sent to. Actions (`board-reports-actions.ts`): **Delete board** (`deleteBoard`), **Remove from gym** (`detachBoardFromGym` on the gym it was reported at; not for a relist request), **Hide gym from search** (`updateGym isListed: false`) and **Keep as it is** (with a note), each followed by `resolveDirectoryReport` with the matching outcome. A delete or removal has usually closed the report already, so `REPORT_CLOSED` there counts as done. A "listed twice" gym report links to `/admin/gym-duplicates` for the merge, and every report with a gym links to its Manage gym page. The daily digest's `?report=<uuid>` link highlights that report.

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

They are sent once the action's transaction commits, so an action that rolls back counts nothing. The hooks queue them with `afterCommit` on the transaction handle, and every transaction that reaches the hooks is opened with `transactionWithAfterCommit` (`packages/backend/src/db/after-commit.ts`), which runs them after `db.transaction` resolves. A hook given `db` itself sends at once; one given a transaction opened with plain `db.transaction` also sends at once, before the commit, and logs a warning.

## Where it lives

- Routing, reasons, note rules, timing: `packages/shared/directory-moderation/`.
- Tables: `packages/db/src/schema/app/directory-reports.ts`.
- Resolvers: `packages/backend/src/graphql/resolvers/social/directory-reports/` (`submit.ts`, `read.ts`, `lifecycle.ts`, `notices.ts`, `core.ts`).
- Sweep and digest: `packages/backend/src/services/directory-report-sweep.ts`; the email in `email/email-service.ts`.
- Commit-time effects: `packages/backend/src/db/after-commit.ts`.
- www: `packages/web/app/components/directory-reports/` (dialog, rules, sign-in return), `packages/web/app/gym/[gym_slug]/gym-report-problem.tsx`, `packages/web/app/components/gym-entity/manage/board-report-review-dialog.tsx`, `packages/web/app/gym/[gym_slug]/manage/manage-no-access.tsx`, `packages/web/app/admin/board-reports/` and `packages/web/app/components/admin/board-reports-panel.tsx`.
- Tests: `packages/backend/src/__tests__/directory-reports.test.ts`, `packages/backend/src/__tests__/directory-reports-flag.test.ts`, `packages/shared/directory-moderation/src/__tests__/`.
