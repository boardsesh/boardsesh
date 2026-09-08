# Climb moderation: reporting and hiding climbs

Anyone can report a climb. Two things a report can ask for:

- **Hide it** — a duplicate, a joke entry, a climb that doesn't exist on the wall, something abusive.
- **Fix its grade** — the stored grade is wrong at this angle.

Both land as a `climb_proposals` row, so a report is not a second moderation system bolted next to
proposals: it is the proposal system with a one-tap entry point and a comment carrying the reason.
Reports are resolved by the same weighted vote every proposal is.

Feature issue: #5049.

---

## The report flow

`reportClimb(input: ReportClimbInput!): ReportClimbResult!`
(`packages/backend/src/graphql/resolvers/social/proposals/mutations.ts`)

```
                    reportClimb(climbUuid, boardType, angle?, kind, proposedGrade?, reason)
                                              │
                             advisory lock on (climbUuid, type)
                                              │
                          ┌───────────────────┴───────────────────┐
                  open proposal matching?                  no open match
                          │                                        │
              ┌───────────┴───────────┐                   open a proposal
      you already voted          first time                 + proposer vote
              │                       │                     + your comment
     status: already_reported   add weighted upvote               │
        (nothing written)        + your comment            status: created
                                        │
                                  status: added
```

| `status`           | What happened                                          | Client reads it as                       |
| ------------------ | ------------------------------------------------------ | ---------------------------------------- |
| `created`          | You opened the report; your vote is the first one       | "Reported. The community will review it." |
| `added`            | You joined an open report; your vote and reason landed  | "Added to N existing reports."            |
| `already_reported` | You had already reported this; nothing was written      | "You've already reported this climb."     |

`already_reported` is a success, not an error — a client retry (a flaky connection, a double tap)
can never inflate the tally.

**Auto-approval runs on all three paths, `already_reported` included.** A retry whose vote committed
but whose approval did not is exactly the case where a proposal sits at threshold with nobody left to
carry it over. The tally is idempotent and the `open → approved` flip is guarded on `status = 'open'`
under the proposal lock, so a duplicate report can never approve twice. Only the comment fan-out and
the vote event are suppressed on that path — those describe writes that did not happen.

**One vote and one comment per user per report.** The vote is the tally; the comment is the reason,
and every reason hangs off the same proposal so a moderator reads one thread instead of five
near-identical rows. A report deliberately does **not** publish `comment.created`, so reasons stay
out of the activity feed.

### Join vs supersede

`findOpenProposal` (`lifecycle.ts`) matches on `(climbUuid, boardType, type, angle, proposedValue,
status = 'open')`:

- **hide** — angle is always `null` and `proposedValue` is always `'true'`, so every hide report on a
  climb joins the one open hide proposal. That is the point: five people reporting the same duplicate
  is one report with five votes.
- **grade** — joins only when the proposed grade label matches. Reporting `V5` on a climb with an open
  `V6` report opens a new proposal and **supersedes** the `V6` one, exactly as `createProposal` does.
  One open question per facet at a time, or votes split across rival proposals and neither clears the
  threshold.

### Rate limit and validation

5 reports per window (`applyRateLimit(ctx, 5, 'reportClimb')`). `reason` is required, 10–500
characters (`ReportClimbInputSchema`). `angle` is required for a grade report and ignored for a hide.
A frozen climb refuses reports like it refuses proposals.

---

### Why the reason is stored twice

`reportClimb` writes the reporter's reason to `climb_proposals.reason` **and** as a comment on the
proposal. The column is the proposal's own headline (what the web card, the feed card and the
notification enrichment read without a join); the comment thread is the record every reporter
appends to, so "who said what" is one list. Nothing edits either after the fact — comments on a
proposal have no edit path in the app, and `reason` is only ever overwritten by `resolveProposal`
when a moderator supplies a resolution note. If you add an edit path, update both or drop the
column; do not rationalise one away without the other.

## Approval

Reports use the same threshold as every other proposal: **5 weighted upvotes**, with vote weight from
`@boardsesh/community-roles`:

| Role               | Weight |
| ------------------ | ------ |
| `admin`            | 3      |
| `community_leader` | 2      |
| everyone else      | 1      |

