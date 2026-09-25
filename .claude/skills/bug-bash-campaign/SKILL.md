---
name: bug-bash-campaign
description: Run a multi-agent bug bash — pick a batch of open bugs by priority label, claim them, investigate then implement via subagents, pair adversarial reviews, and shepherd every PR to ready-for-review for Marco to merge. Use when asked to "do a bug bash", "pick up N bugs", "run a batch of P1s", "continue the bug loop", or to adopt stale in-flight fix PRs. For `from-sentry` issues, also follow `sentry-issue-campaign`. Repo boardsesh/boardsesh.
---

# Bug-bash campaign

Turn a batch of open bugs into ready-for-review PRs. The work is orchestration: you pick, claim,
delegate, judge, and shepherd. You rarely write the fix yourself, and you never merge.

Name the loop at the start (e.g. `bugbash42`). The name goes in claim comments, scratch
directories and the closing campaign memory.

## 1. Pick

```
gh issue list --label bug --state open --limit 200 \
  --json number,title,labels,assignees,createdAt
```

Order: `priority:P0` → `P1` → `P2` → `P3`, then **newest first** within a label, and
`from-sentry` ahead of the rest on ties. Take the batch size the user asked for (default 10). Skip
issues assigned to someone else, and skip admin-only work (secret rotation, GitHub settings) since
it has to go back to Marco anyway.

**Prior-art scan before claiming.** A matching fix often exists under a branch name with no issue
number in it.

- `gh pr list --state all --limit 200 --json number,title,body` and grep the **bodies** for the
  issue number. Grepping titles or branch names alone has missed real fixes.
- `gh issue view <n>`: a `closed` event about 1 s after a PR merge is an auto-close, which means
  the fix already landed.
- `find /tmp ~/projects/boardsesh -maxdepth 1 \( -name 'boardsesh-*' -o -name 'wt-*' \)`: another
  loop checked out on this issue has effectively taken it. (`find`, not `ls` with globs: zsh
  aborts on a glob that matches nothing.) Adjust `~/projects/boardsesh` to wherever your checkouts
  live.

If a PR already exists but is unmerged, the job is to get **that** PR ready, not start over.

## 2. Claim

```
gh issue edit <n> --add-assignee @me
gh issue comment <n> --body "🤖 Claimed by bug-batch loop \`<loop>\` (batch <N>, session <id>)"
```

A claim with no PR after about 10 days has lapsed. Reclaim it with a note. Some parallel loops
ignore claims entirely, so commit and push early: a pushed commit survives another loop rewriting
your worktree.

## 3. Investigate

One read-only investigator per issue. Scope the prompt as **two-phase up front**: "investigate now;
implement only after coordinator approval". Never write "PLAN ONLY — do not modify files": the
permission classifier binds the agent's whole session to that boundary, and neither a later
message nor a fresh implementer spawn can lift it cleanly.

Tell the investigator that these are **good answers**: _already fixed on main_, _duplicate_,
_cannot reproduce_, _the ticket misdiagnoses the cause_. In one 30-issue campaign, 6 were stale,
duplicated or overstated. Require it to check the issue's claims against the code.

Keep prod-DB reads out of subagent prompts. A local dev-DB `EXPLAIN` is fine. Put prod queries in
the PR body as a read-only checklist for Marco.

## 4. Judge the plan

Read every plan yourself.

- **Solid** → spawn the implementer with the plan embedded.
- **Unsure, large, or reframes its own issue** → run an adversarial review of the _plan_ first. In
  moarbugs10000 this found a blocker the author had missed in 4 plans out of 4: an advisory lock
  that cannot work on a pooled client, a root cause that telemetry contradicted, a cache lock that
  does not exist, and a rollout step that could not run.

Model by risk: Sonnet for bounded or mechanical work (copy, i18n, tests, small UI). Opus for
concurrency, data correctness, security, sync and native code. Pair every implementer with a
reviewer.

## 5. Implement

Worktree per issue, as a sibling of the repo checkout (`~/projects/boardsesh/` on the dev box;
adjust to wherever your checkouts live), off fresh `origin/main`:

```
git fetch origin main
git worktree add -b fix/<issue>-<slug> ~/projects/boardsesh/wt-<issue> origin/main
```

Never under `/tmp` or `.claude/worktrees/` (the mobile bundle check needs a sibling worktree).

**Paste this block into every implementer prompt**, replacing `<scratchpad>` with the absolute path
of your session's scratchpad directory (Claude Code names it in the system prompt; subagents share
it; with none, use `${TMPDIR:-/tmp}/<loop>`) and `<issue>`/`<loop>` with real values:

