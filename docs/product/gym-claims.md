# Gym claims: auto-approval, probation, revert and expiry

Gym staff claim a gym's listing to manage it. A claim goes one of three ways: a work-email link on a gym whose owner vouched for its website (the domain path), a person in the admin queue (the admin path), or, for an unclaimed synced gym, it approves itself. This doc covers the limits on that last path and what follows it: the guards, the 14-day probation, the admin's revert, the 30-day expiry of admin-path claims, and who is told what.

The product decision is decision 3 in [gym-board-governance.md](gym-board-governance.md). The report flow it builds on, including the daily digest and the `directory-reports` flag, is in [directory-reports.md](directory-reports.md).

Epic #8043, PR 6 of 8.

## Who can claim

Anyone signed in who can't already edit the gym, on a public gym, unless the gym is run by its staff (`listingState` `RUN_BY_GYM`: its owner holds an approved claim or got the gym in an admin handover). Nobody can claim a gym its staff run. A dispute goes through Report a problem, which reaches our team. `Gym.canClaim` and `SimilarGym.isClaimable` are false there, and `requestGymClaim` refuses with `extensions.code = 'GYM_RUN_BY_STAFF'` (`GYM_RUN_BY_STAFF_CODE` in `@boardsesh/gym-claim`): "This gym is run by its staff. If that's wrong, report a problem and our team will look." Both claim forms map the code to their own translated line (`isGymRunByStaffError`). A claim already pending on such a gym stays in the queue for a person, and approving one that is older than the gym's current ownership is still refused as superseded (`GYM_CLAIM_SUPERSEDED`).

### Claim instead of a second listing

Adding a gym that already looks listed is refused (`GYM_SIMILAR_EXISTS`, see "Creating a gym" in [gym-board-governance.md](gym-board-governance.md)). Each gym the refusal names carries `isClaimable` and `canClaimByDomain`, computed the same way as for `findSimilarGyms`, so staff who meant to add their own gym are offered its claim rather than a copy. Creating also stops once an account has listed 25 gyms itself (`GYM_LIMIT_REACHED`). A gym held through an approved claim or an admin handover doesn't count toward it, so staff who claim many listings can still add one; a gym whose claim is still pending does count.

## Turning auto-approval on

Auto-approval is off until a global admin turns it on. It is two community settings, global scope, both admin-only because of their `gym_` prefix:

| Setting | Default | Meaning |
|---|---|---|
| `gym_claim_auto_approve` | `0` | `1` turns auto-approval on |
| `gym_claim_auto_approve_daily_cap` | `10` | at most this many claims approve themselves in any 24 hours, across all accounts. `0` stops them all; a negative value reads as 0, and one that is not a whole number as 10 |

Both are in /admin settings (`gym-settings-panel.tsx`): the switch, and under it the daily limit. The field shows the cap the backend applies, read the backend's way (any whole number, a negative one as 0, 10 while unset or unreadable); a new value must be a whole number from 0 to 1000. The founder turns `gym_claim_auto_approve` on in production; nobody else flips it.

## The guards

`tryAutoApproveAdminClaim` in `packages/backend/src/graphql/resolvers/social/gym-claims.ts` runs, in order:

1. The setting is on.
2. The per-account rate limit: 3 tries a minute (`gymClaimAutoApprove`).
3. The gym is still owned by the SYSTEM account (an unclaimed synced listing).
4. The five guards in `gym-claim-guardrails.ts` (`firstFailedAutoApproveGuard`):
   - `already_auto_approved`: the account has never had a claim approve itself. A reverted one still counts. One per account, ever.
   - `account_too_new`: the account is at least 30 days old (`users.created_at`).
   - `climber_boards_linked`: no live board owned by another climber is linked to the gym. Such a claim hands someone power over other people's boards, so a person decides. Synced boards and the claimant's own boards don't count.
   - `gym_has_staff`: the gym has no `gym_members` row with role `admin` or `editor`, the claimant's own included. A gym nobody owns but somebody staffs is already run by someone, and the claim would put the claimant over them, so a person decides. Plain members don't count.
   - `daily_cap_reached`: fewer than `gym_claim_auto_approve_daily_cap` claims approved themselves in the last 24 hours.
