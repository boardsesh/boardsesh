# Required checks on main

**Status:** active. Ruleset `23720085` was applied on 2026-09-20. The checked-in JSON
is the original creation payload, not a mirror of current live repository settings.
A read-only API check on 2026-11-21 confirmed the active rule still requires
`ci-status` from GitHub Actions (integration `15368`). The observations below are
dated; inspect live settings before relying on them. This PR makes no
repository-settings changes.

## Observed policy on 2026-11-21

The active ruleset exempts Marco (`User`, actor id `1107647`,
`bypass_mode: exempt`) and permits `boardsesh-repo-bot` (`Integration`, actor id
`4098323`, `bypass_mode: always`). It no longer lists the administrator-role
bypass recorded on 2026-10-03. The checked-in payload contains only the bot
actor; it records the payload used when the ruleset was first applied and is
pinned as that payload by `scripts/__tests__/required-checks-payload.test.ts`. It
is not the current live snapshot. Read current state with:

```bash
gh api repos/boardsesh/boardsesh/rulesets/23720085 \
  --jq '{id,name,enforcement,bypass_actors,rules}'
```

The user exemption means this ruleset does not require Marco to pass
`ci-status`. The classic main-protection endpoint now returns HTTP 404
(`Branch not protected`); the repository ruleset remains active. An exemption
is not evidence that a PR is ready. In the PR backlog sweep,
`ready-for-admin-review` is applied only after exact-head CI checks pass or have expected skips, independent
review is clean, valid review threads are addressed, and the branch is
conflict-free. The label records readiness evidence, not merge authorization;
the repository owner makes the final manual admin-merge decision.

## The failure this exists to stop

On #4731 (issue #4758) `gh pr checks` reported zero failures and zero pending
while the `CI` workflow had **never run** on the head commit. GitHub dropped the
`pull_request` event deliveries for that PR — the whole event type, not just
`synchronize` — for about 25 hours across four SHAs. The PR's check rollup was
empty the entire time.

An empty rollup and a green rollup are the same shape:

```
$ gh pr view 4731 --json statusCheckRollup --jq '.statusCheckRollup | length'
0
```

Zero failures. Zero pending. Nothing to click. Any gate that looks for red —
a human skimming, an agent following the "ready to merge" rule in AGENTS.md —
waves it through.

## The fix: one required context

`ci-status` (in `.github/workflows/ci.yml`) is the roll-up job. It `needs:` every
gating job in the workflow and runs with `if: always()`, so it is red whenever
anything is red. Making it a **required status check** on `main` changes what an
absent run means: instead of "no checks, looks fine" the PR reads *Expected —
waiting for status*, and actors subject to the rule cannot merge. That describes
an unverified commit whether the run was dropped, cancelled, or never created.

Two properties keep that honest, both pinned by
`scripts/__tests__/ci-status-rollup.test.ts`:

- every gating job is in `ci-status`'s `needs`. There are currently no exempt
  jobs; the former `test-report` job has been removed.
- the oversized-file check runs inside the required `guards` job without a
  changed-file filter. It used to be a standalone `large-files` job outside the
  roll-up, the gap reported in #4758. Keep the consolidated job: a binary-only
  PR must still run this check, and its failure must reach `ci-status`.

The `required-ci-status` step in `guards` runs both filesystem-backed contracts
on every CI run after installation. It does not use `--changed`: the module
graph cannot relate a workflow-only or ruleset-JSON-only change to these tests.
Their failures therefore reach the required result before a change can merge.

## Why a ruleset and not classic branch protection

When the rule was created on 2026-09-20, `main` had classic branch protection:
one approving review, dismiss stale reviews, require last push approval, and a
bypass for `boardsesh-repo-bot`. Its required-status-check list was unset. That
is historical context for the ruleset choice, not the current protection state;
the full classic-protection endpoint returns HTTP 404 as of 2026-11-21.

The obvious move is to add the check there:

```bash
gh api --method PATCH repos/boardsesh/boardsesh/branches/main/protection/required_status_checks \
  --input - <<'JSON'
{ "strict": false, "checks": [{ "context": "ci-status", "app_id": 15368 }] }
JSON
```

**We do not use that**, for a reason that would have bitten on the first OTA
publish: classic required status checks also gate **direct pushes** to the
branch, and classic protection has no per-actor bypass for them
(`bypass_pull_request_allowances` covers the review requirement only). Four
workflows push commits straight to `main` as the `boardsesh-repo-bot` app:

| workflow | commit |
| --- | --- |
| `mobile-ota-production.yml` | `chore(changelog): refresh from merged PRs [skip ci]` |
| `production-deploy.yml` | `chore(changelog): refresh from promoted OTA [skip ci]` |
| `refresh-acknowledgements.yml` | `chore: refresh acknowledgements + OSS licenses [skip ci]` |
| `mobile-screenshots-android.yml` | the Play-store screenshot set (`commit_to_main` dispatch) |

