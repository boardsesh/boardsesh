# Trusted PostgreSQL image publishing

The PostgreSQL 18 migration uses two reviewed images:

- `ghcr.io/boardsesh/boardsesh-postgres-postgis` for `linux/amd64` and
  `linux/arm64`.
- `ghcr.io/boardsesh/boardsesh-dev-db` for `linux/amd64`.

`.github/workflows/postgres-image-publisher.yml` is a manual publisher loaded
from protected `main`. It publishes only the exact commit that is still the
live `main` head. The workflow, Dockerfiles, build context, and provenance
source are therefore one reviewed commit rather than separate trusted and
candidate refs.

## Required repository controls

Create a dedicated GitHub environment named `postgres-image-publisher` before
the first dispatch. It must have all of these settings:

1. One or more required reviewers.
2. **Prevent self-review** enabled. The person who dispatches the run cannot
   approve its publisher jobs.
3. Administrator bypass disabled.
4. A custom deployment branch policy containing exactly the `main` branch.
5. No tag or wildcard deployment policy.

The workflow reads the environment and deployment-branch-policy APIs before it
starts and again immediately before package-write and OIDC operations. A
missing field, missing permission, API error, reviewer-free rule, enabled
bypass, or policy other than exactly `main` fails closed. GitHub still enforces
the environment approval independently of this audit.

Also keep these repository controls in place:

- Protect `main`. The workflow requires `github.ref_protected == true`, the
  exact default-branch workflow path/ref, and equality between the supplied
  SHA, `github.sha`, `github.workflow_sha`, and the live `main` API head.
- Allow this repository's `GITHUB_TOKEN` to read and write the two linked GHCR
  packages. The packages may remain private.
- Define `RETIRED_DB_IMAGE_DIGESTS` as a repository or
  `postgres-image-publisher` environment variable. Set it to the exact sentinel
  `none` when no digest has been retired. Otherwise, each non-empty line must be
  one lowercase `sha256:<64 hex>` digest. Missing, empty, whitespace-only,
  invalid, duplicate, or mixed `none`/digest values fail before image build
  setup. The complete policy is checked again against the built digests before
  registry login.
- Do not grant package deletion to this workflow.

These settings are external to the repository and cannot be created safely by
the publisher itself. Protected-main review plus the separately reviewed
publisher environment are the trust root. The contract's co-located parsed
structure and script hashes are reviewer regression guardrails: they make every
executable change explicit, but a source change can update its own expected
hashes and therefore the hashes are not an independent security authority. The
live API audit validates the environment fields GitHub exposes.

## Dispatch contract

The workflow has one input: `expected_main_sha`. It must be the exact lowercase
40-character SHA currently at `refs/heads/main`.

The run rejects anything else, including a feature branch, pull-request ref,
older `main` commit, abbreviated SHA, workflow loaded from another path, or a
SHA that stops being the live `main` head. The live-head check runs again
immediately before every registry login and before OIDC attestation. If another
PR merges while a build or approval is pending, the run fails and must be
redispatched for the new head.

The digest recorder repeats the live-main, `github.sha`, workflow-ref, and
workflow-SHA checks immediately before artifact upload. Keep `main` quiet until
the complete workflow has finished. The API check and artifact upload are two
separate requests, so an unavoidable tiny race remains if another merge lands
between them; treat a run that overlaps a merge as invalid and redispatch from
the new head.

## Authority boundaries

The jobs deliberately separate validation, package publication, smoke tests,
attestation, and manifest recording:

1. `authorize-current-main` binds the dispatch to protected, live `main` and
   audits the dedicated environment using read-only `contents` and `actions`
   GitHub access, the permissions required by GitHub's environment API.
2. `validate-main` checks out only `expected_main_sha` with
   `persist-credentials: false`, validates the Docker inputs, installs the
   locked dependency graph, and runs the PostgreSQL 18 contracts. It has no
   package, environment, or OIDC authority.
