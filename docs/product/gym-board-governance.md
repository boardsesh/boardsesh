# Who fixes a wrong board: gym and board governance

Boardsesh lists gyms and boards as a community directory. Some gyms come from public board data (the Aurora location sync) and belong to the SYSTEM account. Climbers create others: since 2026-11 on purpose, from the add-a-board wizard's "Add your gym" step (a name and a pin, checked against the gyms already listed), and before that often without meaning to, by typing a gym name while setting up a board (`createBoard`'s auto-gym path, which is still there). Gym staff can claim a listing and take it over.

This doc records who may change what, and why. It started from a support message that had no answer in the product:

> "How do you delete a board that someone created at the gym, when it's not correct? 😅"

Decisions below were made by the founder on 2026-11-23, after an audit of every board and gym surface (17 in the app, 27 on www) and of the backend permission matrix.

## The problem in numbers (90 days to 2026-11-23)

- 1,798 boards created by 1,379 climbers. 97 duplicate prompts, which only catch the climber's own duplicates.
- About 2,900 synced gyms have never been claimed, so no gym admin exists for them.
- 21 claim clicks, 8 claim submissions from 3 people, 4 approved, 3 errors. 26 claims ever, all reviewed by hand.
- 18 people opened the web Manage gym tabs. The app had no gym page.
- No way to report a board. The only report paths were climbs, spray walls and an email-only duplicate-gym report.

## Decisions

### 1. Gym staff remove climbers' boards from their gym; they don't delete them

A board belongs to the climber who made it. A gym listing belongs to the gym. Before this change, linking a board to a gym (`user_boards.gym_id`) meant both "shown at this gym" and "this gym's admins may delete it". Climbers' boards are often linked automatically, and nobody told them when a gym was claimed.

- **Remove from gym** takes a climber's board off the gym's page, kiosks and map pin, and leaves it with its creator. Gym owners, admins and editors can do it. It freezes the location sync on that board, so the hourly sync can't put it back. The creator can't link it back to the same gym; they can ask to be re-listed through Report a problem.
- **Delete** is for the board's creator, for gym owners and admins on synced (SYSTEM) boards at their gym, and for global admins on any board. Before this change, a gym owner or admin could delete any board at their gym (#8007).
- **A synced board is deleted, never removed.** Gym staff can't remove a SYSTEM board from their gym; the gym's owner or admin deletes it, and anyone else reports it. Only a global admin can remove one.
- **Merge into another board** is available through the separately consented global-admin MCP repair tools for confirmed duplicate public catalogue walls. Gym staff do not inherit that authority. The operator chooses the survivor, whose owner stays unchanged. If another real creator loses editing ownership, the merge requires `allowOwnershipChange=true` after inspecting owner IDs and display names. That creator follows the survivor and receives a moderation notice. Original reporting provenance stays original and old board links follow tombstones.
- Delete is a soft delete. Logged ascents are never removed or reassigned by a remove or a delete.

