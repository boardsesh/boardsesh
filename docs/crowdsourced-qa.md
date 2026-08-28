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
(the `pr-labels.yml` rule). Bot PRs are exempt. Hard failures: no test plan, no steps, more than 5
steps, a step over 140 characters, no risk score, a score outside 1–5. Warnings only: a step over
12 words, a bare score with no reason. A maintainer can apply the **`skip-qa-gate`** label to pass a
PR unchecked.

### One parser

`packages/shared/pr-body` (`@boardsesh/pr-body`) owns the markdown section walker and the rule set
(`extractSection`, `parseTestPlan`, `parseRisk`, `validatePrBody`). The changelog generator's
`## Release Notes` extraction (`scripts/lib/changelog-transform.ts`), the CI gate, and the backend
all read PR bodies through it, so a body that passes CI renders the same plan in the app.