Three of the four carry `[skip ci]`, so no CI run — and therefore no `ci-status`
check — can ever exist on those commits. The screenshot commit deliberately
omits `[skip ci]` so store metadata publication runs. All four pushes are evaluated
before their commits can report checks, so classic enforcement would reject them.

A **repository ruleset** can express the same requirement with explicit bypass
actors, so the bot keeps pushing and contributors outside those actors must pass
CI. The observed live ruleset also exempts Marco, so its required-check policy
is not limited to the bot's four direct-push workflows. The workflow inventory
above detects literal direct pushes, not every possible use of a bot token. Any
bot merge automation must verify the required checks independently or
migrate the bot's direct writes before removing this exception.

The active *Protect native release tags* ruleset (id `21751146`) still targets
tags, while this CI ruleset targets only `refs/heads/main`.

## Applying it

The original creation payload is checked in at
`.github/rulesets/main-require-ci-status.json` and pinned by
`scripts/__tests__/required-checks-payload.test.ts`. It does not track later edits
to the live ruleset. Inspect live state before changing repository settings; do
not infer live bypass actors from this file or submit it again for an already
existing ruleset.

1. Confirm the GitHub Actions app id the payload pins (it is global, `15368`, but
   verify rather than trust):

   ```bash
   gh api repos/boardsesh/boardsesh/commits/main/check-suites \
     --jq '.check_suites[] | select(.app.slug=="github-actions") | .app.id'
   ```

2. Confirm the live bypass actors and check the direct-push workflows above.
   The original branch-protection snapshot identified `4098323` as
   `boardsesh-repo-bot`; do not infer today's complete exemption policy from that
   old snapshot:

   ```bash
   gh api repos/boardsesh/boardsesh/rulesets/23720085 --jq .bypass_actors
   ```

3. For initial setup only, create the rule with the historical bot-only payload.
   **This file is not a live-settings snapshot. Reapplying it would enforce a
   stricter policy by omitting the observed user exemption. Do not use it
   to recreate or update the existing rule.**

   ```bash
   gh api --method POST repos/boardsesh/boardsesh/rulesets \
     --input .github/rulesets/main-require-ci-status.json
   ```

4. Record the observed protection state before any separately authorized policy
   change, then compare afterward. A missing classic-protection response is HTTP
   404; keep that distinct from the active repository rulesets:

   ```bash
   gh api repos/boardsesh/boardsesh/branches/main/protection > after.json
   gh api repos/boardsesh/boardsesh/rulesets --jq '.[] | "\(.id) \(.name) \(.enforcement)"'
   ```

The original bot-only creation payload requires every non-bot actor to pass
`ci-status`. The observed live rule exempts Marco, permitting his manual merge
without changing this ruleset. Follow the readiness policy above before
exercising that authority.

For an incident, Marco can use the existing user exemption for a manual recovery
merge. Disabling or deleting the ruleset changes repository policy and requires
a separate explicit policy decision.

## When a PR's checks go missing anyway

The ruleset makes the state visible; it does not repair GitHub's event delivery.
First inspect the head commit message: `[skip ci]` also skips `pull_request` runs.
Amend an accidental skip instruction before investigating event delivery.
Check the exact head SHA as well as the PR's displayed checks:

```bash
# 0 = nothing is attached to this PR at all. Not "nothing failed".
gh pr view <n> --json statusCheckRollup --jq '.statusCheckRollup | length'

# Did the CI workflow ever run on this exact commit? Empty array = never ran.
gh run list --branch "$BRANCH" --limit 40 --json name,headSha,conclusion \
  --jq "[.[] | select(.headSha==\"$SHA\" and .name==\"CI\") | .conclusion]"
```

Recovery ladder from #4731, cheapest first:

1. `gh workflow run ci.yml --ref <branch>` — proves the code. A dispatch run
   forces every path filter to `true`, so it runs *more* jobs than the PR run
   would have (`release-notes` and `changelog-owned` inside `guards` are
   `pull_request`-only steps and skip). GitHub does not show `workflow_dispatch` job checks in the PR's checks
   section or count them toward a required status check, even when they run on
   that PR's head SHA ([required-check troubleshooting](https://docs.github.com/en/pull-requests/how-tos/merge-and-close-pull-requests/troubleshooting-required-status-checks#checks-from-some-workflow-jobs-are-not-evaluated)).
   A dispatch therefore does **not** restore `pull_request` delivery or satisfy
   the required `ci-status`; treat it as code evidence, not as a green PR.
2. Close and reopen — did nothing on #4731, and `closed` handlers can fire
   teardown you did not intend (the OTA preview channel) on a PR whose events are
   only partly dead. One attempt at most.
3. **Rebase and `git push --force-with-lease`** — what actually worked. Within
   ~60 s the whole `pull_request` family returned on the new head and the rollup
   went from 0 to 34 checks. Rewriting the branch's lineage is the lever; a
   fast-forward `synchronize` is not.
4. Recreate the PR — last resort, costs the number and the thread.