So two admins carry a report on their own; five ordinary climbers do the same. The threshold is
tunable per climb, per board, and globally through `community_settings` (`key = 'approval_threshold'`,
`scope` = `climb` | `board` | `global`); the resolution order is climb → board → global → the built-in
`5` in `resolvers/social/community-settings.ts`. Admins and community leaders can also resolve a
report outright with `resolveProposal`.

The threshold is resolved **before** the proposal lock is taken (`resolveApprovalThreshold` in
`proposals/grade-analysis.ts`); only the vote sum runs inside it (`checkAutoApproval`). The settings
cascade reads through the `db` singleton, so resolving it under the lock would hold a second pool
connection while the first was still checked out — ten concurrent reports and the (max 10) pool
deadlocks. The threshold is config, not tally state, so reading it a moment early changes nothing.

Roles are board-scoped or global: a `kilter`-scoped `community_leader` carries no extra weight on a
Tension report. The rules are pure functions in `packages/shared/community-roles/` so the backend and
both clients reach the same verdict from the same rows.

---

## The `hide` proposal

| Field           | Value                                                       |
| --------------- | ----------------------------------------------------------- |
| `type`          | `hide`                                                       |
| `angle`         | always `null` — a hide is about the climb, not one angle     |
| `proposedValue` | `'true'` to hide, `'false'` to unhide                        |
| `currentValue`  | the climb's current `is_hidden`, as `'true'` / `'false'`      |

**Unhiding** is a `hide` proposal with `proposedValue = 'false'`, approved the same way. An admin can
also `deleteProposal` an approved hide: the revert in `effects.ts` falls back to whatever the previous
approved hide decision said, and with none, the climb goes back to visible.

### What approval does

`applyProposalEffect` writes `board_climbs.is_hidden = true` and stamps `hidden_at`. It does **not**
touch `updated_at` / `sync_seq` — the `trg_board_climbs_set_sync_fields` BEFORE UPDATE trigger
(migrations 0144/0146) bumps both, which is what carries the hide into the offline delta pull.

Schema: `packages/db/drizzle/0220_climb_reports_hide.sql` adds the `hide` value to the `proposal_type`
enum, `proposal_on_your_climb` to `notification_type`, and `is_hidden` / `hidden_at` to `board_climbs`.

### Offline clients

`board_climbs.is_hidden` ships to the on-device SQLite mirror as schema **v5**
(`packages/shared/offline-sync/src/db/migrations.ts`), stored as a nullable INTEGER because it arrives
by `ALTER TABLE` on existing databases rather than in the v1 `CREATE`. Local queries therefore read it
as `COALESCE(c.is_hidden, 0) = 0`, so rows pulled before the column existed behave as visible until the
next delta refreshes them.

A v5 client meeting a v4 board snapshot rejects the artifact (`SnapshotSchemaStaleError`) and crawls
the scope page by page instead — one night of slower first downloads until the nightly export rebuilds
the snapshots at v5. See `docs/board-snapshots.md`.

---

## Where a hidden climb disappears from

The predicate lives in one place: `hiddenClimbCondition` in
`packages/db/src/queries/climbs/create-climb-filters.ts`, mirrored offline in
`packages/mobile/src/db/queries/search-climbs-local.ts`.

**Filtered** — every browse surface: climb lists and their counts, search without a name, the activity
feed, recommendations, similar-climb discovery, setter stats, the sitemap.

Three of those read `board_climbs` through their own join rather than through `hiddenClimbCondition`,
so they carry their own copy of the rule:

| Surface                                                                                       | How it filters                                                                                             |
| --------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `followingAscentsFeed` / `globalAscentsFeed` (`resolvers/social/feed.ts`)                       | `is_hidden IS NOT TRUE` in the WHERE. `IS NOT TRUE`, not `= false`: `board_climbs` is LEFT JOINed there, and a tick whose climb row is missing must keep rendering as "Unknown Climb". |
| The setter front door, `/setter/[setter_username]` (`server-setter-data.ts`)                    | `is_hidden = false` inside `visibleSetterClimbsWhere`, so the list, the paged count and the JSON-LD all agree. It is an indexable page, so a hidden climb must not come back through it. |
| The MoonBoard sitemap config count (`lib/seo/sitemap/board-config-source.ts`)                    | `is_hidden = false` in the grouped count, so a layout whose only listed climbs are hidden drops its board URL instead of shipping one over zero climb URLs. |

