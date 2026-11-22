# Expo web PR previews

An app-changing PR gets a browser preview at `https://pr-123.boardsesh.com`.
The frontend is public; signing in uses the usual production account through
`www.boardsesh.com`, and API/WebSocket requests use `ws.boardsesh.com`.
**This is production data: logging a tick, editing a playlist or changing an
account is real.** Sentry and PostHog events carry `preview-web`.

## Which PRs get a preview

Same-repository PRs targeting `main` publish automatically, including drafts,
when their diff contains an app input. `scripts/lib/app-build-inputs.mjs` owns
the native/browser path policy; `scripts/lib/expo-web-inputs.mjs` preserves the
browser interface for previews and production exports: mobile code,
shared packages/schema, board catalogue/WASM, dependencies/patches, export
helpers and shipped hosting configuration. Documentation, tests, backend-only
and marketing-only changes do not qualify. Maestro flows, recorded screenshot
fixtures and browser test configuration also skip builds. Runtime fixtures under
`src/dev` remain app inputs. Shared schema, root manifests, lockfiles and patches
stay conservative: changing them still builds the app, even on a backend PR.
Bundled board-background `.webp` files under the web image roots `decoy`, `grasshopper`, `kilter`, `moonboard`, `soill`, `tension`, `touchstone` and `woods` also qualify because the app imports those files directly.

A later push whose app inputs match the last successful preview reuses that
preview and shows its actual deployed SHA. Removing all app changes removes the
preview. Existing PRs are not backfilled at activation; their next relevant
event or a manual request starts the flow.
Reuse also checks the uncached source metadata on the live hostname. A failed
upload, expired deployment or mismatched revision triggers a fresh build.

For a same-repository PR, a maintainer can comment `/web-preview` to rebuild,
or run **Expo Web Preview Lifecycle** on `main` with the PR number in `pr`.
This still requires a PR with app changes.

For a fork, a maintainer with current repository write, maintain or admin
permission must comment `/web-preview <full-current-head-sha>`, replacing the
placeholder with the complete 40-character commit SHA. Approval applies to that
revision only. A new push needs a new approval, and manual dispatch does not
bypass it. The full SHA prevents a delayed comment event from approving a
newer revision accidentally.

## Build, publish and cleanup

| Workflow | Responsibility |
| --- | --- |
| `expo-web-preview-lifecycle.yml` | Trusted PR/comment metadata checks, requests, daily cleanup and renewal. |
| `expo-web-preview.yml` | Isolated, secret-free app export for the exact requested PR SHA. |
| `expo-web-preview-publish.yml` | Trusted source-run/artifact validation, Pages upload and HTTPS smoke. |

The lifecycle runs trusted `main` tooling and creates a bot-owned deployment
request binding the PR, head SHA/repository and trusted workflow SHA. It
dispatches the build on a short-lived `ci-sandbox/web-preview/pr-N/<run-id>`
branch. The source-build job has a read-only token, no deployment secrets and no
shared Actions cache. Directly dispatching the build workflow on `main` cannot
execute PR code.

After the build and sandbox-branch cleanup finish, a separate trusted job explicitly dispatches the publisher
with the source run ID; this avoids relying on `workflow_run` events from a
`GITHUB_TOKEN`-dispatched run. The publisher reads the source run from GitHub,
checks it against the trusted request and current PR head, and downloads only
that run's expected artifact. The secret-free generated export includes hidden
paths because Metro places bundled icon fonts beneath `assets/__node_modules/.pnpm/`;
artifact upload must retain those directories. Hosting rules and Pages Functions come from the
trusted checkout, not the artifact. Publishing, requests and cleanup share a
per-PR mutation lock. Both workflows retain queued runs with `queue: max`, so
later activity does not replace a pending fork approval or cleanup request.

The trusted lifecycle and publisher jobs use the existing **`Production`**
GitHub environment on `main` to access Cloudflare credentials. That environment
name identifies the credential source; the upload target is the dedicated
`boardsesh-app-previews` project. The sandbox source-build job has no GitHub
environment and receives no Cloudflare credentials.

Pages project `boardsesh-app-previews` uses direct upload with `main` reserved
for trusted hosting. Each `pr-N` branch has its own custom domain and proxied
CNAME to `pr-N.boardsesh-app-previews.pages.dev`. DNS ownership is recorded in
the comment `boardsesh:web-preview:pr-N`; unrelated records are not replaced.
The publisher verifies HTTPS, the exact PR/SHA metadata, SPA routes, JavaScript,
WASM, both bundled icon fonts, PWA manifest, caching, missing-asset 404s and `noindex` before reporting
success. One PR comment and GitHub deployment status show the link, deployed
revision or failure details. While a source build runs or fails, the previously
deployed preview stays available. A failure after upload is reported as a
publication failure; the smoke does not itself roll the branch back. Font checks
read bounded JavaScript chunks as text, require the Material Community Icons and
Material Symbols references, and verify the same-origin font URLs return font
binaries. They never execute downloaded PR JavaScript; missing font artifacts fail
publication instead of leaving the preview marked ready with blank icons.

