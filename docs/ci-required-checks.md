# Required checks on main

**Status:** active. Ruleset `23720085` was applied on 2026-09-20. The GitHub Actions app id and repository-bot bypass were verified against GitHub; existing classic branch protection and release-tag rules were preserved.

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
waiting for status*, and the merge is blocked. That is the accurate description
of an unverified commit, and it holds whether the run was dropped, cancelled, or
never created.

Two properties keep that honest, both pinned by
`scripts/__tests__/ci-status-rollup.test.ts`:

- every gating job is in `ci-status`'s `needs`. `large-files` was not, until
  #4758 — it is ungated on purpose (a binary-only PR is the shape it catches), so
  it could fail while the roll-up stayed green.
- `test-report` is the one deliberate omission: it posts a comment with
  `report-fail-on-error: false`, so a reporting hiccup must not block a merge.

## Why a ruleset and not classic branch protection

`main` already has classic branch protection: one approving review, dismiss stale
reviews, require last push approval, and a bypass for the `boardsesh-repo-bot`
app. Its `required_status_checks` is unset (`GET
/repos/boardsesh/boardsesh/branches/main/protection/required_status_checks` →
404).

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
(`bypass_pull_request_allowances` covers the review requirement only). Three
workflows push commits straight to `main` as the `boardsesh-repo-bot` app:

| workflow | commit |
| --- | --- |
| `mobile-ota-production.yml` | `chore(changelog): refresh from merged PRs [skip ci]` |
| `refresh-acknowledgements.yml` | `chore: refresh acknowledgements + OSS licenses [skip ci]` |
| `mobile-screenshots-android.yml` | the Play-store screenshot set (`commit_to_main` dispatch) |

Two of the three carry `[skip ci]`, so no CI run — and therefore no `ci-status`
check — can ever exist on those commits, and the push is evaluated before any run
could report anyway. Classic enforcement would reject all three.

A **repository ruleset** can express the same requirement with a bypass actor, so
the bot keeps pushing and human merges require CI. The bot's `always` bypass also
allows it to merge PRs without CI; it is not limited to the three direct-push
workflows. No repository workflow currently merges PRs with that token. Any future
bot merge automation must verify the required checks independently or migrate the
bot's direct writes before removing this exception.

The classic protection remains unchanged, and the existing *Protect native
release tags* ruleset (id 21751146) targets tags, so the two never overlap.

## Applying it

The payload is checked in at `.github/rulesets/main-require-ci-status.json` and
pinned by `scripts/__tests__/required-checks-payload.test.ts`.

1. Confirm the GitHub Actions app id the payload pins (it is global, `15368`, but
   verify rather than trust):

   ```bash
   gh api repos/boardsesh/boardsesh/commits/main/check-suites \
     --jq '.check_suites[] | select(.app.slug=="github-actions") | .app.id'
   ```

2. Confirm the bypass actor is still the app that pushes to main. `actor_id`
   4098323 is `boardsesh-repo-bot`, read from the branch-protection snapshot:

   ```bash
   gh api repos/boardsesh/boardsesh/branches/main/protection \
     --jq '.required_pull_request_reviews.bypass_pull_request_allowances.apps[] | "\(.id) \(.slug)"'
   ```

3. Create it:

   ```bash
   gh api --method POST repos/boardsesh/boardsesh/rulesets \
     --input .github/rulesets/main-require-ci-status.json
   ```

4. Verify nothing else moved — the classic protection must be byte-identical to
   before, and the tag ruleset must still be there:

   ```bash
   gh api repos/boardsesh/boardsesh/branches/main/protection > after.json
   gh api repos/boardsesh/boardsesh/rulesets --jq '.[] | "\(.id) \(.name) \(.enforcement)"'
   ```

Ruleset bypass is explicit: repository administrators are subject to this rule,
even though classic protection has `enforce_admins: false`. Administrators cannot
merge or push an unverified commit to `main` without changing the ruleset.

For an incident, first find its id with
`gh api repos/boardsesh/boardsesh/rulesets --jq '.[] | {id,name,enforcement}'`.
An administrator can temporarily disable the rule with
`gh api --method PUT repos/boardsesh/boardsesh/rulesets/<id> -f enforcement=disabled`.
Restore `enforcement=active` after recovery. Removing the ruleset altogether uses
`gh api --method DELETE repos/boardsesh/boardsesh/rulesets/<id>`.

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
   would have (`release-notes` and `changelog-owned` are `pull_request`-only and
   skip). It does **not** restore `pull_request` delivery and it does **not**
   attach to the PR's rollup, so the required `ci-status` context stays
   unsatisfied and the PR still cannot merge. Treat it as evidence, not as a
   green PR.
2. Close and reopen — did nothing on #4731, and `closed` handlers can fire
   teardown you did not intend (the OTA preview channel) on a PR whose events are
   only partly dead. One attempt at most.
3. **Rebase and `git push --force-with-lease`** — what actually worked. Within
   ~60 s the whole `pull_request` family returned on the new head and the rollup
   went from 0 to 34 checks. Rewriting the branch's lineage is the lever; a
   fast-forward `synchronize` is not.
4. Recreate the PR — last resort, costs the number and the thread.
