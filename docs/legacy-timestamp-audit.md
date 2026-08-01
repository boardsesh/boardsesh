# Legacy timestamp audit (#3909)

`vp run db:audit-legacy-timestamps` collects evidence about Aurora/JSON ticks
whose local wall-clock time may have been relabelled as UTC. It is deliberately
not a backfill:

- there is no `--apply` option, generated SQL, delete, update, or migration;
- the output is an evidence-only JSONL artifact, not an input accepted by any
  Boardsesh command;
- every database read occurs on one reserved PostgreSQL connection in one
  `SERIALIZABLE READ ONLY DEFERRABLE` snapshot, after the command sets and
  verifies `TimeZone=UTC` and a five-minute statement timeout;
- a failed scan leaves no file at the requested output path.

This phase does **not** repair historical rows or close #3909. Release notes for
the audit-only PR are `none`.

## Verified deployment policy is required

The timestamp-normalizer source lineage has six distinct points:

- `8fe79f60d` introduced the JSON importer with the unsafe
  `new Date(naiveTimestamp)` normalizer;
- `79185b916800b866173da01e4ec34743b0015218` fixed naive JSON timestamps on
  March 28, 2026, and is the source revision that must anchor JSON deployment
  evidence;
- `45cef340a` moved the already-fixed JSON importer into `@boardsesh/aurora-sync`;
- `71937db6a` fixed the live Aurora pull and extracted the normalizer shared by
  the live pull and JSON importer;
- `ad4b39c08` made that shared normalizer safe for space-separated timestamps
  carrying an explicit UTC-offset suffix;
- `cdf1406dfb53f1865513fd005d39b13f469a74e1` made the still-active legacy web
  `saveAscent` proxy use the shared normalizer when it writes
  `boardsesh_ticks.origin='native'`; its parent lineage already contains the
  explicit-offset fix above.

These revisions are code provenance, not deployment timestamps. In particular,
the July revisions do not mark the beginning of naive-JSON safety: that line
starts with a verified deployment containing `79185b916...`. A commit
date, merge time, container build time, or migration timestamp must never be
used as the data cutoff. Before running the audit, obtain independently verified
rollout instants from deployment records:

- the last instant at which the old live-pull code is known to have been active;
- the first instant at which all live-pull instances are known to have had the
  fixed code;
- the last verified old and first verified fixed JSON-import deployments;
- the first instant after migration 0156 had completed and every active writer
  stamped `origin` itself;
- the first instant when migration 0146's `updated_at` guard was active and
  every native writer that could still receive traffic independently wrote safe
  UTC timestamps, or had been retired. This includes both GraphQL `saveTick`
  and the legacy web `saveAscent` proxy; no single writer's fix establishes the
  boundary for the others.

The open interval in either writer's last-old/first-fixed pair is an uncertain
rollout cohort. Its rows always abstain. Use a non-secret policy slug that points
a human reviewer to the deployment record; do not put credentials or free-form
incident notes in it.

```sh
vp run db:audit-legacy-timestamps -- \
  --output /secure/new-legacy-timestamp-audit.jsonl \
  --policy-id verified-deploy-record-YYYYMMDD \
  --live-old-code-active-through <ISO-with-Z-or-offset> \
  --live-fixed-code-active-from <ISO-with-Z-or-offset> \
  --json-old-code-active-through <ISO-with-Z-or-offset> \
  --json-fixed-code-active-from <ISO-with-Z-or-offset> \
  --origin-writers-active-from <ISO-with-Z-or-offset> \
  --native-safe-generation-active-from <ISO-with-Z-or-offset>
```

The output must be a new untracked regular file under a real (not symlinked)
directory. Stdout, an existing path, a symlink, or a Git-tracked path is refused.
Tracking is checked in the repository containing the resolved output parent,
even when the command is run from a different repository. An indeterminate Git
probe fails closed. Repository and index probes run with a minimal environment:
inherited `GIT_*` repository, ceiling, index, config, and pathspec controls are
discarded; system/global config is disabled; and the output-relative path is
passed after `--` with literal pathspec handling. The command stages a
mode-`0600` partial file, syncs it, and publishes it with an exclusive hard link
so a racing file is never overwritten.