PR close/merge and removal of the remaining app diff retire the preview. Pages
protects each branch's latest deployment from deletion, so cleanup first uploads
and verifies a tiny trusted "This preview is closed" page. It then removes the
managed domain, DNS alias and older app deployments, leaving only that inactive
page on the provider's branch hostname. Fully retired branches leave the sweep;
interrupted cleanup remains discoverable and is retried.

Every request, build and publication checks that the live PR still targets the
repository's default branch. Changing the base to or from `main` triggers
reconciliation, including canceling requests that have not uploaded anything yet.
Retargeted PR code cannot publish or renew a preview through comments or manual
requests. The trusted credential-bearing workflows continue to run from `main`.

The daily sweep reconciles
missed cleanup and dispatches per-PR renewal after 21 days, before Pages'
30-day retention window. A fork renewal can repeat an approved current SHA; it
cannot authorize new fork code. The `refresh` dispatch input is an internal
sweep flag; normal manual requests need only `pr`.

## First activation

For a public repository, confirm an applicable Actions event policy explicitly
allows this workflow's `pull_request_target` event. GitHub begins blocking that
event by default on December 2, 2026; use workflow-file targeting for the
exception. See [GitHub's policy announcement](https://github.blog/changelog/2026-11-02-pull_request_target-blocked-by-default-december-2/).

1. Merge the preview code and deploy the updated shared origin allowlist to
   **both www and the backend**. Until both serve it, a valid preview certificate
   alone does not prove login or API CORS works.
2. Allow the next qualifying PR activity to start a preview, or run
   **Expo Web Preview Lifecycle** from `main` with one existing same-repository
   app-changing PR. The first publish creates the dedicated Pages project and
   numbered custom domain; no bulk backfill runs.
3. Validate that first preview as described below before calling activation
   complete. The workflows must be merged to `main` before this flow can run;
   this document does not claim a live preview has been verified.

The trusted jobs reuse the existing `Production` environment configuration:

| Existing configuration | Required value |
| --- | --- |
| Secret `CLOUDFLARE_API_TOKEN` | Account **Cloudflare Pages Edit**, **Zone DNS Edit** for `boardsesh.com`, and **Zone Read** unless an explicit zone ID is supplied. |
| Secret `CLOUDFLARE_ACCOUNT_ID` | The account hosting the Pages project and domain. |
| Optional environment variable `CLOUDFLARE_ZONE_ID` | The `boardsesh.com` zone ID; otherwise resolved by name. |

GitHub does not return stored secret values, so these jobs use the existing
credential path directly instead of copying secrets between environments.
Never print credentials or transfer them through artifacts. A dedicated token
with the listed grants can be configured later; it is not an activation
requirement. The source build reads the public repository variable
`NEXT_PUBLIC_POSTHOG_KEY` for analytics. This feature does not upgrade the
Cloudflare plan.

## First-preview checks and limits

1. Follow the PR's browser-preview link; HTTPS should be valid and the comment
   should name the deployed revision. Reload a deep route and open a board to
   exercise SPA fallback and WASM.
2. Sign in through the normal production login; confirm authenticated browsing
   and the WebSocket connection work. Test writes only when you intend to
   change production data.
3. Push an app change; the stable link should serve the new SHA after publishing.
   Push an unrelated change; the comment should explain reuse and retain the
   actual deployed SHA.
4. Check a fork: no publication before a maintainer's full-SHA command, and no
   new revision published under an older approval.
5. Close the test PR or remove its app changes; the preview should become
   inactive and its managed domain should be released.

Cloudflare Free allows [100 custom domains per Pages project](https://developers.cloudflare.com/pages/platform/limits/).
Only hosted app previews consume that quota, not every open PR. Exhaustion fails
with a capacity message; it does not buy Pro or silently replace another PR's
domain. Backend changes always use the deployed production backend, so a
frontend depending on unpublished server behavior may fail visibly.

The flat name `pr-N.boardsesh.com` avoids the nested-hostname certificate
coverage issue recorded in [#5012](https://github.com/boardsesh/boardsesh/issues/5012).
Pages registers each custom domain and provisions its certificate. The older
homelab work in [PR #3799](https://github.com/boardsesh/boardsesh/pull/3799)
remains a separate manual full-stack deployment path; these previews do not
restore its runners, database or staging backend.
