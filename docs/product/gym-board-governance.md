# Who fixes a wrong board: gym and board governance

Boardsesh lists gyms and boards as a community directory. Some gyms come from public board data (the Aurora location sync) and belong to the SYSTEM account. Climbers create others, often without meaning to, by typing a gym name while setting up a board. Gym staff can claim a listing and take it over.

This doc records who may change what, and why. It started from a support message that had no answer in the product:

> "How do you delete a board that someone created at the gym, when it's not correct? 😅"

Decisions below were made by the founder on 2026-11-23, after an audit of every board and gym surface (17 in the app, 27 on www) and of the backend permission matrix.

## The problem in numbers (90 days to 2026-11-23)

- 1,798 boards created by 1,379 climbers. 97 duplicate prompts, which only catch the climber's own duplicates.
- About 2,900 synced gyms have never been claimed, so no gym admin exists for them.
- 21 claim clicks, 8 claim submissions from 3 people, 4 approved, 3 errors. 26 claims ever, all reviewed by hand.
- 18 people opened the web Manage gym tabs. The app has no gym page.
- No way to report a board. The only report paths were climbs, spray walls and an email-only duplicate-gym report.

## Decisions

### 1. Gym staff remove climbers' boards from their gym; they don't delete them

A board belongs to the climber who made it. A gym listing belongs to the gym. Before this change, linking a board to a gym (`user_boards.gym_id`) meant both "shown at this gym" and "this gym's admins may delete it". Climbers' boards are often linked automatically, and nobody told them when a gym was claimed.

- **Remove from gym** takes a board off the gym's page, kiosks and map pin, and leaves it with its creator. Gym owners, admins and editors can do it. It freezes the location sync on that board, so the hourly sync can't put it back. The creator can't link it back to the same gym; they can ask to be re-listed through Report a problem.
- **Delete** is for the board's creator, for gym owners and admins on synced (SYSTEM) boards at their gym, and for global admins on any board. Before this change, a gym owner or admin could delete any board at their gym (#8007).
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

- Revisit the community vote with report outcome data.
- Ask the climber before auto-linking a board to a nearby gym, or tell them when it happens.
- Stop scoped community leaders from changing a claimed gym's visibility, name or editors.
- Let only the gym owner remove admins.
- Hold domain claims against a real owner for review.
- Walls that disappear upstream open a report (#4966).
- One row per physical MoonBoard at a gym (#7245).

## Where it lives

- Permission rules: `packages/backend/src/graphql/resolvers/social/boards.ts` (`requireBoardDeleteAccess`, `canEditBoard`, and `UserBoard.canDelete` / `canRemoveFromGym` in the board enrichment) and `gym-stray-boards.ts` (`detachBoardFromGym`).
- Staff actions on boards and the re-link hold: the `board_moderation_events` table (`packages/db/src/schema/app/board-moderation-events.ts`) and its rules in `packages/backend/src/graphql/resolvers/social/board-moderation-events.ts`.
- Gym listing state (`Gym.listingState`): `gymListingState` in `packages/backend/src/graphql/resolvers/social/gyms.ts`.
- Staff board actions on www: `docs/web/gym-board-management.md`.
- Climb reports, for comparison: `docs/product/climb-moderation.md`.
