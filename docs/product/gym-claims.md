# Gym claims: auto-approval, probation, revert and expiry

Gym staff claim a gym's listing to manage it. A claim goes one of three ways: a work-email link on a gym whose owner vouched for its website (the domain path), a person in the admin queue (the admin path), or, for an unclaimed synced gym, it approves itself. This doc covers the limits on that last path and what follows it: the guards, the 14-day probation, the admin's revert, the 30-day expiry of admin-path claims, and who is told what.

The product decision is decision 3 in [gym-board-governance.md](gym-board-governance.md). The report flow it builds on, including the daily digest and the `directory-reports` flag, is in [directory-reports.md](directory-reports.md).

Epic #8043, PR 6 of 8.

## Turning auto-approval on

Auto-approval is off until a global admin turns it on. It is two community settings, global scope, both admin-only because of their `gym_` prefix:

| Setting | Default | Meaning |
|---|---|---|
| `gym_claim_auto_approve` | `0` | `1` turns auto-approval on |
| `gym_claim_auto_approve_daily_cap` | `10` | at most this many claims approve themselves in any 24 hours, across all accounts. `0` stops them all; a value that is not a whole number reads as 10 |

The switch is in /admin settings (`gym-settings-panel.tsx`). The cap has no control there yet; until it does, the default of 10 applies, or a global admin sets it with the `setCommunitySettings` mutation. The founder turns `gym_claim_auto_approve` on in production; nobody else flips it.

## The guards

`tryAutoApproveAdminClaim` in `packages/backend/src/graphql/resolvers/social/gym-claims.ts` runs, in order:

1. The setting is on.
2. The per-account rate limit: 3 tries a minute (`gymClaimAutoApprove`).
3. The gym is still owned by the SYSTEM account (an unclaimed synced listing).
4. The four guards in `gym-claim-guardrails.ts` (`firstFailedAutoApproveGuard`):
   - `already_auto_approved`: the account has never had a claim approve itself. A reverted one still counts. One per account, ever.
   - `account_too_new`: the account is at least 30 days old (`users.created_at`).
   - `climber_boards_linked`: no live board owned by another climber is linked to the gym. Such a claim hands someone power over other people's boards, so a person decides. Synced boards and the claimant's own boards don't count.
   - `daily_cap_reached`: fewer than `gym_claim_auto_approve_daily_cap` claims approved themselves in the last 24 hours.
5. `applyGymClaim(claim, { requireCurrentOwnerId: SYSTEM, autoApprove: true })`. It takes one advisory lock for every auto-approval (`pg_advisory_xact_lock(8043, 1)`), then the gym's row lock, and checks the four guards again under them. Without the lock, two claims on two gyms could both read the count below the cap and both apply.

Any stop leaves the claim `pending` in the admin queue, exactly as if auto-approval were off: the admin gets the usual queued-claim email and the claimant sees "under review". The reason is logged with the claim id and nothing else (`[GymClaim] Claim left for review instead of approving itself`, `stoppedBy`). A day that hits the cap logs it as a warning.

A claim that approved itself is `method = 'admin'`, `reviewed_by IS NULL`, status `approved` (or `revoked` once reverted). There is no separate column. Its approval time is its `gym_claim_ownership_decisions.decided_at`.

## Probation

For 14 days after a claim on a gym approves itself, nobody at that gym can:

- delete the gym (`deleteGym`)
- delete the gym's synced boards (the gym-staff branch of `deleteBoard`)
- remove a member (`removeGymMember`)
- add an admin (`addGymMember` with role `admin`), because a second account would get round the other three

It binds every owner and admin of the gym, including admins from before the claim. Global admins are exempt. Editing the gym and its boards, adding members and editors, and taking climbers' boards off the listing all stay open: a revert undoes those.

A refusal is a `GraphQLError` with `extensions.code = 'GYM_CLAIM_PROBATION'` and `extensions.endsAt` (ISO time). The message names the day it opens: "For 14 days after a gym is claimed, nobody at it can delete the gym or its synced boards, remove members or add admins. This opens on 7 December 2026."

`UserBoard.canDelete` is false for staff during probation. The board lists read it from one query per list (`loadGymClaimProbations`), never one per row.

Probation ends early when the claimant stops owning the gym: a revert, or an admin handover to someone else. A claim an admin approved by hand starts no probation.

## Revert

`revertGymClaim(input: { claimId, reason })`, global admins only, 10 a minute. `gym-claim-revert.ts`.

`reassignGymOwner` can't undo a claim: it keeps the outgoing owner as a gym admin, and the location sync treats any approved claim as owner-curated (`packages/location-sync/src/upsert.ts`, `isOwnerCurated` and the `claim.status = 'approved'` reads). In one transaction under the gym's row lock, the revert:

1. Gives the gym back to SYSTEM.
2. Clears its sync freeze, so the next sync overwrites the name, address and coordinates the claimant may have changed.
3. Keeps the website but clears its owner vouch, so it can't carry a domain claim by the person it was taken from.
4. Sets the claim to `revoked` (migration 0335). The sync and the listing state stop counting it.
5. Removes the claimant's membership row and every member or editor added since the approval. Admins from before the claim stay, and so does a real prior owner kept on as admin when the claim applied.
6. Writes a `gym_owner_reassignments` row: previous owner the claimant, new owner SYSTEM, the freeze before and after, and the reason. This row also makes any claim filed before the revert read as superseded.
7. Sends the claimant the in-app `gym_claim_denied` notice (flag permitting) and, after the commit, an email ("We reversed your gym claim").

It refuses a claim that isn't `approved` (`GYM_CLAIM_REVERT_NOT_APPROVED`), a claim or gym that is gone or merged (`GYM_CLAIM_REVERT_NOT_FOUND`), and a gym the claimant no longer owns (`GYM_CLAIM_REVERT_OWNER_CHANGED`; use Move gym ownership instead). It returns `{ claimId, gymUuid, gymName, removedMemberCount }`.

Not undone: boards the claimant edited, took off the listing or attached from nearby, kiosks they set up, and the gym's description, hours, photo and branding. An admin fixes those by hand.

The web screen for it is PR 7. The daily digest already links each auto-approval to `/admin/gym-claims?revert=<claim id>`.

## The daily digest

The "Claims that approved themselves" section of the admin daily digest (`autoApprovedClaimsSection` in `services/directory-report-sweep.ts`) lists every claim that approved itself since the last digest, by approval time: the gym, the claimant's display name, how old their account was when it approved, and the revert link. One already reverted says "(already reverted)". The first 20 are listed; the count covers all of them.

## Admin-path claims expire after 30 days

The hourly `directory-report-sweep` marks admin-path claims still `pending` 30 days after they were filed as `expired` (`expireStaleAdminClaims`). Each one is expired in its own transaction, which writes the claimant's in-app `gym_claim_denied` notice; once committed, the claimant gets an email saying nobody got to it and how to claim again. A claim that fails is counted in the sweep's `failures` and retried the next hour. Domain claims are untouched: their link expires on its own after 24 hours.

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
- Revert: `packages/backend/src/graphql/resolvers/social/gym-claim-revert.ts`.
- Probation gates: `deleteGym`, `addGymMember`, `removeGymMember` in `gyms.ts`; `boardDeleteAuthority` and `viewerMayDeleteBoard` in `boards.ts`.
- Sweep step and digest section: `packages/backend/src/services/directory-report-sweep.ts`.
- Tests: `packages/backend/src/__tests__/gym-claim-guardrails.test.ts`.
