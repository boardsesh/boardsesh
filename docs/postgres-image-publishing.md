# Trusted PostgreSQL image publishing

The PostgreSQL 18 migration uses two reviewed images, and each one has its own
manual publisher loaded from protected `main`:

| Image                                          | Platforms                    | Published by                                                                                             | Consumers                                                                |
| ---------------------------------------------- | ---------------------------- | -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `ghcr.io/boardsesh/boardsesh-postgres-postgis` | `linux/amd64`, `linux/arm64` | `.github/workflows/postgres-image-publisher.yml` ("Publish Current Main Portable PostgreSQL Image")      | Railway production, homelab standby, `ci.yml`                            |
| `ghcr.io/boardsesh/boardsesh-dev-db`           | `linux/amd64`                | `.github/workflows/postgres-seeded-image-publisher.yml` ("Publish Current Main Seeded PostgreSQL Image") | root `docker-compose.yml`, e2e, migration renumber, one `ci.yml` fixture |

Both publish only the exact commit that is still the live `main` head. The
workflow, Dockerfiles, build context, and provenance source are therefore one
reviewed commit rather than separate trusted and candidate refs.

## Why two publishers

They used to be one workflow that built both images in a single run. The
live-`main` recheck sits immediately before registry login, and login happens
after _both_ builds, so the quiet-`main` window a production publish needed was
set by the seeded image: a measured 16m52s versus 1m39s for the portable image.
The seeded build is slow because it downloads six Android APKs from a
third-party mirror and extracts SQLite from each. Two publish attempts were lost
to `main` moving inside that window.

The seeded developer image is not a production database artifact
(`docs/postgres-18-migration.md`), so production should never wait on it.
Splitting the workflows makes the portable publisher's quiet window its own
~2-minute build instead of ~19 minutes of combined work.

Nothing else changed. Both workflows keep the identical trust boundary — the
exact live-`main` binding rechecked before registry authentication and before
OIDC attestation, the protected `postgres-image-publisher` environment on both
privileged jobs, an offline OCI layout built before any registry credential
exists, retired-digest policy validated before build setup and again against the
built digest before login, digest verification, provenance attestation verified
for signer workflow / repository / `refs/heads/main` / source SHA / subject
digest, pinned action SHAs with tag comments, a pinned BuildKit daemon, a
checksum-verified ORAS client, and rejection of a Dockerfile `# syntax=`
frontend directive in both the unprivileged and the final offline validation.

`scripts/lib/postgres-image-publisher-contract.ts` validates both workflows
through one shared parsed contract, so a weakening applied to one file and not
the other still fails. Bodies that are deliberately identical in both publishers
share a reviewed hash, which means a one-sided edit to a duplicated privileged
step fails the contract as well.

## Required repository controls

Create a dedicated GitHub environment named `postgres-image-publisher` before
the first dispatch. Both publishers use that same environment. It must have all
of these settings:

1. One or more required reviewers.
2. An explicit **prevent self-review** setting, either on or off. See the
   accepted risk below before choosing.
3. Administrator bypass disabled.
4. A custom deployment branch policy containing exactly the `main` branch.
5. No tag or wildcard deployment policy.

Each workflow reads the environment and deployment-branch-policy APIs before it
starts and again immediately before package-write and OIDC operations. A
missing field, missing permission, API error, reviewer-free rule, enabled
bypass, or policy other than exactly `main` fails closed. GitHub still enforces
the environment approval independently of this audit. Because the environment is
shared, the approval prompt tells you which image is being published only
through the run's workflow name.

### Accepted risk: self-review is permitted

The audit requires `prevent_self_review` to be present and boolean, but accepts
either value. Boardsesh runs with a single maintainer, so requiring a second
approver would leave no one able to approve a dispatch, and a GitHub App cannot
act as an environment reviewer.

What this gives up: one account that can both dispatch a publisher and approve
its environment gate can publish an image without a second person seeing it. The
remaining controls still hold — publication is limited to the exact live `main`
head, `main` requires a pull-request review, administrator bypass is off, the
deployment policy is `main`-only, no candidate code runs while registry
credentials exist, and every published digest carries a verified provenance
attestation naming its source commit. Compromise of the maintainer account is
the uncovered case; a compromise of any _other_ account still cannot publish.

Enable prevent self-review as soon as a second reviewer with repository access
exists. Nothing in either workflow needs to change — the audit accepts `true`
today.