> - Prove each guard fires: revert the fix, watch the test go red, restore, and paste the real red
>   output. A new lint rule or checker needs a deliberately broken fixture.
> - Report any unverified step as unverified. "CI is authoritative for X" is fine; claiming green
>   you did not see is not.
> - Commit before mutating code to test a guard. `git checkout -- <file>` also throws away
>   uncommitted real work.
> - Scratch files go in `<scratchpad>/<issue>-<loop>/` with unique names. The shell has
>   `noclobber` on, so write files with the Write tool or `>|`, never bare `>`. Read the file back
>   right before `--body-file`, and re-read the published PR body with `gh pr view`.
> - Run tests in the FOREGROUND with generous timeouts. Do not start background tasks or monitors
>   and wait on them.
> - Local checks are scoped only: `vp check` on touched files, `vp run typecheck:backend|shared|db|mobile`,
>   one targeted test file. No full backend suite and no `typecheck:web` (it runs a Next build);
>   several of those at once exhaust the box's memory. Push a draft and let CI run the full sweep.
> - Read upstream behaviour out of `node_modules`, not memory. Resolve fingerprint impact with
>   `vp exec expo-updates runtimeversion:resolve` or the PR's OTA check; never assert it.

Read the diff and the red output yourself before believing a report. If an agent stalls twice,
stop resuming it: check `git status`, validate its edits, and land them from the main session.

## 6. PR lifecycle

- Open as **draft**; mark ready once CI is green and no review threads are open. A PR stacked on
  another stays draft until its base lands.
- The body carries the template's `## Release Notes`, `## Test plan` (what a tester taps and sees,
  1–5 steps) and a `## Risk` heading with a **separate** `Risk: N/5 — why` line.
- Title scope must be an allowed conventional-commit scope. `commit-lint` reads the webhook
  payload, so a rerun keeps the stale title: fix the title (and amend if needed), then push.
- Native-fingerprint changes target `release/next` with a `[native-train]` title, not `main`.
- Conflicts: rebase and `git push --force-with-lease` without asking. Check with
  `git merge-tree --write-tree origin/main <branch> | grep CONFLICT`, since GitHub's `mergeable`
  often reads `UNKNOWN`. A conflicted PR dispatches no CI at all.
- When many stacked branches fan out CI, cancel every run except `Claude Code Review` after each
  push. One PR alone can run CI normally.
- Codex reviews (from the `chatgpt-codex-connector[bot]` GitHub App) fire when a draft is marked
  ready. Work through them.

## 7. Review gates

- **Fable review** for any diff touching BLE (`packages/shared/ble-protocol/`,
  `packages/mobile/src/lib/ble/`, `packages/mobile/modules/live-activity/ios/`) **or** any PR that
  moves the native fingerprint. That means a read-only reviewer subagent with `model: "fable"` that
  posts its review on the PR. It is not a person.
- **Visual or rendering changes** (board art, hold colours, contrast) need before/after
  screenshots and a comment tagging @marcodejongh for sign-off.
- Post review findings onto the PR as soon as they arrive. Marco can merge while a review is still
  running, and findings batched to the end land against `main`.
- A reviewer can be right about the bug and wrong about the mechanism or the fix. Have the
  implementer verify each finding before acting on it.

## 8. Hand back, never merge

Marco reviews and merges. A merged PR showing `mergedBy=marcodejongh` with
`reviewDecision=REVIEW_REQUIRED` is normal here (an author cannot approve their own PR). It does not
mean a loop self-merged.

Surface these rather than deciding them:

- anything that moves the native fingerprint;
- anything needing a secret, env var or operator action to take effect;
- anything that mutates stored user data (backfills, dedup migrations), including prod counts it
  needs first;
- genuine product forks: post options plus a recommendation on the issue;
- fixes that are inert until someone acts. Say so plainly.

A follow-up you find at P2 or worse gets a fix PR in the same turn, not just an issue.

## 9. Hazards

The Sentry skill's "Hazards that cost real time" section covers the backend test-DB lock,
load-induced shifting failures, disk and inode exhaustion, squash-merge retargets and parallel
PRs in one file. The bug-bash additions:

- **One heavy job at a time on the box.** `vp check` leaves a ~2 GB `tsgolint` behind
  (`pkill -f tsgolint || true`). Don't pair a background job with a separate waiter.
- **`vp` output cross-contaminates worktrees.** Read the paths in a failing log before trusting a
  red.
- **Resumed worktrees:** origin may be ahead of your local branch. Diff both directions before any
  force-push.
- **Other loops' `/tmp` checkouts** can exhaust inodes (`df -i`, not `df -h`). Never delete a
  checkout you did not create.

## 10. Close out

Write one campaign memory named after the loop: PRs opened and their state, issues resolved
without a PR (already fixed, duplicate, handed back), issues filed on the way, and exactly what is
still owed to Marco.
