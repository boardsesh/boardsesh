---
name: sentry-issue-campaign
description: Drive Sentry-derived GitHub issues to merged PRs at scale — pick by priority label, self-assign, plan then implement via subagents, pair adversarial reviews, and shepherd every PR to ready-for-review. Use when asked to "pick up N sentry errors", work `from-sentry` issues, turn a Sentry triage sweep into fixes, or continue an in-flight Sentry fix campaign. Repo boardsesh/boardsesh.
---

# Sentry issue campaign

Turn `from-sentry` issues into merged PRs. The work is orchestration: you pick, claim, delegate,
verify, and shepherd. You rarely write the fix yourself.

## 1. Pick and claim

```
gh issue list --label from-sentry --state open --limit 100 \
  --json number,title,labels,assignees
```

Sort by `priority:P0` → `P1` → `P2`. Take the count asked for, highest priority first.

For each: `gh issue edit <n> --add-assignee marcodejongh`, then post a claim comment naming the
session so parallel automation picks something else. Skip issues already assigned to someone else.

**Before starting any issue, check whether it already has a PR** — `gh issue view <n>` and the
issue's own timeline/linked PRs. A `closed` event ~1s after a PR merge is an auto-close, i.e.
evidence of a fix. Never conclude "no fix exists" from a paginated `gh pr list --state merged
--limit N` sweep; a matching branch can fall outside the page and read as absence.

If a PR exists but is unmerged, the job is **get that PR ready for review**, not start over.

## 2. Plan, then implement

Spawn a read-only planning agent per issue. Require it to **verify the issue's claims against the
code** and say so if the issue is wrong — stale and fabricated issues are common (see §6).

Read every plan yourself and judge it:

- **Solid** → spawn an implementation agent with the plan embedded.
- **Unsure** → spawn an adversarial review of the *plan* before implementing.

Model by complexity: Sonnet for mechanical/bounded work, Opus for crashes, concurrency, data
correctness, security, native code.

## 3. The P2 rule

**A follow-up at P2 or worse gets a fix PR immediately, not just an issue.** File the issue *and*
spawn the implementation agent in the same turn. P3 and below can stay an issue. This applies to
findings you generate yourself — review results, hazards spotted mid-task — not only to tickets
handed to you.

## 4. Standards every agent must meet

Put these in every spawn prompt. They are what makes the output trustworthy at 15-agent scale.

- **Mutation-tested guards.** Revert the fix, watch the test go red, restore, and paste the real red
  output. A guard whose red nobody saw is not a guard.
- **Honesty over green.** An unverified step must be *reported* as unverified. "Guard A's red was
  not confirmed locally; CI is authoritative" is an acceptable report. Dressing it up is not.
- **Commit before mutating.** `git checkout -- <file>` to undo a mutation also reverts uncommitted
  real work in that file. After any such restore, run `git status` and read the diff.
- **Uniquely named scratch files** (`pr-body-<issue>.md`, `mutate-<issue>.py`). Agents share one
  scratchpad directory; PR bodies and mutation scripts have both been silently overwritten
  mid-task. Re-read the published PR body with `gh pr view` after creating it.
- **Verify, don't assert.** Fingerprint impact resolved with `expo-updates runtimeversion:resolve`
  (or the PR's own OTA check), not asserted. Upstream claims read out of `node_modules`, not memory.

Read the diff and the red output yourself before you believe a report.

## 5. PR lifecycle

- Open as **draft**; mark ready once CI is green. Exception: a PR **stacked on another PR** stays
  draft until its base lands — a review against a base about to be rewritten is wasted.
- Label every PR `from-sentry` so PRs and issues filter together.
- `## Risk` must be its own heading with a **separate** `Risk: N/5 — why` line
  (`packages/shared/pr-body/src/risk.ts` regex is `^#{2,3}\s+risk\s*$`). A combined heading fails.
- Scope must be an allowed conventional-commit scope; `commit-lint` reads the **webhook payload**,
  so a rerun reuses the stale title — amend and force-push.
- **Conflicts: rebase and `--force-with-lease` without asking.** GitHub's `mergeable` is computed
  lazily and reads `UNKNOWN`; test locally instead:
  `git merge-tree --write-tree origin/main <branch> | grep CONFLICT`.
- A conflicted PR dispatches **no CI at all** — a PR with no checks may be conflicted, not queued.
- Codex reviews come from `chatgpt-codex-connector[bot]` and **fire when a draft is marked ready**.
  A draft has no codex review because it has never been ready. Promoting a batch triggers a batch
  of reviews; work through them.

When the user relays review feedback, treat it as authoritative input: revert the PR to draft if
the finding is substantive, send the verbatim quote to an agent, and require it to verify the
finding before fixing — reviewers are sometimes wrong about the mechanism while right about the
bug, and their suggested fix can be wrong even when the finding is right.

## 6. Resolving the underlying Sentry issues

Only after the fix has **merged**. Use `resolvedInNextRelease` for anything shipping by OTA (it is
still firing on the current fleet; `resolved` would read as a false claim), `resolved` for backend
work that deploys on merge. Always pass `reason` — the fix PR, the mechanism, and any follow-up.

**Verify the Sentry ID before touching it.** Run `search_issues(query="issue:BOARDSESH-XX")` and
read the error text back. In one sweep, three IDs cited in our own issue bodies pointed at entirely
different, live bugs — resolving on the citation would have closed two real problems and left them
firing. When one grouping swallows many causes, the issue's headline impact belongs to the bucket,
not the sampled error.

## 7. Hazards that cost real time

- **Concurrency.** Backend worker DBs are keyed only by pool id, so two `vp test run --project
  backend` runs corrupt each other. Serialize with `flock /tmp/boardsesh-backend-tests.lock`, scope
  to your own files, and treat CI as the authoritative full run. Better: a test that mocks its
  dependencies and touches no DB runs under a throwaway vitest config omitting
  `globalSetup`/`setupFiles` — no lock, seconds.
- **Load.** Many concurrent agents push the box past load 100, where suites produce a *shifting*
  failure set. A shifting set is contention; a real regression fails the same tests every time.
  Prove it by stashing to a clean tree and re-running.
- **Disk.** `df -h /home` before creating worktrees. Reclaim from `packages/web/.next` in idle
  worktrees; remove your own finished agent worktrees only after confirming the commits are on
  GitHub (`git fetch origin refs/pull/<n>/head`).
- **`vp test` filters are positional**: `vp test run --project mobile <path>`.
  `vp run test:mobile -- <pattern>` **ignores the filter** and runs everything.
- **Squash-merge retarget.** When a stacked PR's base is squash-merged, GitHub moves the base to
  `main` but leaves the head on pre-squash commits — the child silently absorbs the parent's files
  and goes red on blobs that were never its own. Fix: `git rebase --onto origin/main <old-base-tip>`.
- **Parallel PRs in one file.** Checking for *file* overlap is not enough. Two PRs can each pass CI
  against a base without the other and still land a broken `main` — e.g. one moves a constant into
  a shared export while the other hardcodes its old value. After both merge, run the shared suite
  on `main`.

## 8. What to hand back

Surface these rather than deciding them: anything that moves the **native fingerprint** (forces a
TestFlight/Play build and pauses OTA reach), anything needing a **secret or operator action** to
take effect, and anything that **mutates stored user data**. State plainly when a merged fix is
inert until someone acts.