Global-admin MCP directory repairs can also explicitly correct a board's location
visibility, including another creator's board. This requires the separate
`gyms:admin:write` consent, a current global role, a reason, confirmation and an
inspected state hash. It updates the location policy and legacy flag together,
records the previous visibility and acting admin, and notifies the creator through
the ordinary moderation lifecycle. It does not change board ownership, the board's
audience or access grants. Ordinary gym and admin board editors keep their existing
owner-only privacy restriction. See the [repair workflow](../integrations/hosted-gym-mcp.md#administrative-duplicate-repairs).

### 2. Report a problem goes to the person who can fix it

Every board and gym gets one entry point, **Report a problem**, with fixed reasons: set up wrong, listed twice, not on the wall anymore, wrong gym or place, something else.

| Board | Gym | Report goes to |
|---|---|---|
| Added by a climber | not claimed, or climber-listed | the creator |
| Added by a climber | run by the gym | the creator and the gym's owner and admins |
| Synced (SYSTEM) | run by the gym | the gym's owner and admins |
| Synced (SYSTEM) | not claimed | the Boardsesh admin queue, straight away |
| Any board, reason "wrong gym or place" | any | as above, plus the admin queue straight away (it can be a home address) |

- Reports on the same board and reason join one open report (the `reportClimb` pattern).
- Reporters stay anonymous to creators and staff.
- A reminder goes out at 7 days. At 14 days unresolved, the report moves to the admin queue.
- Fixing the setup, removing the board, deleting it, or marking it "It's right as it is" closes the report and tells the reporters.

**No community vote in v1.** Gym pages draw small audiences (248 visitors across all gym pages in 90 days), so a vote rarely clears, and where it does it is easy to sock-puppet. We revisit after about 90 days of report outcome data.

### 3. Claims on unclaimed synced gyms approve themselves, with guardrails

Work-email verification can't work for almost every gym: synced gyms never carry an owner-confirmed website. Without auto-approval, every claim waits on one person.

Auto-approval applies only when all of these hold:

- The gym is still owned by SYSTEM.
- No climber-owned board is linked to it.
- No gym admin or editor is on it (added in PR 6).
- The account is at least 30 days old and has never had a claim auto-approved.
- Fewer than the daily cap (`gym_claim_auto_approve_daily_cap`, default 10) were auto-approved today.

Anything else goes to review, as before. For 14 days after an auto-approval, nobody at that gym can delete the gym, delete boards, remove members or add admins. Each auto-approval appears in the admin's daily digest with a one-tap revert. Auto-approval stays off until an admin turns on `gym_claim_auto_approve`.

### 4. Everyone can see who runs a gym and who added a board

A gym is in one of three states: **Run by the gym** (an approved claim or an admin handover), **Added by a climber**, or **Not claimed yet**. Screens that can't be edited say who can change them and offer Report a problem and, where it applies, Claim. They no longer say only "You don't have permission".

## Creating a gym: one listing per gym

A second listing of a real gym splits its boards, followers and claim across two pages. Climbers mostly made those by typing a gym that was already there, so `createGym` now refuses a gym that looks listed until the climber has seen the matches.

- **What counts as similar.** The `findSimilarGyms` search, run as the caller: the same name within 5 km, any name within 150 m, or a name that contains (or is contained in) the other within 1 km. With no coordinates, name only. Only public, listed gyms and the caller's own count, so another climber's private or unlisted gym never blocks and never leaks.
- **The check.** `CreateGymInput.duplicateCheck: { mode, acknowledgedGymUuids }`. Absent means `REJECT_IF_FOUND`: unlike the board wall check, every gym create is checked, old clients and scripts too.
  - `REJECT_IF_FOUND` refuses on any match.
  - `CONFIRMED_SEPARATE` refuses on a match missing from `acknowledgedGymUuids` (at most 50; www keeps the 50 most recent it showed). An empty list, or one naming none of the matches, refuses on all of them, so a blind confirmation never skips the check.
- **The refusal.** `GYM_SIMILAR_EXISTS`, with `extensions.candidates` in the `SimilarGym` shape (name, address, distance, `isClaimable` and the rest), nearest first, at most 5. Unlike `BOARD_EXISTING_WALLS`, which names walls by uuid only, it carries the gyms whole: they are exactly what `findSimilarGyms` returns to the same caller, so the error shows nothing the query doesn't. The check reads up to 50 matches; once the first five are acknowledged the next refusal names the next ones. Without coordinates the name search reads 50 rows with exact names first in SQL, so an exact duplicate can't fall outside the window behind many substring matches. `readSimilarGymsError` in `@boardsesh/graphql` reads it.
- **The cap.** An account may list at most 25 gyms itself (`MAX_AUTO_MINTED_GYMS_PER_OWNER`, the number that already stopped `createBoard` minting gyms). Only gyms in the "Added by a climber" state count (`CLIMBER_LISTED`): live, not merged, and not held through an approved claim or an admin handover, read with the same SQL as `listingState` (`ownerHoldsClaimOrHandoverColumn`). Staff who claimed thirty listings run them; they didn't add them. Gyms `createBoard` minted count, and so does a gym whose claim is still pending. Past the cap `createGym` refuses with `GYM_LIMIT_REACHED` (`extensions.maxGyms`). Exempt: the SYSTEM catalogue owner and global admins (an `admin` role with no board type); an admin scoped to one board type is not. `createBoard`'s mint path still counts every owned gym, without a lock.
- **The name** is trimmed on the server before anything else, so the stored name, the slug and the check see the same text.
- **Concurrency.** The cap, the similar-gym read, the slug and the insert run in one transaction. It first takes `pg_advisory_xact_lock` per owner (`0x47594d4f`, "GYMO", key `hashtext(owner id)`) and then per normalized name (`0x47594d4e`, "GYMN"). A double-tapped Save, or two climbers adding one gym by the same name at once, serialize: the second reads after the first commits and is refused. Two climbers adding one gym under different names at the same moment are not serialized (no key both share); the 150 m tier catches the second one only once the first has committed. Two different names can share a slug ("Rock Hall", "Rock-Hall!"); the slug is read on the transaction after the locks, and when the `gyms_unique_slug` index still catches a concurrent create, the whole create runs once more and takes the next slug.
- **Where it shows.** www `/gyms/new` keeps its as-you-type suggestions, and on the refusal opens "Is it one of these?" with the same cards, Claim where the climber may (counted as placement `similar-gyms-refusal`), and "No, add a new gym", which resends as `CONFIRMED_SEPARATE` with every gym shown since that Save. The app's add-a-board wizard calls `createGym` from "Add your gym" (Which gym? → Add my gym): it asks "Is it one of these?" as the name and pin settle, shows a refusal's gyms in the same list, and "No, add a new gym" resends as `CONFIRMED_SEPARATE` with every gym dismissed (the 50 most recent). See "The app" in `existing-wall-check.md`.

## Not built, on purpose

- A community vote that hides boards (see decision 2).
- Moving board ownership to the gym on claim. It would take a climber's board away on someone else's say-so.
- Kiosks, branding and stray-board attach stay on the website, linked from the app's gym page. Staff can open Analytics from My gyms in the app.
- Gym delete or merge for owners. Closed gyms and duplicate gyms are report reasons that admins act on.

## Follow-ups

Tracked under epic #8043.

- Revisit the community vote with report outcome data (#8044).
- Ask the climber before auto-linking a board to a nearby gym, or tell them when it happens (#8045).
- Stop scoped community leaders from changing a claimed gym's visibility, name or editors (#8046).
- Let only the gym owner remove admins (#8047).
- Hold domain claims against a real owner for review (#8048).
- Walls that disappear upstream open a report (#4966).
- One row per physical MoonBoard at a gym (#7245).

## Decision log

Implementation calls made while building, recorded so they can be revisited.

### Suggested setups (2026-11-23)

"Set up wrong" gains real dropdowns, and the climber can climb the corrected setup straight away. Mechanics: "Suggested setup" in [directory-reports.md](directory-reports.md#suggested-setup).

The founder's answers:

1. **No private copy.** A suggestion changes the gym's board for everyone.
2. **At a gym nobody runs, the change applies straight away.** At a gym run by the gym, its staff review it first.
3. **Every climber change at a gym nobody runs stays in a history** that admins review, and admins can undo it. The board's creator and the gym's staff can undo it too.
4. **Same board type only:** layout, size, holds and angle. A wrong board type stays "Listed twice" or "Something else".
5. **The dropdowns ship in the app and on the website.** "Climb it now" is app-only, because www has no climbing.

Defaults chosen with them, open to change:

- **"Nobody runs it" means `listingState` is not `RUN_BY_GYM`**, so `UNCLAIMED` and `CLIMBER_LISTED`. It matches the gym page's "Not claimed yet" and "Added by a climber".
- **A board with no gym** (a home wall) goes to its creator for review. It never changes straight away.
- **Spray walls keep the note field.** They have no layout to pick.
- **No account-age gate.** It would block the climber standing at the wall. Three limits and undo cover abuse instead: one climber change per board per 24 hours, review for 90 days after an undo, and 3 changes per climber per 24 hours.

Calls made building the contract (PR 1):

- **The per-climber limit is a rolling 24 hours**, not a calendar day, so it doesn't depend on anyone's time zone.
- **A report a climber's change closes is resolved by `climber`**, a new resolver role, rather than `admin` or `auto`. Counting it as `admin` would hide climber fixes inside the launch metric (the share of reports closed without an admin).
- **The creator's notice links to its setup change** (`directory_notification_context.board_moderation_event_id`), so it can show before and after and offer Undo without searching the event history.
- **`reportBoard` keeps its result type.** `DirectoryReportSubmitResult` gains `setupOutcome`, `setupReviewReason` and `board`, which read null for gym reports, rather than a new board-only type that would change the type app builds already query.
- **`DirectoryReportNote.note` stays non-null.** A reporter who only suggested a setup has an empty note, so app builds from before the setup fields still render the row.
- **With the `directory-setup-suggestions` flag off**, a suggestion is still stored and goes to review with no reason, so turning the flag on never strands one.

Calls made building the resolvers (PR 1):

- **A reporter already on the waiting report replaces their suggestion**, and it is decided again. It only touches their own row and reaches nobody new, and it lets a climber whose suggestion waited on a limit try again later.
- **"Staff" who may undo are the gym's owner and admins** (`viewerGymManagerRole`), the same people who may edit the gym's boards, so an undo never reaches further than a hand edit would. Editors may not.
- **A clash is checked before the board is written**, with reads only, so `CLASHES` sends the suggestion to review inside the same transaction instead of failing the report.
- **A report a change closes at once sends no "report opened" notice.** The creator hears about the change instead, which offers Undo.
- **An undo is an edit:** it closes the board's waiting "Set up wrong" reports as fixed, and keeps `updateBoard`'s serial guard. It skips the owner-duplicate prompt, since it restores the board's own earlier setup.

### PR 1: backend power model

- A staff removal blocks the creator from re-linking the board to that gym. The block lifts when staff put it back, which writes a `relinked` event. A staff attach that lifts no block writes no event.
- Staff can put a removed board back by its ID while it is unlinked. Without this, "ask them to re-list it" had no working path.
- A creator who is also staff at the gym and removes their own board is recorded as `board_owner`, and no block is placed.
- `updateSprayWall` with `gymUuid: null` by someone other than the owner counts as a staff removal.
- Staff edits are recorded only when a field actually changes. Draft-only spray hold edits are not recorded; the commit or publish that makes them visible is.
- Event context goes in a `details` jsonb column; `reason` holds only text a person typed.
- The new `canDelete`, `canRemoveFromGym` and `listingState` fields are optional in the hand-written TypeScript types, so web and mobile fixtures don't change before the client PR.
- **Synced boards are deleted, never removed.** `detachBoardFromGym` refuses a SYSTEM board with `SYSTEM_BOARD_DELETE_INSTEAD` ("This board comes from public board data. Delete it instead, or report it.") unless the caller is a global admin, and `canRemoveFromGym` is false for it. Removed, a synced board would be a frozen pin with no gym that the stray list hides and only a global admin could delete. Spray walls are never SYSTEM-owned while live, so `updateSprayWall` with `gymUuid: null` needs no such rule. Founder-delegated decision, 2026-11-23.
- **Bounded staff re-list.** Staff put a removed board back by uuid only while it is unlinked, its location is not hidden (`hide_location = false`), and its creator has not linked or unlinked it anywhere since the removal. To see that, the creator's own gym link changes (`linkBoardToGym`, an owner's `updateSprayWall`, an own-board stray attach, `createGym` with a board) are recorded as `board_owner` rows: `removed_from_gym` for the old gym, `relinked` for the new one. They place no hold. This reused the two existing actions rather than adding enum values, which would have meant a migration.
- **The hold is keyed to the gym row.** A gym merge, a spray-wall reset (new board id) or deleting and recreating the board or gym drops it. Accepted: each is rare, and a merge already moves the gym's boards on purpose.
- **Hold events are ordered by `id`.** `created_at` is the transaction's start, so it can order a removal before the relink it followed. Every writer of a removal or relink holds the board's row lock when it inserts, and the creator's link (`linkBoardToGym`, `updateSprayWall`) is decided again under that lock.
- **`listingState` counts any past admin handover to the current owner as `RUN_BY_GYM`**, even when ownership changed hands in between and came back another way. Accepted: an admin vetted that person for this gym at some point.
- **An admin can't clear the sync freeze on a board whose latest removal or relink is a staff removal** (`LOCATION_SYNC_BOARD_REMOVED_BY_GYM`). Staff can't remove synced boards any more, so this guards older rows and a global admin's own removals.
- **No `gym_id` or `actor_user_id` index on `board_moderation_events`.** Hard deletes of users and gyms are rare, so the `SET NULL` scans they cost are accepted. Migration 0333 stays as it is; a stacked PR builds on it.

### PR 2: clients read the flags

- `listingState` is required on the `Gym` type now that `GYM_FIELDS` selects it. `canDelete` and `canRemoveFromGym` stay optional on `UserBoard`, because an offline snapshot written before them never carries them. The app's menu falls back to the old owner-only rule for such a board.
- Recorded screenshot fixtures replay both board flags as `false`: no capture opens a board menu, so no shot changes.
- In the app, staff actions show on boards the staff member saved (Your boards, and their saved walls At {gym}). Staff actions on every board at the gym arrive with the app's gym page.
- The app offers Remove from {gym} only when it can name the gym. Location privacy can hide it; the row then stays off.
- "Added by" comes from `boardOriginFor`: the SYSTEM owner id is public board data, the viewer's own id is "you", a named owner is named, and a hidden one is "a climber".
- `/gym-claim/error` shows "Back to {gym}" when the redirect carries `?gym=`. The verification handler sends it from PR 6 on, for every failure whose token named a claim.

### PR 6: claim guardrails

The mechanics are in [gym-claims.md](gym-claims.md).

- **The claimant's own boards don't block auto-approval.** Decision 3 says "no climber-owned board"; a board the claimant made gives them no power over anyone else, and gym staff often set up their own wall first.
- **A reverted auto-approval still uses up the account's one.** Otherwise revert-and-reclaim would be a loop.
- **Probation ends when the claimant stops owning the gym** (a revert or an admin handover), and binds every owner and admin of the gym, not only the claimant. Editing, adding members or editors, and removing climbers' boards stay open: a revert undoes those.
- **Revert clears the sync freeze outright** rather than restoring an earlier one. The claimant's edits froze the gym too, and keeping a freeze would keep their changes.
- **Revert takes the website's owner vouch away**, so the website the claimant may have set can't carry a domain claim by them.
- **Claims are addressed by id, not uuid.** `gym_claims` has no uuid column, and the queue and `reviewGymClaim` already use the id. The digest links `/admin/gym-claims?revert=<claim id>`.
- **Expiry and revert reuse `gym_claim_denied`** in the app ("We couldn't confirm you run {gym}. Reply to our email if we got it wrong."), with a separate email for each. No new notification type, so no new copy for old app builds.
- **`gym_claimed_with_your_board` is one per creator**, naming their oldest board at the gym, and is sent after the transfer commits so a failure to tell people never undoes a claim.
- **A SYSTEM gym with an admin or editor never approves itself.** Someone already runs it, and the claim would put the claimant over them.
- **Revert only undoes a claim that took an untouched gym from SYSTEM.** A claim that displaced a real owner, or a gym moved since, goes through Move gym ownership instead. Revert also revokes every older approved claim on the gym, so the sync curates it again.
- **Claim expiry starts on 24 November 2026.** Admin-path claims filed before then stay in the queue for a person, so the first sweep doesn't expire the backlog and email everyone in it.

### PR 8: the app's gym page

- The page is a pushed route, `app/gyms/[gym].tsx`, with a one-line copy at `app/boards/gym/[gym].tsx` so the board picker pushes it inside its own stack. Every in-app entry point opens it by gym uuid through `gymPageHref`; a slug also resolves, for pasted links. Its staff tools open the gym editor and insights in the same stack the page is in (`gymEditHref`, `gymAnalyticsHref`, with copies at `app/boards/gyms/edit.tsx` and `app/boards/gyms/analytics.tsx`): a root route pushed from inside the picker would stack a second sheet (`docs/mobile/mobile-sheets-vs-routes.md`, "Same-navigator modal inheritance").
- What the page shows is one pure function, `deriveGymPageViewModel` (`packages/mobile/src/components/gym-page/gym-page-view-model.ts`), tested viewer by listing state. The owner is read from `ownerId` before `myRole`, because the server reports an owner's role as `admin`. A viewer who can edit the gym without being its staff (a community leader, our team) gets the staff tools and the listing pill, not a staff pill or Start here.
- The claim stays hidden for everyone on a gym its staff run, and on a private gym. Signed out, the server never answers `canClaim`, so the page offers "Log in and claim it" on any public gym not run by its staff.
- A pending claim comes from the web's `GET_GYM_PENDING_CLAIM` document, asked only where a claim card could show. Any failure reads as no pending claim, which only shows the card again.
- "Start here" shows to gym staff while the gym has no opening hours, because hours are the one step the app can see being done. To make "Add opening hours" work, the app's Edit gym details form gained an opening hours field. It sends the hours only when they changed, so a save that left them alone doesn't stamp "Updated" on the page.
- Every board is its own list cell (FlashList), drawn as a slice of one inset card. The rows use the shared board menu with the picker's confirms. Pin, download and details are off on this page; "Remove from your boards" shows only on a board the climber saved. The gym's board list doesn't carry owner names, so the confirms here say "the climber who added it" for someone else's board.
- Report a problem on the gym (the header ⋯ row and the row at the foot of the page) comes from `useGymReportAction`, a thin wrapper over the shared `useReportProblem`. Board rows get Report a problem, Reported and See reports from the shared board menu, with the report and review sheets hosted in the page's route (`useGymBoardReports`). Staff see the boards with a waiting report first, and those rows carry the "Reported" pill. All of it stays off while the `directory-reports` flag is off (docs/product/directory-reports.md).
- `Gym Page Viewed` { surface, listingState, viewerRole } fires once per gym per visit, after the viewer's identity resolves.


### PR 7: finding the claim, and the admin's revert

- **The claim follows the listing state, for everyone.** Nobody can claim a gym run by its staff (`RUN_BY_GYM`), signed in or not; before, a signed-in climber could still claim it into admin review. A dispute goes through Report a problem. The server enforces it: `Gym.canClaim` and `SimilarGym.isClaimable` are false there, and `requestGymClaim` refuses with `GYM_RUN_BY_STAFF` ("This gym is run by its staff. If that's wrong, report a problem and our team will look."), which both claim forms show in the viewer's language. Every client also hides the claim there on its own: the www gym page, the directory, the manage lock state (which then doesn't ask for a pending claim either), the app's gym page and its gym map rows. A claim already in the queue on such a gym still waits for a person. A gym a climber added (`CLIMBER_LISTED`) now offers the claim to signed-out visitors, where `isClaimed` used to hide it.
- **"Run this gym? Claim it" sits under the H1** on www, in the run-by line, and the call-out has a second copy above the boards that CSS shows below 960px (the details column's copy shows from 960px). One flow: the details copy owns the dialog and the sign-in hop, and the phone copy and the run-by link ask it to start (`requestGymClaim`). A claim already in the queue drops the link and keeps the pending notice where it was.
- **The run-by words are one set of keys**, `boards:runBy.*`, moved from PR 8's `boards:mobile.gymPage.*` so www and the app read the same strings. The directory's chips keep their own `gyms:card.*` copies with the same words: the directory page doesn't load the `boards` namespace, and three strings didn't justify shipping it.
- **Claim mode on `/gyms?claim=1`** (the directory's footer prompt, /for-gyms, the site footer) puts Claim this gym on every result card whose gym isn't run by its staff, and the param rides the search form, page links and facet links so a search keeps it. Signed in, the button opens the gym page with its dialog open; signed out, it goes through log-in with that page as the callback. Every claim prompt on the directory now lands on one anchor, the search card (`#gym-directory-search`), which clears the fixed header.
- **The manage lock state reads the pending claim** the same way the gym page does (its own document, failure reads as none, asked only where a Claim button could show) and shows the pending notice in place of the button.
- **The revert screen needed a list the backend didn't have.** `autoApprovedGymClaims` returns the claims that approved themselves and moved their gym, approved or already revoked, newest first, with `claimId` to narrow it to the digest link's claim. A refusal keeps the confirm open with its own line, pointing at Move gym ownership below it. The digest link is handled once, so an auth-token refresh doesn't reopen a closed confirm or reload the list. The daily limit control shows the cap the backend applies (any whole number, a negative one as 0, 10 while unset or unreadable) and accepts 0 to 1000 for a new value.
- **A denied claim opens the gym page.** Nothing on the gym says a claim was denied, so the `gym_claim_denied` notice (in-app and push) opens the gym page with `?claim=denied`: the card moves up under the top block, says "Your claim for {{gym}} didn't go through. Reply to our email if we got it wrong…", which fits a denial, an expiry and a revert alike, and offers Try again while the gym can still be claimed. Once it can't, the card keeps the first sentence and drops "or try again" with the button. A claim filed since wins, and a notice without its gym still explains itself in an alert.
- **"Check your boards" stays in the app.** After an approved claim the sheet opens the gym's page once it has slid away: in the board picker's own stack when it was opened there, not at all when it was opened on that gym's page (which refreshes into the staff view, and scrolls to the boards when its own claim card started it). The website hand-off and its error line are gone.
- **The app's gym map shows the listing pill on every row**, the three listing states only: the viewer's own role is the gym page's job.
- **The renames change values, not keys**: Gyms you run, Find a gym, See all, Your boards, Added by you, and "You now run {{gym}}". Gyms you run still lists every gym where the climber is owner or member; listing staff roles only is left for later.
- **Claim analytics gained five placements** (`gym-page-header`, `directory-result`, `manage-lock`, `app-gym-list`, `app-gym-page`), and the app sends `Gym Claim CTA Clicked` for the first time. `Gym Claim Path Clicked` reading zero was its age (shipped 2026-11-19), not a bug (docs/analytics/gym-funnel-analytics.md).

## Where it lives

- Permission rules: `packages/backend/src/graphql/resolvers/social/boards.ts` (`requireBoardDeleteAccess`, `canEditBoard`, and `UserBoard.canDelete` / `canRemoveFromGym` in the board enrichment) and `gym-stray-boards.ts` (`detachBoardFromGym`).
- Staff actions on boards and the re-link hold: the `board_moderation_events` table (`packages/db/src/schema/app/board-moderation-events.ts`) and its rules in `packages/backend/src/graphql/resolvers/social/board-moderation-events.ts`.
- Gym listing state (`Gym.listingState`): `gymListingState` in `packages/backend/src/graphql/resolvers/social/gyms.ts`.
- The app's gym page: `packages/mobile/src/components/gym-page/` (screen, view model, board rows), routed at `app/gyms/[gym].tsx` and `app/boards/gym/[gym].tsx`; the routes for every gym screen are in `gym-page-route.ts`.
- Who runs a gym on www: the run-by line and the claim call-outs in `packages/web/app/gym/[gym_slug]/` (`gym-run-by-line.tsx`, `gym-claim-cta.tsx`, `gym-claim-callout.tsx`, `gym-claim-cta-logic.ts`), the directory's chips and claim mode in `packages/web/app/gyms/gym-directory-card.tsx`.
- Staff board actions on www: `docs/web/gym-board-management.md`.
- Climb reports, for comparison: `docs/product/climb-moderation.md`.
- Stopping a second copy of a wall before it is created (the gym's existing walls, the `createBoard` recheck): `docs/product/existing-wall-check.md`.
- Stopping a second listing of a gym, and the gym cap: `createGym` in `gyms.ts`, its guards in `gym-create-guards.ts`, the search in `findSimilarGymCandidates` (`gym-matching.ts`), www's dialog in `packages/web/app/components/gym-entity/similar-gym-refusal-dialog.tsx`. Tests: `packages/backend/src/__tests__/create-gym-duplicate-check.test.ts`.
