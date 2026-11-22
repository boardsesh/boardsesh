# Gym duplicate audit, 22 November 2026

Production was read at **19:38 UTC** using the documented `boardsesh_readonly`
role, an explicit read-only transaction, and a 30-second statement timeout.
No production records were changed by this audit. The credential stayed in
memory; this report contains no credentials, private contact details, or owner
account identifiers.

## Population and duplicate queue

| Measure | Observed count |
| --- | ---: |
| Live gyms | 4,785 |
| Live public, listed gyms | 4,550 |
| Live public, listed gyms with coordinates and a nonempty slug | 2,911 |
| Candidate clusters within 150 metres | 1 |
| Candidate clusters dismissed by an admin | 0 |
| Unresolved tier A clusters, maximum pairwise distance at most 20 metres | 1 |
| Unresolved tier B clusters, maximum pairwise distance above 20 and at most 150 metres | 0 |
| Duplicate rows in unresolved clusters | 1 |
| Clusters with more than one human owner | 1 |

The audit imported the repository's `groupPhysicalGymCandidates` and
`distanceMeters` functions. It used the same name normalization, deterministic
all-pairs 150-metre clustering, 20-metre tier boundary, and SHA-256 member-ID
signature used by `duplicateGymClusters`. Dismissed signatures were read from
`gym_merge_audit`. The candidate population included all live geocoded gyms,
regardless of ownership or visibility, matching the admin queue.

This proves the state of the existing automatic queue, not the absence of every
possible duplicate. Different names, missing coordinates, and locations farther
than 150 metres apart are outside that detector. Community duplicate reports
are emailed to admins; this audit did not inspect that email inbox.

## Mammoth Board Room

The only unresolved cluster has two public, listed listings **18.54 metres
apart**, both describing **3343 Main St, Suite C2, Mammoth Lakes**. Both are
claimed by different human owners. Each has two linked boards, Kilter and
Tension, and neither has followers, comments, live kiosks, or pending claims.

| Listing | Created | Members | Description |
| --- | --- | ---: | --- |
| [`mammoth-boardroom-2`](https://www.boardsesh.com/gym/mammoth-boardroom-2) | 9 October 2026 | 1 | Lift, climb, love |
| [`mammoth-board-room-46c4b6`](https://www.boardsesh.com/gym/mammoth-board-room-46c4b6) | 22 October 2026 | 0 | None |

The older, more complete listing is the existing ranking's preferred survivor.
That ranking alone does not resolve the ownership conflict: a merge preserves
the survivor's gym ownership and moves the duplicate's linked records. The user
explicitly approved this particular survivor and duplicate during the task:

- Keep `4bbe720d-de50-4b09-a42c-435a4d46197b`, slug `mammoth-boardroom-2`.
- Merge `3c161ab2-4f59-4216-9f81-afb275c8f552`, slug `mammoth-board-room-46c4b6`.

Use the supported authenticated admin `mergeGyms` mutation. The generic
`db:dedupe-gyms` CLI deliberately excludes user-owned gyms and cannot perform
this approved merge. The mutation transfers related records, soft-deletes the
duplicate with its survivor pointer, and records the decision and moved rows in
`gym_merge_audit`. The public route already redirects resolved old slugs
permanently to the survivor.

## Indexing release checks

1. Complete the approved merge and verify the recorded survivor and moved rows.
2. Repeat the read-only queue audit; confirm zero unresolved clusters.
3. Confirm the old Mammoth URL redirects and the survivor serves public content.
4. Confirm the directory and sitemap exclude private, unlisted, and ungeocoded gyms.
5. Enable directory indexing and verify clean canonicals and populated gym sitemap.

The 2,911 candidate count is a pre-merge snapshot, not a guaranteed sitemap
count. Merging the confirmed pair should reduce it by one, before any other
concurrent changes or additional sitemap eligibility checks.

## Privacy finding

The anonymous production `searchGyms` query for `Mammoth` returned the two
geocoded venues and three additional public/listed rows without coordinates or
addresses. The default text-search path currently lacks the proximity path's
location requirement. Keep generic gym search behavior separate from the
public directory: directory rows, directory counts, and sitemap enumeration
must explicitly require a real venue location. Preserve the existing
`gymIsIndexableVenue` rule for public gym pages, including `isListed`.

## Access and reproduction

The approved investigation role and credential location are documented in
`docs/operations/railway-cost-reduction.md`, under **Read-only access for
investigations**. The 1Password item is `RAILWAY Postgres PROD (readonly)` in
vault `Boardsesh`; its concealed `connection string` field supplies the role.
Local repository environment files instead point at the development database.
Read the concealed field into process memory; never copy its value into a
command, repository file, report, or log.