Database startup is limited to 30 seconds. Inside the transaction, PostgreSQL
aborts any individual statement or cursor fetch that runs for more than 300
seconds. The client separately rejects any awaited database response after 330
seconds and force-closes that connection, covering a network path that cannot
deliver the server timeout. The client timer stops before local group analysis
or artifact writes and starts fresh for every database response, so these are
per-response and per-fetch bounds rather than a total audit deadline. A timeout
removes the partial artifact; rerun the audit to obtain a new complete snapshot.

## What counts as evidence

Candidates and anchors are partitioned by the exact
`(user, board, climb, angle)` key. The analyzer evaluates the complete bipartite
candidate-to-anchor graph for that key before it applies cohort filters. It
streams endpoint degree counts and retains only the sole edge that could be
usable for each candidate, rather than retaining a quadratic edge array. An
edge requires all of the following:

- matching attempt-versus-ascent semantics;
- the same attempt count and mirror flag;
- a timestamp delta within 60 seconds of an explicit current IANA UTC offset;
- a non-detached `kilter_pull` graph anchor or any `native` graph anchor,
  including native rows from before origin writers were verified. A native
  graph anchor is usable evidence only when its origin is independently
  writer-stamped, it was created at or after the verified safe-save instant,
  and its stored `created_at` exactly equals `updated_at`. A Kilter graph anchor
  is usable only when it is writer-stamped, has a source sync stamp, and its
  `updated_at` is not later than `kilter_synced_at`.

The offset allowlist spans `-12:00` through `+14:00` and includes real half- and
quarter-hour zones such as `+05:45`, `+08:45`, and `+12:45`. It is not “every 15
minutes.” A candidate is correction evidence only when both endpoint degrees are
exactly one. Multiple candidates for one anchor, multiple anchors for one
candidate, semantic disagreement, missing anchors, or an uncertain writer rollout
all abstain. An offset observed for one climb is never extrapolated to another
climb, another date, or an entire user, so DST and travel do not need guessed
account-level rules. A historical Kilter row whose `origin` may have come from
migration 0156 remains in the graph so it can make another match ambiguous, but
a clean edge to that row is classified as
`heuristic_only_anchor_abstention`. It cannot become correction evidence, an
aligned control, or a post-fix invariant violation.

Every Aurora/JSON candidate and every non-detached Kilter anchor participates in
the graph before timestamp provenance is judged. That includes rows with a
missing sync stamp, a later local edit, or a JSON placeholder that a live pull
has claimed. They can increase endpoint degree and force
`ambiguous_abstention`. A reciprocal clean edge to an Aurora candidate with
`updated_at > aurora_synced_at`, or to any JSON candidate without the exact
still-synthetic import stamps, is `candidate_timestamp_unverified_abstention`.
An Aurora row with no sync stamp stays in the existing
`rollout_uncertain_abstention` cohort. A clean edge to a Kilter anchor with
`updated_at > kilter_synced_at` (or no sync stamp) is
`kilter_timestamp_unverified_anchor_abstention`. These rows cannot become
correction evidence, aligned controls, or post-fix invariant violations.

Every native row remains in the graph, including rows created before the
origin-writer instant, before the verified safe-save boundary, or with a later
`updated_at`. This preserves its ability to make a match ambiguous. A clean edge
to a pre-origin row is `heuristic_only_anchor_abstention`; a clean edge to a
writer-stamped but pre-safe or edited row is
`native_timestamp_unverified_anchor_abstention`. Neither can become correction
evidence, an aligned control, or a post-fix invariant violation.

For a clean edge:

