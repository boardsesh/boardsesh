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

Schema: `packages/db/drizzle/0216_climb_reports_hide.sql` adds the `hide` value to the `proposal_type`
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

**A setter who also ticked their own climb gets one notification, not two** — the setter row wins
(`mergeProposalCreatedRecipients`). The reporter never notifies themselves.

Clients need to word the setter row differently per report kind, so `Notification` and
`GroupedNotification` carry `proposalType` alongside `proposalUuid`.

**An approved `hide` writes no feed item.** "X hid a climb" in a follower's feed is a moderation
outcome, not activity worth surfacing; everyone with a stake already got a notification.
`isHideProposalEvent` in `events/notification-worker.ts` gates the fan-out on both the worker path and
the inline (no-Redis) path.

---

## Mobile (PR B)

Not built yet. The planned entry points:

- **Report climb** in the climb menu — a sheet asking hide-or-grade plus a reason.
- **More → Moderation** — the open-reports feed, `browseProposals(input: { types: [hide] })`.
- **Community section** on a hidden climb — says it is hidden and why, with the report thread.
- **Notification deep link** — a `proposal_on_your_climb` row opens the report on the setter's climb.
- **Kill flag** `climb-moderation-kill` — a server flag that fails closed, hiding every moderation
  entry point without a store release. See `docs/feature-flags.md`.

---

## Related docs

- `docs/entity-structure.md` — the `climb_proposals` / `proposal_votes` / `community_roles` tables
- `docs/ui/17-notifications.md` — notification rows and their copy
- `docs/board-snapshots.md` — the v5 snapshot schema and the stale-artifact fallback
- `docs/sync-table-manifest.md` — which `board_climbs` columns reach an offline client
