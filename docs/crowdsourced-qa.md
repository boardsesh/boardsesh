# Crowdsourced QA

QA is the bottleneck on merging PRs. This is the loop that lets any tester help: every PR carries a
short test plan and a risk score, testers load a PR's preview in the mobile app, read the plan, and
their verdict lands on the PR as a comment and a label.

Three pieces, landing in this order:

1. **The PR contract** (this doc, on `main`): `## Test plan` + `## Risk` in every PR body, checked
   by CI.
2. **The backend** (`qaPreviews` query, `submitQaVerdict` mutation): serves a PR's plan to the app
   and posts the verdict to GitHub.
3. **The app** (ships with the next native build): a tester is asked on launch to pick a PR
   preview, reads the plan, and files a verdict from the user drawer.

## The PR contract

Every PR description has two sections (they're in `.github/pull_request_template.md`):

```markdown
## Test plan

1. You tab → Log a tick → the note field grows to 8 lines
2. Type 300 characters → the counter turns red at 250

## Risk

Risk: 2/5 — isolated UI, covered by tests
```

Rules, written for the reader (a tester on their phone, with five minutes):

- **1–5 numbered steps.** One action, then what they should see. 12 words or fewer per step.
- Name the screen. Say up front if it needs a board, Bluetooth, or a signed-in account.
- An internal-only change still gets a plan: `1. CI green.` is valid.
- **Risk** is `Risk: N/5 — why`: 1 docs/CI/deps/copy · 2 isolated UI with tests · 3 new screen,
  shared package, resolver · 4 data writes, sync, auth-adjacent, publish pipeline · 5 BLE,
  OTA/native config, migrations with backfill.

### The gate

`.github/workflows/pr-test-plan.yml` runs `vp run check:pr-test-plan` on every human PR, and
re-runs when the description or labels change (`edited`, `labeled`, `unlabeled`) — unlike `ci.yml`,
which never sees body edits. It is its own workflow so a metadata check can't redden `ci-status`
while its non-blocking step also reconciles the `db-migration` label. Bot PRs are exempt from the
body gate. Hard failures: no test plan, no steps, more than 5 steps, a step over 140 characters, no
risk score, a score outside 1–5. Warnings only: a step over
12 words, a bare score with no reason. A maintainer can apply the **`skip-qa-gate`** label to pass a
PR unchecked.

### One parser

`packages/shared/pr-body` (`@boardsesh/pr-body`) owns the markdown section walker and the rule set
(`extractSection`, `parseTestPlan`, `parseRisk`, `validatePrBody`). The changelog generator's
`## Release Notes` extraction (`scripts/lib/changelog-transform.ts`), the CI gate, and the backend
all read PR bodies through it, so a body that passes CI renders the same plan in the app.

## The backend

Two GraphQL operations, both open to any signed-in user (`requireAuthenticated`) — the mobile branch
picker is, so these are too. The `tester` community role still decides exactly one thing: whether a
verdict moves the label. Schema in `packages/shared-schema/src/schema/qa.ts`, resolvers in
`packages/backend/src/graphql/resolvers/qa/`, GitHub I/O in
`packages/backend/src/services/github-qa.ts`.

**`qaPreviews(prNumbers: [Int!]!): [QaPreview!]!`** — the app passes every `pr-<n>` branch it can
load; the backend answers with the ones that are still open PRs, each carrying the title, author,
draft flag, head SHA, the `## Test plan` steps, the `Risk: N/5` score, and the caller's own last
verdict. Closed and unknown numbers are dropped, so the app never has to pre-filter, and an empty
request answers `[]` rather than erroring. At most 50 numbers per call. The PR list is cached for
three minutes and negative-cached for 30 seconds, so each backend instance costs GitHub two calls
per refill (every Railway replica warms its own cache); head-commit dates are cached per SHA and
looked up five at a time, so a cold 50-PR call can't spend a whole anonymous rate-limit budget at
once. GitHub being unreachable returns an empty list, never an error — the app should show "nothing
to test", not a broken screen.

**`submitQaVerdict(input: SubmitQaVerdictInput!): QaVerdict!`** — records the verdict in
`qa_verdicts` and returns it. The branch must equal `pr-<prNumber>`, the PR must be open, and a
`declined` verdict needs a comment of 10 characters or more: a decline is a request for work, so it
has to say what broke. The head SHA and its commit date are stamped from GitHub at write time, which
is what lets the comment flag a verdict filed on a bundle older than the current head.

A verdict does need GitHub, because it has to be placed against a head commit. `readOpenPullRequests`
returns a `failed` flag rather than making the caller guess from an empty list — an unreachable
GitHub says "could not reach GitHub, try again in a minute", while a repo that genuinely has no open
PR says "pull request is not open". Timestamps the app sends (`bundleCreatedAt`) are normalised to
UTC on the way in, since the columns are zone-less and would otherwise store `+02:00` as wall clock
and invert the staleness comparison.

### What lands on the PR

The GitHub mirror runs fire-and-forget after the row is committed. It posts one comment:

```markdown
<!-- boardsesh-qa-verdict:17 -->
### ✅ QA approved by Nic

Filed from the Boardsesh app.

> LEDs light up on every climb

| Field | Value |
| --- | --- |
| Platform | ios |
| App version | 2.3.1 |
| Update id | update-abc |
| Runtime | fingerprint-1 |
| Bundle published | 2026-08-26T09:30:00Z |
| Head SHA at verdict | abcdef1 |
| Verdict id | qa_verdicts.id 17 |
```

Plus, when they apply: `⚠️ Tested an older revision — the bundle was published before the current
head commit.` and `Other verdicts on this head: 2 approved · 1 declined`.

The repo is public, so the comment names the author by Boardsesh display name — a verdict with no
author is worth nothing to the PR author — and carries no email and no user id. Free text goes
through `redactSensitiveText` (`@boardsesh/text-redaction`) first, the same net the bug-report
issues use.

Everything the author can type — their notes, their display name, the version strings the app reports
— is also de-fanged before it goes in, because the comment is Markdown on a public repo. `<!--`
would otherwise open an HTML comment and swallow the device table, `@handle` would notify someone
from an account that isn't theirs, and `#123` would leave a cross-reference on an unrelated issue.
Angle brackets that start a tag are escaped, `@`/`#` tokens are wrapped in a code span, and the
verdict id is written `qa_verdicts.id 17` rather than `#17` for the same reason.

**Labels: the latest TESTER verdict wins.** Each tester verdict adds `qa-approved` or `qa-declined`
and removes the other, so the label on a PR is always the most recent tester call, not a tally. Read
the comments for the history.

Anyone signed in can file a verdict and have it posted as a comment; only a tester's moves the
label, because the label gates a merge on a public repo and an ungated one would let any account
stamp `qa-approved`. Which it was is snapshotted on the row as `qa_verdicts.by_tester` at write time
rather than re-read at label time: a role granted or revoked later must not retroactively rewrite
what a past verdict counted for. That snapshot uses a **strict** role lookup (`readTesterRole`), not
the fail-soft `userIsTester` — a swallowed `community_roles` error would store a real tester's
verdict as a non-tester one with no signal and nothing to repair it from, so the mutation fails and
the app retries instead. Until a tester weighs in, a PR carries no QA label at all — a non-tester's
verdict never clears one a tester set.

The column **defaults to `true`**, which reads backwards until you follow the deploy order.
Migrations run before the backend deploys, and an Instant Rollback leaves the migrated schema
serving the old code (`docs/branch-deploys.md`), so in both windows the *previous*, tester-only
resolver writes rows — and it cannot name this column. Defaulting `false` would record those
legitimate tester verdicts as non-tester and drop them from the label forever. The current resolver
always supplies the value explicitly, so the default only ever applies to old-code writes, which are
tester writes by construction; the same `ADD COLUMN` backfills every pre-existing row for the same
reason. Expand/contract, per the production-migration rule.

### Environment

| Variable          | Default                          | What it does                                                                |
| ----------------- | -------------------------------- | --------------------------------------------------------------------------- |
| `QA_GITHUB_TOKEN` | `FEEDBACK_GITHUB_TOKEN`          | Auth for both halves. Unset → reads go anonymous (60/hr per IP), writes no-op. |
| `QA_GITHUB_REPO`  | `FEEDBACK_GITHUB_REPO`, else `boardsesh/boardsesh` | Which repo to read PRs from and comment on.               |

The token is a fine-grained PAT on `boardsesh/boardsesh` with **Pull requests read+write**, **Issues
read+write**, and **Contents read**.

**Pull requests write is the one that gets missed.** The verdict comment and the label go through
`/issues/{n}/comments` and `/issues/{n}/labels`, but the target is a pull request, and GitHub grants
those on the *Pull requests* permission. Issues write covers creating the two labels in the repo, not
applying one to a PR; Contents read covers the head-commit lookup. So a token that happily opens
bug-report issues still 403s on both writes — while reads keep working, which is the trap: testers
see the PR list, file verdicts, get a success screen, and every verdict lands in the table and
nowhere else. `FEEDBACK_GITHUB_TOKEN` without PR write did exactly that here for a week.

Empty counts as unset for both variables — `.env.development` ships `QA_GITHUB_TOKEN=`, and a
dashboard hands back `''` for a variable someone cleared. Either would otherwise shadow the
`FEEDBACK_*` fallback, and an empty repo would leave the reader asking GitHub for `/repos//pulls`.

### Runbook

Every backend log line for this feature is tagged `[qa]`.

- **A verdict is missing from a PR.** `SELECT * FROM qa_verdicts WHERE github_comment_id IS NULL` —
  those rows were recorded but never mirrored. The row is the record; the comment is a copy. The
  usual cause is a missing or under-scoped token (grep `[qa] no QA_GITHUB_TOKEN`) or a 403
  (`[qa] posting the verdict comment`). The 403 says which it is — GitHub's own reason and the
  permission it wanted are in the log line:
  `responded 403 (Resource not accessible by personal access token; token needs pull_requests=write)`
  is a scope problem, `rate limit exhausted` is not. There is no retry queue: fix the token, and new
  verdicts mirror again. Older rows can be replayed by hand from the table, or the tester can just
  file the verdict again — nothing rejects a second one, and latest wins.
- **Testers see an empty list.** `[qa] open pull request lookup failed` means GitHub said no —
  usually the anonymous 60/hr ceiling on a deploy with no token. It self-heals in 30 seconds once
  GitHub answers.
- **The label disagrees with the comments.** Expected when a PR has several verdicts: the label is
  the latest **tester** one only. A PR whose only verdicts came from non-testers carries comments and
  no label at all — check `SELECT verdict, by_tester FROM qa_verdicts WHERE pr_number = N ORDER BY
  created_at DESC` before assuming the mirror failed.
- **Verdict comment spam.** Filing is open to every signed-in account (only the label is
  tester-gated), so the write surface on the public repo is no longer a curated pool. The limiter is
  10/min per caller (`applyRateLimit(ctx, 10, 'submitQaVerdict')`) and bodies still go through
  `redactSensitiveText` plus Markdown de-fanging, but a determined account can still post. If it
  happens: `SELECT user_id, count(*) FROM qa_verdicts WHERE created_at > now() - interval '1 day'
  GROUP BY 1 ORDER BY 2 DESC` names the source, and the fix is to lower that limit or put
  `requireTester` back on the mutation — the mobile picker keeps working either way, since it degrades
  to bare `pr-N` rows and a read-only brief.