Also keep these repository controls in place:

- Protect `main`. Each workflow requires `github.ref_protected == true`, its own
  exact default-branch workflow path/ref, and equality between the supplied
  SHA, `github.sha`, `github.workflow_sha`, and the live `main` API head.
- Allow this repository's `GITHUB_TOKEN` to read and write the two linked GHCR
  packages. The packages may remain private.
- Define `RETIRED_DB_IMAGE_DIGESTS` as a repository or
  `postgres-image-publisher` environment variable. Set it to the exact sentinel
  `none` when no digest has been retired. Otherwise, each non-empty line must be
  one lowercase `sha256:<64 hex>` digest. Missing, empty, whitespace-only,
  invalid, duplicate, or mixed `none`/digest values fail before image build
  setup. The complete policy is checked again against the built digest before
  registry login. **One list covers both publishers.** The variable carries no
  image attribution, so each workflow validates the whole list and checks its own
  built digest against all of it. Never narrow either workflow to "only digests
  for my image" — that is not implementable and would be a weakening.
- Do not grant package deletion to either workflow.

These settings are external to the repository and cannot be created safely by
the publishers themselves. Protected-main review plus the separately reviewed
publisher environment are the trust root. The contract's co-located parsed
structure and script hashes are reviewer regression guardrails: they make every
executable change explicit, but a source change can update its own expected
hashes and therefore the hashes are not an independent security authority. The
contract workflow also watches the root and `scripts` Vite configs that select
and discover this suite. The live API audit validates the environment fields
GitHub exposes.

## Dispatch contract

Each workflow has one input: `expected_main_sha`. It must be the exact lowercase
40-character SHA currently at `refs/heads/main`.

A run rejects anything else, including a feature branch, pull-request ref,
older `main` commit, abbreviated SHA, workflow loaded from another path, or a
SHA that stops being the live `main` head. The live-head check runs again
immediately before every registry login and before OIDC attestation. If another
PR merges while a build or approval is pending, the run fails and must be
redispatched for the new head.

The digest recorder repeats the live-main, `github.sha`, workflow-ref, and
workflow-SHA checks immediately before artifact upload. Keep `main` quiet until
the workflow you dispatched has finished. The API check and artifact upload are
two separate requests, so an unavoidable tiny race remains if another merge
lands between them; treat a run that overlaps a merge as invalid and redispatch
from the new head.

Dispatching both publishers for the same SHA means holding `main` quiet across
the union of the two runs, or accepting that the seeded run fails and gets
redispatched. Only the portable publisher's window blocks a production cutover.

## Authority boundaries

Each workflow's jobs deliberately separate validation, package publication,
smoke tests, attestation, and manifest recording. The job names, permissions,
and gate order are the same in both files:

1. `authorize-current-main` binds the dispatch to protected, live `main` and
   audits the dedicated environment using read-only `contents` and `actions`
   GitHub access, the permissions required by GitHub's environment API. It also
   pins `EXPECTED_WORKFLOW_REF` to its own workflow path, so the seeded
   publisher cannot be dispatched as the portable one or vice versa.
2. `validate-main` checks out only `expected_main_sha` with
   `persist-credentials: false`, validates the Docker inputs, installs the
   locked dependency graph, and runs the PostgreSQL 18 contracts. It has no
   package, environment, or OIDC authority. Both publishers validate both
   Dockerfiles here, so neither can be weakened independently.
3. `publish-images` is approved through `postgres-image-publisher`. BuildKit
   receives no GitHub token, secret, or SSH mount. The pinned BuildKit daemon
   builds the image to a local OCI layout before GHCR authentication. The build
   supplies no `BUILDKIT_SYNTAX` or other build argument, so the pinned daemon
   uses its bundled Dockerfile frontend. Both the unprivileged validation job
   and the final offline-input validation reject whitespace- or BOM-prefixed
   `# syntax=` directives, and the parsed workflow contract rejects adding a
   frontend override. The workflow verifies the layout root digest, its exact
   platform set, and the complete retired-digest variable before logging in. A
   pinned, checksum-verified ORAS client then copies that already validated
   layout to GHCR. No checked-out script runs after login, and the temporary
   registry config and Buildx builder are removed on every outcome. Only the
   portable publisher installs QEMU, because only it builds `linux/arm64`.
4. Fresh package-read runners resolve the published tag to the expected digest,
   inspect the remote manifest, and pull the exact digest/platform. The smoke
   job then erases its temporary registry credentials before setting up Vite+
   or Bun, installing the locked dependency graph, or running the
   candidate-owned image smoke contract.
