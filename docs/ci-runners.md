# CI runners and slot capacity

Where Boardsesh's GitHub Actions jobs run, why the answer is "GitHub-hosted, on
the Team plan", and how to tell when that stops being enough. Written after
the September 2026 capacity review (#5131); the batch-job half continues in
#5800.

## The problem, measured

`boardsesh/boardsesh` is public, so minutes are free, but concurrency is set
by the org's plan: the Free plan allows **20 concurrent Linux jobs and 5
macOS**. In the week of 2026-09-18..25 the jobs API (`started_at - created_at`
per job, ~1,450 completed jobs sampled) showed:

| jobs | median queue | p90 queue | max queue |
| --- | --- | --- | --- |
| ci.yml PR jobs (849) | 0.6 min | 10.9 min | 36 min |
| production-deploy.yml (27 runs) | 0.1–0.8 min | ~2 min | 12 min (`deploy-web-railway`) |
| mobile-ota-production `publish` (36) | 0.2 min | 3.5 min | 7.8 min |
| mobile-ota-preview `gate` (9 ran, 29 skipped) | 4.1 min | 8.7 min | 8.7 min |

The load, not the runners, was the cause: ~1,000 workflow runs in ten hours
on 2026-09-25, in bursts of 300+ an hour from agent loops; ci.yml at ~817
completed runs a week, ~43 job-minutes each, spread over ~20 jobs, eleven of
which did under a minute of work behind ~40 s of runner setup; the OTA preview
workflow at ~2,000 runs a week, almost all of them a six-second gate.

## What we did

1. **Org → GitHub Team.** $4 a seat, three seats, $12 a month, and the Linux
   concurrency limit goes from 20 to 60. macOS stays at 5 on every plan below
   Enterprise. Nothing in the repo changes.
2. **ci.yml: eleven guard jobs → one `guards` job.** `large-files`,
   `codegen-drift`, `board-render-version`, `i18n`, `deploy-config`,
   `listing-guards`, `pg18-artifacts`, `rest-surface`, `commit-lint`,
   `release-notes` and `changelog-owned` are steps of one job now: one
   checkout, one `vp install`, each guard keeps its old `if:` at step level,
   every guard still runs when an earlier one fails, and a final summary step
   fails the job naming the guards that failed. That saves up to ten slot
   allocations per ci.yml run (one per guard that would have run). `ci-status` is still the only required check.
3. **`ci-image.yml` no longer runs daily.** It built the retired bs-ci fleet's
   runner image every night (3–11 hosted minutes a run, for an image nothing
   pulls).
   It is dispatch-only until `Dockerfile.ci` is deleted.
4. **`ci-lane-watchdog.yml`.** Every 15 minutes it lists queued jobs and posts
   one Discord line (`DISCORD_DEPLOY_WEBHOOK`) when a deploy or OTA job
   (production-deploy, mobile-ota-production, mobile-ota-preview,
   mobile-ota-backport, the Android APK builds) has waited more than 5
   minutes. Alert only. It keys on queued age, not registered-runner counts,
   for the reason production-deploy.md gives: an on-demand pool legitimately
   has zero runners while idle.
5. **`scripts/ci/queue-report.ts`** reproduces the table above:

   ```sh
   vp exec tsx scripts/ci/queue-report.ts --days 7
   vp exec tsx scripts/ci/queue-report.ts --days 7 --workflows ci.yml --json
   ```

   Run it a week after the Team upgrade and the `guards` PR land, and close
   #5131 with the before/after numbers.

## What we did not do, and the prices

Every hosted-runner vendor was costed at our volume (~150–190k ci.yml
job-minutes a month once the ~30 s boot per job is counted):

| option | slots | est. monthly | why not |
| --- | --- | --- | --- |
| RunsOn (own AWS account, free open-source license) | unlimited | $135–195 for all of PR CI; ~$50 for a deploy/OTA-only lane | no macOS (Apple's 24 h EC2 minimum); a deploy-only lane buys a guarantee Team already gives in practice |
| Ubicloud | unlimited | ~$120 | no open-source tier |
| Namespace | unlimited | ~$300 | |
| Blacksmith / Depot | unlimited | ~$600 (3,000 free minutes) | macOS is $0.08/min: one 30-minute iOS build is $2.40 |
| One Hetzner AX42 with the old ansible runner role | ~8 slots of 8 GB | ~€49 | the fixed-pool-versus-bursts shape that sank bs-ci |
| GitHub Team | 60 | $12 | chosen |

If, after re-measuring, deploy or OTA jobs still show a p90 queue above a
minute or the watchdog fires more than twice a week, the escalation is a
RunsOn on-demand lane for those workflows only (`spot=false`, `retry=false`,
one CloudFormation stack, the `runs-on=<run_id>/runner=<name>` label form,
config read from the default branch on a public repo). The design was worked
out in the #5131 review and is not repeated here because it is not wired.

## What leaves GitHub Actions instead

The scheduled data jobs hold 15–25 hosted slot-hours a day: `refresh-climb-
neighbors` (8 boards × ~60 min, 350-minute timeout, 4 GB heap),
`export-board-snapshots` (96 runs a day), and the refresh-* crons. They are the
wrong shape for a burst pool on any plan, so they become pg-boss families on
the homelab `batch` worker (#5800, under epic #5613), together with the Aurora
and Kilter sync daemons. `refresh-acknowledgements` (repository automation)
and `refresh-content-model` (a Python/torch step) stay on Actions.

## Rules that still hold

- The routed `runs-on` expression on ci.yml jobs (`vars.CI_RUNNER_LINUX`, with
  the fork clause) is byte-identical everywhere and pinned by
  `scripts/__tests__/ci-runner-routing.test.ts`. The variable is unset; it is a
  kill switch we no longer plan to flip, kept because the tests around it are
  the security boundary should anyone try.
- `scripts/__tests__/ci-self-hosted-secret-boundary.test.ts`: no routed job may
  reference a secret other than `GITHUB_TOKEN` or declare an `environment:`.
- `scripts/__tests__/ci-capacity-workflows.test.ts`: cancel-in-progress on PR
  runs, the `max-parallel` caps on the test matrices, path filters on heavy
  jobs. The caps exist to keep one push from taking the whole pool; revisit
  them once the Team upgrade has a week of numbers behind it.
