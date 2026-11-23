# Who fixes a wrong board: gym and board governance

Boardsesh lists gyms and boards as a community directory. Some gyms come from public board data (the Aurora location sync) and belong to the SYSTEM account. Climbers create others, often without meaning to, by typing a gym name while setting up a board. Gym staff can claim a listing and take it over.

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
- **Merge into another board** will become the first staff action for duplicates once the board merge tool lands. It is built separately.
- Delete is a soft delete. Logged ascents are never removed or reassigned by a remove or a delete.

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
- The account is at least 30 days old and has never had a claim auto-approved.
- Fewer than the daily cap (`gym_claim_auto_approve_daily_cap`, default 10) were auto-approved today.

Anything else goes to review, as before. For 14 days after an auto-approval, nobody at that gym can delete the gym, delete boards, remove members or add admins. Each auto-approval appears in the admin's daily digest with a one-tap revert. Auto-approval stays off until an admin turns on `gym_claim_auto_approve`.

### 4. Everyone can see who runs a gym and who added a board

A gym is in one of three states: **Run by the gym** (an approved claim or an admin handover), **Added by a climber**, or **Not claimed yet**. Screens that can't be edited say who can change them and offer Report a problem and, where it applies, Claim. They no longer say only "You don't have permission".

## Not built, on purpose

- A community vote that hides boards (see decision 2).
- Moving board ownership to the gym on claim. It would take a climber's board away on someone else's say-so.
- Kiosks, branding, insights and stray-board attach in the app. They stay on the website, linked from the app's gym page.
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

### PR 8: the app's gym page

- The page is a pushed route, `app/gyms/[gym].tsx`, with a one-line copy at `app/boards/gym/[gym].tsx` so the board picker pushes it inside its own stack. Every in-app entry point opens it by gym uuid through `gymPageHref`; a slug also resolves, for pasted links.
- What the page shows is one pure function, `deriveGymPageViewModel` (`packages/mobile/src/components/gym-page/gym-page-view-model.ts`), tested viewer by listing state. The owner is read from `ownerId` before `myRole`, because the server reports an owner's role as `admin`. A viewer who can edit the gym without being its staff (a community leader, our team) gets the staff tools and the listing pill, not a staff pill or Start here.
- The claim stays hidden for everyone on a gym its staff run, and on a private gym. Signed out, the server never answers `canClaim`, so the page offers "Log in and claim it" on any public gym not run by its staff.
- A pending claim comes from the web's `GET_GYM_PENDING_CLAIM` document, asked only where a claim card could show. Any failure reads as no pending claim, which only shows the card again.
- "Start here" shows to gym staff while the gym has no opening hours, because hours are the one step the app can see being done. To make "Add opening hours" work, the app's Edit gym details form gained an opening hours field. It sends the hours only when they changed, so a save that left them alone doesn't stamp "Updated" on the page.
- Every board is its own list cell (FlashList), drawn as a slice of one inset card. The rows use the shared board menu with the picker's confirms. Pin, download and details are off on this page; "Remove from your boards" shows only on a board the climber saved. The gym's board list doesn't carry owner names, so the confirms here say "the climber who added it" for someone else's board.
- Report a problem on the gym (the header ⋯ row and the row at the foot of the page) comes from `useGymReportAction`, a thin wrapper over the shared `useReportProblem`. Board rows get Report a problem, Reported and See reports from the shared board menu, with the report and review sheets hosted in the page's route (`useGymBoardReports`). Staff see the boards with a waiting report first, and those rows carry the "Reported" pill. All of it stays off while the `directory-reports` flag is off (docs/product/directory-reports.md).
- `Gym Page Viewed` { surface, listingState, viewerRole } fires once per gym per visit, after the viewer's identity resolves.


## Where it lives

- Permission rules: `packages/backend/src/graphql/resolvers/social/boards.ts` (`requireBoardDeleteAccess`, `canEditBoard`, and `UserBoard.canDelete` / `canRemoveFromGym` in the board enrichment) and `gym-stray-boards.ts` (`detachBoardFromGym`).
- Staff actions on boards and the re-link hold: the `board_moderation_events` table (`packages/db/src/schema/app/board-moderation-events.ts`) and its rules in `packages/backend/src/graphql/resolvers/social/board-moderation-events.ts`.
- Gym listing state (`Gym.listingState`): `gymListingState` in `packages/backend/src/graphql/resolvers/social/gyms.ts`.
- The app's gym page: `packages/mobile/src/components/gym-page/` (screen, view model, board rows), routed at `app/gyms/[gym].tsx` and `app/boards/gym/[gym].tsx`.
- Staff board actions on www: `docs/web/gym-board-management.md`.
- Climb reports, for comparison: `docs/product/climb-moderation.md`.