**Not filtered:**

| Surface                          | Why                                                                              |
| -------------------------------- | -------------------------------------------------------------------------------- |
| An explicit name search          | Typing the name means you already know it exists — the setter checking on their own climb, a moderator confirming the hide landed. Filtering it reads as data loss. |
| Opening a climb by uuid          | A direct link keeps working, so a report's own deep link resolves.                |
| The setter's own **My climbs**   | You never lose sight of something you set.                                        |
| The duplicate-publish gate       | A hidden duplicate still has to block a new identical climb, or the wall fills up with re-publishes of the thing the community just hid. |

The offline mirror and the server rule must agree, or an offline search shows what the online one
hides.

---

### Already fanned-out feed rows

`activityFeed` reads the materialised `feed_items` table, so a tick or "new climb" row fanned out
**before** the climb was hidden would otherwise keep showing in followers' feeds. Every tick, climb
and proposal row carries the climb's uuid in its `metadata`, and the read excludes rows whose climb
is currently hidden (`NOT EXISTS … board_climbs.is_hidden`). Nothing is purged, so an unhide brings
the rows straight back. The write side is also guarded: a hide approval fans out nothing.

## Notifications

| Type                     | Who gets it                                | When                                    |
| ------------------------ | ------------------------------------------ | --------------------------------------- |
| `proposal_on_your_climb` | The climb's setter                          | Someone reports or proposes on their climb |
| `proposal_created`       | Everyone who has ticked the climb           | A proposal opens on it                  |
| `proposal_vote`          | The proposer                                | Someone votes on their proposal         |
| `proposal_approved`      | The proposer and every upvoter              | It clears the threshold or is resolved  |
| `proposal_rejected`      | The proposer                                | A moderator rejects it                  |

A climb points at a Boardsesh account two ways, and `resolveClimbSetterRecipients`
(`packages/backend/src/events/recipient-resolution.ts`) handles both: climbs authored on Boardsesh
carry the user id in `board_climbs.user_id`; Aurora-synced climbs only carry the Aurora account number
in `board_climbs.setter_id`, matched against `aurora_credentials.aurora_user_id` for that board type.

That match is restricted to a **live** claim — `sync_status` in (`pending`, `active`, `error`), i.e.
anything but `expired`. It is the same set `assertNoConflictingAuroraOwner`
(`services/aurora-credentials.ts`) lets a re-linker step over, so one Aurora account number can carry
an abandoned row beside the current owner's. Matching on the number alone would tell whoever used to
hold that login about every report on a stranger's climbs.

**A setter who also ticked their own climb gets one notification, not two** — the setter row wins
(`mergeProposalCreatedRecipients`). The reporter never notifies themselves.

Clients need to word the setter row differently per report kind, so `Notification` and
`GroupedNotification` carry `proposalType` alongside `proposalUuid`.

**An approved `hide` writes no feed item.** "X hid a climb" in a follower's feed is a moderation
outcome, not activity worth surfacing; everyone with a stake already got a notification.
`isHideProposalEvent` in `events/notification-worker.ts` gates the fan-out on both the worker path and
the inline (no-Redis) path.

---

## Mobile

Four entry points, all behind one flag.