5. `applyGymClaim(claim, { requireCurrentOwnerId: SYSTEM, autoApprove: true })`. It takes one advisory lock for every auto-approval (`pg_advisory_xact_lock(8043, 1)`), then the gym's row lock, and checks the five guards again under them. Without the lock, two claims on two gyms could both read the count below the cap and both apply. `addGymMember` and `grantGymWriteAccess` write their row under the same gym row lock, so staff can't slip in between the check and the transfer.

Any stop leaves the claim `pending` in the admin queue, exactly as if auto-approval were off: the admin gets the usual queued-claim email and the claimant sees "under review". The reason is logged with the claim id and nothing else (`[GymClaim] Claim left for review instead of approving itself`, `stoppedBy`). A day that hits the cap logs it as a warning.

A claim that approved itself is `method = 'admin'`, `reviewed_by IS NULL`, status `approved` (or `revoked` once reverted). There is no separate column. Its approval time is its `gym_claim_ownership_decisions.decided_at`.

`reviewed_by` is `ON DELETE SET NULL`, so when a reviewer's account is deleted, the claims they approved by hand read as auto-approved from then on. That fails safe: the claimant counts as having used their one auto-approval, the claim counts towards the daily cap, and its gym can fall back into probation if the approval is under 14 days old. Each of those is stricter, never looser.

## Probation

For 14 days after a claim on a gym approves itself, nobody at that gym can:

- delete the gym (`deleteGym`)
- delete the gym's synced boards (the gym-staff branch of `deleteBoard`)
- remove a member (`removeGymMember`)
- take away an editor's access (`revokeGymWriteAccess`), which removes staff just like removing a member
- add an admin (`addGymMember` with role `admin`), because a second account would get round the rest

It binds every owner and admin of the gym. A gym with an admin or editor never approves itself (`gym_has_staff`), so any other admin there arrived after the claim. Global admins are exempt. Editing the gym and its boards, adding members and editors, and taking climbers' boards off the listing all stay open: a revert undoes those, with one gap: a member from before the claim whom the claimant promotes to editor keeps the role after a revert, because the revert removes rows by when they were created. We accept that; an admin removes the editor by hand.

A refusal is a `GraphQLError` with `extensions.code = 'GYM_CLAIM_PROBATION'` and `extensions.endsAt` (ISO time). The message names the day it opens: "For 14 days after a gym is claimed, nobody at it can delete the gym or its synced boards, remove members or add admins. This opens on 7 December 2026."

`UserBoard.canDelete` is false for staff during probation. The board lists read it from one query per list (`loadGymClaimProbations`), never one per row.

Probation ends early when the claimant stops owning the gym: a revert, or an admin handover to someone else. A claim an admin approved by hand starts no probation.

## Revert

`revertGymClaim(input: { claimId, reason })`, global admins only, 10 a minute. `gym-claim-revert.ts`.

`reassignGymOwner` can't undo a claim: it keeps the outgoing owner as a gym admin, and the location sync treats any approved claim as owner-curated (`packages/location-sync/src/upsert.ts`, `isOwnerCurated` and the `claim.status = 'approved'` reads).

### What it will revert

Revert hands a gym back to SYSTEM, so it only undoes a claim on an unclaimed listing that nobody has touched since. Under the gym's row lock it refuses, with a stable `extensions.code`, unless all of these hold:

| Check | Refusal |
|---|---|
| The claim is `approved` | `GYM_CLAIM_REVERT_NOT_APPROVED` |
| The claim and its gym exist and aren't merged | `GYM_CLAIM_REVERT_NOT_FOUND` |
| The claim's `gym_claim_ownership_decisions` row says it moved this gym (`did_transfer`, same gym uuid) | `GYM_CLAIM_REVERT_NOT_TRANSFERRED` |
| The claimant still owns the gym | `GYM_CLAIM_REVERT_OWNER_CHANGED` |
| No later decision row and no later `gym_owner_reassignments` row for the gym, even one that moved it back to the claimant | `GYM_CLAIM_REVERT_OWNER_CHANGED` |
| The owner before the claim was SYSTEM (`gym_claim_ownership_decisions.previous_owner_id`, migration 0336) | `GYM_CLAIM_REVERT_PRIOR_OWNER` |