5. `attest-published-digests` uses the dedicated environment and the official
   pinned GitHub attestation action in native provenance mode. Because source,
   workflow, and `github.sha` are now the same exact current-main commit, the
   action's signed source ref and digest describe the dependency truthfully;
   no user-authored provenance predicate substitutes another ref.
6. `verify-attestations` validates the GitHub attestation URL and runs
   `gh attestation verify` for the exact OCI subject. It requires the exact
   repository, its own signer workflow path, signer SHA, `refs/heads/main`
   source ref, source SHA, SLSA provenance predicate type, and GitHub-hosted
   runner. Only after that verification can `record-published-digests` perform
   its final live-main/workflow binding check and upload the handoff artifact.

The token spelling is intentionally different at the two boundaries. Read-only
GitHub API checks use `github.token`; credential-bearing GHCR login steps use
`secrets.GITHUB_TOKEN`. GitHub resolves both expressions to the same job-scoped
token, but the distinction keeps registry authentication visually explicit.

Each workflow is serialized in its own concurrency group with
`cancel-in-progress: false`: `postgres-image-publisher` for the portable image
and `postgres-seeded-image-publisher` for the seeded one. That prevents two runs
of the same publisher from racing. It no longer prevents a portable run and a
seeded run from holding GHCR write at the same time — that is the point of the
split, and it is safe because they write different packages and validate
`RETIRED_DB_IMAGE_DIGESTS` independently. Neither group can stop other actors
with GHCR write access; restrict package writers accordingly.

## Tags and digest identity

Each image receives only `sha-<40-character main SHA>`. There is no `latest`,
`main`, branch, or `pg18` tag.

The SHA tag is a lookup alias, not an immutable security boundary. OCI
registries permit a writer to move a tag, and a later dispatch of the same
source may replace it. Consumers and retirement policy use only
`image@sha256:<digest>`. Neither workflow describes a tag as immutable and each
handoff artifact explicitly records `deployment_identity: digest-only`.

The OCI layout is fully built and checked against `RETIRED_DB_IMAGE_DIGESTS`
before the first registry login, so a retired digest is never knowingly pushed.
A network failure can still leave a prevalidated layout in GHCR after a failed
copy; such a run emits no digest handoff artifact. Preserve partial output for
audit and start a new run only after understanding the failure.

## PostgreSQL 18 rollout sequence

Use three changes, with a quiet `main` window around each dispatch:

1. Merge the publisher prerequisite PR and configure the dedicated environment.
2. Merge producer-only PR A containing the reviewed PostgreSQL 18 image source
   and its validation contracts, including the `test:postgres18-contract`
   Vite+ target. Do not add consumer digest pins in A. An accidental dispatch
   before this target reaches `main` fails immediately after checkout, before
   dependency installation.
3. Record A's merge SHA and dispatch **Publish Current Main Portable PostgreSQL
   Image** from `main` with that exact SHA. Do not merge another PR until the
   entire run, including artifact upload, finishes. Any overlapping main
   movement invalidates the operational quiet-window guarantee, even if it falls
   inside the tiny final check/upload race. Download
   `postgres-image-digests-<main SHA>/postgres-image-digests.json`.
4. Dispatch **Publish Current Main Seeded PostgreSQL Image** from `main` with
   the same SHA and keep `main` quiet for that run too. Download
   `postgres-seeded-image-digest-<main SHA>/postgres-seeded-image-digest.json`.
   This run takes roughly seventeen minutes; nothing about a production cutover
   waits on it.
5. Confirm each artifact's `source.sha` equals A's merge SHA and that its
   attestation is marked verified. If the two runs landed on different `main`
   SHAs, the artifacts carry different `source.sha` values — say in PR B which
   pin came from which run, or redispatch so both describe the same commit.
6. Open consumer-pin PR B. B may update image consumers, digest contracts, and
   documentation to the exact digests from the two artifacts. If image inputs
   must change, merge a new producer commit and repeat the dispatches instead of
   rebuilding an older source.

Each schema-v2 artifact records the exact repository, `refs/heads/main` source
SHA, OCI labels, mutable lookup tag policy, image name, digest identity,
verified platforms, attestation URL, and downstream verification result under
its own key in `images` (`portable` or `seeded`). Never derive a consumer pin
from the tag.