```text
raw delta = suspect climbed_at - anchor climbed_at
offset    = closest allowed IANA offset within 60 seconds
target    = suspect climbed_at - offset
residual  = raw delta - offset
```

The target deliberately preserves seconds. For example, a `+10:00:17` raw gap
proposes subtracting exactly ten hours, leaving the target 17 seconds after its
anchor and recording `residual_seconds=17`; it does not snap to the anchor.

Definite post-fix live-pull rows that have not been edited since their source
sync, and definite still-synthetic JSON reimports whose exact import-owned
timestamps remain intact, are controls. A reciprocal nonzero match in either
post-fix control cohort is an invariant failure and suppresses **all** effective
correction proposals in the artifact. The detailed pair remains evidence for
investigating the policy or writer, but the summary reports zero effective
proposals.

## Why `created_at` and `origin` are not simple cutoffs

For JSON imports, `created_at` comes from the Aurora export record. It says when
Aurora created that record, not when Boardsesh imported it, so the audit never
uses JSON `created_at` as an import timestamp. A JSON row later claimed by a live
sync gets a real Aurora id and a later sync stamp but retains `origin=json_import`
and may retain the bad `climbed_at`; claimed JSON is therefore included by
origin and remains an ambiguity vertex. The claim intentionally advances
`aurora_synced_at` without advancing `updated_at`, so the ordinary
`updated_at <= aurora_synced_at` edit guard cannot prove that a claimed JSON
timestamp is untouched. A JSON row can support a proposal or control only when
it still has its synthetic id and exact import-owned
`updated_at = aurora_synced_at` stamps. Any claimed, locally edited, or otherwise
unverifiable JSON row stays ambiguity-only.

The synthetic `json-import-*` Aurora id is generated from fields which include
`climbed_at`. A future correction cannot regenerate or silently replace that id
without analyzing idempotency and collision behavior. This audit reports neither
the synthetic nor real Aurora id.

`origin` was writer-stamped only after migration 0156; older values were inferred
from surrogate columns, including a `created_at - climbed_at > 1 hour` heuristic
for Kilter pulls. Migration 0156 did not persist a per-row marker saying whether
it assigned the origin. The database therefore cannot prove that fact directly.
The audit calls a Kilter anchor `writer_stamped` only when its writer-owned
`created_at` is at or after the operator-supplied instant proven to be both after
0156 completion and after every old writer was retired. Earlier rows are
`legacy_origin_may_be_heuristic` and always abstain from a clean match. If that
deployment evidence cannot be obtained, do not choose a guessed historical
boundary; use a conservative later proven instant, accepting that more rows will
abstain.

Live Aurora candidates use the same conservative edit guard as the sync writer:
`aurora_synced_at` must be present and `updated_at` must not be later. A later
`updated_at` proves that some locally editable content changed after the source
sync; the audit has no field history with which to exclude `climbed_at`. A
missing source sync stamp is likewise unverified. Kilter anchors apply the same
rule against `kilter_synced_at`. These edit checks are proposal/control gates,
not graph filters.

Native timestamps need a separate guard. The current GraphQL `saveTick` writer
parses `climbedAt` through `Date.toISOString()` and explicitly assigns one `now`
value to both `created_at` and `updated_at`. It was not the only native writer:
the still-routable Next.js `/api/v1/[board_name]/proxy/saveAscent` endpoint calls
the legacy web `saveAscent` helper, which also inserts `origin='native'`.
Revision `cdf1406dfb53f1865513fd005d39b13f469a74e1` changed that helper from direct
`Date` parsing to the shared `normalizeTimestamp`; the shared helper already
contained `ad4b39c08`'s explicit-offset-suffix fix. That source revision is not
a deployment boundary, and this route is not retired in the audited source.
The route accepts a string while its documented contract requires an
ISO-8601 zone; the normalizer also safely pins Aurora's space-separated naive
form to UTC, but explicitly warns that a zoneless ISO `T` form is host-dependent.
Deployment evidence must therefore establish that every active instance had the
fixed writer and that callers used a supported timestamp form, or establish a
later instant when an unsafe writer/input path was tightened or retired. If
that cannot be proved, the operator must choose a later defensible boundary or
omit native anchors as proposal evidence; a commit timestamp is never enough.