Every refusal message points the admin at Move gym ownership (`reassignGymOwner`). A claim that took the gym from a real owner needs that owner back, not SYSTEM, so revert would be the wrong tool. A decision row written before migration 0336 has no previous owner; it reads as unknown and is refused the same way. Auto-approvals only ever take a gym from SYSTEM, and they all post-date the column.

### What it does

In one transaction under the gym's row lock:

1. Gives the gym back to SYSTEM.
2. Clears its sync freeze, so the next sync overwrites the name, address and coordinates the claimant may have changed.
3. Keeps the website but clears its owner vouch, so it can't carry a domain claim by the person it was taken from.
4. Sets every `approved` claim on the gym to `revoked` (migration 0335): this one and any older one. The sync reads any approved claim on a gym as owner-curated, so an older approved claim left behind would keep the sync off the gym. The listing state stops counting them too. `reviewed_by` is untouched, so an auto-approval still counts as its account's one.
5. Removes the claimant's membership row and every member or editor added since the approval. Staff from before the claim stay.
6. Writes a `gym_owner_reassignments` row: previous owner the claimant, new owner SYSTEM, the freeze before and after, and the reason. This row also makes any claim filed before the revert read as superseded.

After the commit, best effort, it sends the claimant the in-app `gym_claim_denied` notice (flag permitting) and an email ("We reversed your gym claim"). A notice or email that fails is logged and never undoes the revert. It returns `{ claimId, gymUuid, gymName, removedMemberCount }`.

`addGymMember` and `grantGymWriteAccess` take the same gym row lock before they write, and read the caller's authority again under it. A claimant who passed the gate just before a revert either lands first, and the revert removes the row, or waits and is refused.

`deleteGym` takes the same lock and reads the owner and probation again under it before the soft delete. A claimant who passed the first check just before a revert either deletes the gym first, and the revert finds it gone, or waits and is refused: the gym is SYSTEM's by then.

Not undone: boards the claimant edited, took off the listing or attached from nearby, kiosks they set up, a pre-claim member they promoted to editor, and the gym's description, hours, photo and branding. An admin fixes those by hand.

### The admin screen

`/admin/gym-claims` lists the claims that approved themselves under the pending queue ("Claims that approved themselves", `gym-claim-revert-panel.tsx`), newest first, from `autoApprovedGymClaims(input: { limit, offset, claimId })` (global admins). The list is the claims that are admin-method, unreviewed and moved their gym (`autoApprovedClaimCondition` plus `did_transfer`), approved or already `revoked`, with the claimant's history and `approvedAt` (the decision time). An approved one has **Revert**; a revoked one says Reverted.

Revert opens a confirm that names the gym and the claimant, says what goes back to SYSTEM and what doesn't (board changes, kiosks, the description, hours and photo), and takes an optional reason for the audit row. A refusal keeps the confirm open with its own line, and every line but `NOT_APPROVED` points at Move gym ownership, the panel below it on the same page.

The daily digest's `?revert=<claim id>` opens that claim's confirm straight away, looked up with `claimId` so an approval older than the first page still opens. A claim already reverted, or one that didn't approve itself, gets a line saying so instead. Only a positive whole number is read from the link (`parseRevertParam`). Each link is handled once per visit, and the list and the lookup read the auth token through a ref, so its refresh every few minutes doesn't reopen a closed confirm, clear a typed reason, call a claim just reverted "already reverted", or drop the pages already loaded.

## The daily digest

The "Claims that approved themselves" section of the admin daily digest (`autoApprovedClaimsSection` in `services/directory-report-sweep.ts`) lists every claim that approved itself since the last digest, by approval time: the gym, the claimant's display name, how old their account was when it approved, and the revert link. One already reverted says "(already reverted)". The first 20 are listed; the count covers all of them.

## Admin-path claims expire after 30 days