3. `publish-images` is approved through `postgres-image-publisher`. BuildKit
   receives no GitHub token, secret, or SSH mount. The pinned BuildKit daemon
   builds both images to local OCI layouts before GHCR authentication.
   `BUILDKIT_SYNTAX=dockerfile.v0` forces BuildKit's bundled frontend even if a
   Dockerfile contains a whitespace- or BOM-prefixed `# syntax=` directive;
   validation rejects those directives as defense in depth. The workflow
   verifies both layout root digests, exact platform sets, and the complete
   retired-digest variable before logging in. A pinned, checksum-verified ORAS
   client then copies those already validated layouts to GHCR. No checked-out
   script runs after login, and the temporary registry config and Buildx
   builder are removed on every outcome.
4. Fresh package-read runners resolve the published tag to the expected digest,
   inspect the remote manifests, pull every exact digest/platform, erase their
   temporary credentials, and then run the image smoke contracts.
5. `attest-published-digests` uses the dedicated environment and the official
   pinned GitHub attestation action in native provenance mode. Because source,
   workflow, and `github.sha` are now the same exact current-main commit, the
   action's signed source ref and digest describe the dependency truthfully;
   no user-authored provenance predicate substitutes another ref.
6. `verify-attestations` validates both GitHub attestation URLs and runs
   `gh attestation verify` for each exact OCI subject. It requires the exact
   repository, signer workflow, signer SHA, `refs/heads/main` source ref, source
   SHA, SLSA provenance predicate type, and GitHub-hosted runner. Only after
   both attestations verify can `record-published-digests` perform its final
   live-main/workflow binding check and upload the handoff artifact.

The workflow is globally serialized with `cancel-in-progress: false`. That
prevents two runs of this publisher from racing, but it cannot stop other
actors with GHCR write access. Restrict package writers accordingly.

## Tags and digest identity

Each image receives only `sha-<40-character main SHA>`. There is no `latest`,
`main`, branch, or `pg18` tag.

The SHA tag is a lookup alias, not an immutable security boundary. OCI
registries permit a writer to move a tag, and a later dispatch of the same
source may replace it. Consumers and retirement policy use only
`image@sha256:<digest>`. The workflow never describes a tag as immutable and
the handoff artifact explicitly records `deployment_identity: digest-only`.

Both OCI layouts are fully built and checked against
`RETIRED_DB_IMAGE_DIGESTS` before the first registry login, so a retired digest
is never knowingly pushed. A network failure can still leave one of the two
prevalidated layouts in GHCR after a partial copy; such a run emits no digest
handoff artifact. Preserve partial output for audit and start a new run only
after understanding the failure.

## PostgreSQL 18 rollout sequence

Use three changes with a quiet `main` window around the dispatch:

1. Merge the publisher prerequisite PR and configure the dedicated environment.
2. Merge producer-only PR A containing the reviewed PostgreSQL 18 image source
   and its validation contracts, including the `test:postgres18-contract`
   Vite+ target. Do not add consumer digest pins in A. An accidental dispatch
   before this target reaches `main` fails immediately after checkout, before
   dependency installation.
3. Record A's merge SHA and immediately dispatch **Publish Current Main
   PostgreSQL Images** from `main` with that exact SHA. Do not merge another PR
   until the entire run, including artifact upload, finishes. Any overlapping
   main movement invalidates the operational quiet-window guarantee, even if it
   falls inside the tiny final check/upload race.
4. Download
   `postgres-image-digests-<main SHA>/postgres-image-digests.json`. Confirm its
   source SHA equals A's merge SHA and that both attestations are marked
   verified.
5. Open consumer-pin PR B. B may update image consumers, digest contracts, and
   documentation to the two exact digests from the artifact. If image inputs
   must change, merge a new producer commit and repeat the dispatch instead of
   rebuilding an older source.

The schema-v2 artifact records the exact repository, `refs/heads/main` source
SHA, OCI labels, mutable lookup tag policy, image names, digest identities,
verified platforms, attestation URLs, and downstream verification result.
Never derive a consumer pin from the tag.