`updateTick` can later replace `climbed_at`; every call explicitly advances
`updated_at`. Migration 0146 also installs
`trg_boardsesh_ticks_set_updated_at`, which advances `updated_at` for
client-visible changes including `climbed_at`, while deliberately ignoring
Aurora/Kilter bookkeeping columns. There is no edit-history column saying which
field changed, and a later `updated_at` must never be interpreted as proof that
the timestamp was normalized safely. The audit therefore accepts only exact
`created_at = updated_at` on a row created at or after the independently
verified all-writers-safe-or-retired boundary. Every other native anchor remains
ambiguity-only. This can create false-negative abstentions after harmless edits,
which is intentional.

Any future apply design must also examine rows adjacent to both the original and
target `climbed_at`. Moving a row can change day/session buckets, first-ascent and
flash ordering, duplicate-natural-key relationships, and downstream grade-model
inputs. `created_at` remains a separate provenance value and must not be shifted
along with `climbed_at` merely to make the two fields look adjacent. The audit
does not resolve those apply-time risks.

## Artifact privacy and integrity

The JSONL contains no database URL, database name, raw user id, comment, session
id, or raw climb/tick UUID. Identifiers are HMAC pseudonyms scoped to the run; the
secret is never written. The same database identifier intentionally receives a
different pseudonym in another run. Aggregate cells from one through four are
rendered as `"<5"`. Pair records contain exact timestamps only where an edge
supplies useful evidence.

The header records:

- the verified policy and its SHA-256 digest;
- source revisions and the exact scan-query digest;
- PostgreSQL snapshot token, server version, transaction settings, and a digest
  of the inspected `boardsesh_ticks` schema;
- the server-observed statement timeout and the client connect/response bounds;
- explicit safety flags recording the candidate/Kilter sync guards, the
  unchanged-native requirement, and the single-artifact scope of the records
  digest.

The final audit summary records whether post-fix controls suppressed proposals.

Every non-runtime record is canonical JSON (recursively sorted keys) and feeds a
streaming SHA-256 digest. `records_digest` stores that digest as an integrity
check for this exact artifact. It is not a reproducible cross-run dataset hash:
the random HMAC secret changes the pseudonyms and pseudonym scope in the hashed
records. Completion time, duration, and random run id are in a separate
`runtime_footer` and do not add further digest variation.

## Query-plan check

The scan uses a transaction-local SQL cursor and awaits each `FETCH FORWARD 500`
response before processing that batch. It completes the batch's local artifact
writes before fetching again, including the final short batch, and retains only
one natural-key group in memory (hard limit 10,000 rows). It performs no per-row
query, uses binary search over time-sorted semantics-compatible anchors, and
stores only linear degree/sole-edge state even when a dense group has a
quadratic number of logical edges. Its stable order follows the leading columns
of `boardsesh_ticks_user_climb_lookup_idx`, with `id` as the final tie-break.

Before a production audit, run the opt-in integration test against a current
**local** migrated database:

```sh
LEGACY_TIMESTAMP_AUDIT_DB_URL=<local-url> \
  vp exec --filter @boardsesh/db -- \
  tsx --test scripts/audit-legacy-tick-timestamps.integration.test.ts
```

It executes `EXPLAIN (FORMAT JSON, COSTS true)` for the exact exported query and
asserts there is no modifying plan node, then exercises the real snapshot
settings. On a production read replica, inspect the same plain `EXPLAIN` (never
`EXPLAIN ANALYZE` on the full scan) for unexpected sequential scans, large disk
sorts, or a row estimate that makes the 500-row cursor unsuitable. Record that
review beside the deployment-policy evidence; do not alter session planner
settings just to force a preferred-looking plan.