The hourly `directory-report-sweep` marks admin-path claims still `pending` 30 days after they were filed as `expired` (`expireStaleAdminClaims`).

Only claims filed on or after `GYM_CLAIM_EXPIRY_STARTS_AT` (`2026-11-24T00:00:00Z`, exported from `gym-claims.ts`) expire. Without the cutoff, the first sweep after the deploy would expire the whole backlog of claims older than 30 days at once and email every one of those claimants, with no admin choosing to. The older claims stay `pending` in the queue for a person to approve or deny.

Each one is expired in its own transaction, which writes the claimant's in-app `gym_claim_denied` notice; once committed, the claimant gets an email saying nobody got to it and how to claim again. A claim that fails is counted in the sweep's `failures` and retried the next hour. Domain claims are untouched: their link expires on its own after 24 hours.

## Notices

Both types are directory notices (`directory-reports/notice-types.ts`), so they follow the directory rules: no actor, written only while the `directory-reports` flag is on, and `directoryNotice` carries the gym (and board) names for the client's copy.

| Type | To | When | Copy key |
|---|---|---|---|
| `gym_claimed_with_your_board` | each climber with a board listed at the gym | any claim that moves the gym to a new owner: domain link, admin approval or auto-approval | `items.gymClaimedWithYourBoard` |
| `gym_claim_denied` | the claimant | an admin denies the claim, it expires after 30 days, or it is reverted | `items.gymClaimDenied` |

`gym_claimed_with_your_board`:

- Its entity is the gym. `directoryNotice.boardUuid` / `boardName` name the creator's oldest board there, and `targetKind` is `gym`.
- One per creator, however many boards they have there.
- Only boards the new owner can read count. A private board they can't see gives them no power over it, and a notice would tell its creator someone looked.
- Never for synced boards, the claimant's own boards, or archived spray walls.
- Sent after the transfer commits; a failure to send never undoes the transfer.

Auto-approval needs a gym with no other climber's board, so in practice this notice follows the domain path and admin approvals.

## Claim queue

`pendingGymClaims` returns, per claim, what tells a gym manager from a prankster: `claimantAccountAgeDays`, `claimantTickCount` (every logged climb, attempts included) and `claimantGymsHeld` (live gyms the claimant owns or is an admin of). Three grouped reads per page. The web queue shows them under the claimant's name.

## Verify link errors

When a domain-claim link fails (`used`, `expired`, `superseded`) the redirect to `/gym-claim/error` carries `?gym=<slug or uuid>`, so the page can offer "Back to {gym}". An unknown token names no gym.

## Where it lives

- Guards and probation: `packages/backend/src/graphql/resolvers/social/gym-claim-guardrails.ts`.
- Auto-approval, notices, expiry, queue: `packages/backend/src/graphql/resolvers/social/gym-claims.ts`.
- Revert: `packages/backend/src/graphql/resolvers/social/gym-claim-revert.ts`; the list it reverts from is `autoApprovedGymClaims` in `gym-claims.ts`.
- Admin screen: `packages/web/app/components/admin/gym-claim-revert-panel.tsx` (list, confirm, `?revert=`) and `gym-settings-panel.tsx` (the switch and the daily limit).
- Probation gates: `deleteGym`, `addGymMember`, `removeGymMember`, `revokeGymWriteAccess` in `gyms.ts`; `boardDeleteAuthority` and `viewerMayDeleteBoard` in `boards.ts`.
- Staff writes and `deleteGym` under the gym row lock: `withGymStaffLock` and `deleteGym` in `gyms.ts`.
- Sweep step and digest section: `packages/backend/src/services/directory-report-sweep.ts`.
- Who can claim: `canClaim` in `enrichGym` (`gyms.ts`), `computeClaimableFlags` in `gym-matching.ts`, the `GYM_RUN_BY_STAFF` refusal in `requestGymClaim`, and `gymIdsRunByStaff` in `gym-run-by-staff.ts`.
- Tests: `packages/backend/src/__tests__/gym-claim-guardrails.test.ts`; who can claim in `gym-write-access-and-claims.test.ts`.