- **Report climb** — long-press a climb row, or the ⋮ button, or the play drawer's climb menu. The
  sheet asks hide-or-grade plus a reason (10–500 characters, the server's own bound) and calls
  `reportClimb`. The three `status` values come back as three different toasts; see the table above.
- **More → Moderation** — the feed (`app/moderation.tsx`, one root-stack modal), in its own
  "Community" More-tab section so it is reachable signed-out too (voting prompts a sign-in). It
  pages `browseProposals` twenty at a time, open
  proposals first, over **every** type (hide, grade, classic, benchmark) with two filters: Open / All
  and This board / All boards (default: the active board). Each card shows the climb (tap opens the
  preview, long-press the climb menu), the type line, the proposer's quoted reason with the other
  reporters' reasons loaded lazily from the proposal's comment thread, the weighted tally, and
  Support / Oppose toggles (`voteOnProposal`, optimistic, same value again clears the vote).
  Admins and community leaders for the proposal's board (`@boardsesh/community-roles`) also get
  Approve / Reject behind a confirm. A `proposalUuid` route param highlights that card and scrolls
  to it once; when it is not in the first page the screen pins it from `climbProposals` instead.
  `packages/mobile/src/components/moderation/` plus the leaf hooks `use-browse-proposals.ts`,
  `use-vote-on-proposal.ts`, `use-resolve-proposal.ts`, `use-my-roles.ts`. All those caches share
  the `['proposals']` key prefix, so a vote or a decision anywhere refreshes the community section.
- **Community section** in the play drawer — the moderation status sits above the stats, so a hidden
  climb explains itself the moment you open it rather than after you go looking. Three blocks, in
  order: the approved hide (its reason, the reporters' reasons from the proposal's comment thread,
  and whether the crew's votes or a moderator settled it), an open hide report with its vote tally,
  and any open grade proposal **for the angle being played**. Each block ends with a link into
  Moderation. `packages/mobile/src/components/play-drawer/ClimbModerationStatus.tsx`; the reduction
  from raw proposals to those three blocks is the pure `moderation-status.ts` beside it.
- **Notification deep link** — every `proposal_*` row that carries a `proposalUuid` opens the
  Moderation feed on that proposal, passing `proposalUuid` plus `climbUuid` / `boardType` when the
  row has them. Same `/moderation` push from the Home bell and from the You tab — the feed is one
  root route, so there is no tab to pick. A row with no `proposalUuid` still opens the plain climb,
  and marking the group read happens first either way (`use-notification-navigation.ts`).
- **Kill flag** `climb-moderation-kill` — a mobile PostHog flag read as a kill switch: an unresolved
  read means enabled, and only `true` hides every moderation entry point, without a store release.
  See `docs/feature-flags.md`. With the kill on, the notification row falls back to the climb, so a
  closed feed is never a dead tap.

### Three rules that bite

**The moderation feed is ONE root-stack modal**, `app/moderation.tsx`, registered next to
`share-beta` / `boards` with `presentation: 'modal'`. Every entry point pushes the same
`/moderation` route: the More row, a proposal notification from either tab, and the play drawer's
Community section. That last one is the reason for the shape — the drawer lives inside `/play`,
itself a root `transparentModal`, so a push aimed at a tab stack lands *beneath* the player: a dead
tap and a screen nobody can reach (`docs/mobile-sheets-vs-routes.md`, "Pushing a route from INSIDE
a modal route"). A copy of the feed in each tab stack was the first shape and it had exactly that
bug.

**`proposedValue` on a grade proposal is a raw `Grade.name`** — `"6b/V4"`, the same string
`board_climbs.difficulty` holds, never a formatted label and never a `difficulty_id`. Format it for
display with `useGradeFormat().formatGrade`, which honours the reader's V / Font preference, and send
it back unformatted. A `hide` proposal's `proposedValue` is the string `'true'` or `'false'`.

**`is_hidden` is filtered on device too.** `packages/mobile/src/db/queries/search-climbs-local.ts`
drops hidden climbs with `COALESCE(c.is_hidden, 0) = 0` — except on a name search, matching the
server's rule exactly (see "Where a hidden climb disappears from"). Opening a climb by uuid never
filters. That is why the list row shows a "Hidden" chip and the play-drawer header a caption: the
surfaces that still show a hidden climb have to say why it stopped appearing everywhere else.

---

## Related docs

- `docs/entity-structure.md` — the `climb_proposals` / `proposal_votes` / `community_roles` tables
- `docs/ui/17-notifications.md` — notification rows and their copy
- `docs/board-snapshots.md` — the v5 snapshot schema and the stale-artifact fallback
- `docs/sync-table-manifest.md` — which `board_climbs` columns reach an offline client
