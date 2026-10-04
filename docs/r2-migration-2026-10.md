# R2 migration acceptance record — October 2026

This record collects the live migration evidence for static assets, board snapshots,
and OTA storage. Provider changes preserve the existing public domains, snapshot
formats, OTA signing identity, and S3-compatible configuration.

## Static assets: accepted

`assets.boardsesh.com` serves the `boardsesh-static-assets` R2 bucket. The historical
inventory contains 426 objects; all passed full SHA-256 and portable metadata
comparison. The current public catalog contains 421 objects, all verified for
content, MIME type, caching, and CORS. All five live `STATIC_ASSETS_*` Production
secrets now target R2.

- [Final frozen verification](https://github.com/boardsesh/boardsesh/actions/runs/37175306767).
- [Live domain configuration](https://github.com/boardsesh/boardsesh/pull/5991).
- [Encrypted legacy credential backup](https://github.com/boardsesh/boardsesh/actions/runs/37177850598).

The legacy bucket and credentials remain available. The Boardsesh 1Password vault
contains the static-assets legacy credential backup. Restoring credentials and the
domain binding requires verification of any objects published after cutover.

## Board snapshots: normal producer acceptance in progress

The isolated full R2 export passed verification of 68 artifacts: 23 identity
databases, 23 gzip databases, 21 grades databases, and the catalog. Verification
covered signed and public downloads, stored and decoded hashes, SQLite integrity,
trusted layout coverage, row counts, watermarks, deletion replay boundaries,
freshness, caching, MIME types, and CORS.

The permanent batch worker is pinned to the attested six-hour snapshot lease image.
Its production storage client successfully read all three R2 manifests. Both
`SNAPSHOT_PUBLIC_BASE_URL` and `SNAPSHOTS_PUBLIC_BASE_URL` target
`https://snapshots.boardsesh.com`.

- [Lease correction](https://github.com/boardsesh/boardsesh/pull/6010).
- [Attested worker build](https://github.com/boardsesh/boardsesh/actions/runs/37183010672).
- [Batch deployment configuration](https://github.com/marcodejongh/blackheathdc-ansible/pull/451).
- [Reader cutover](https://github.com/boardsesh/boardsesh/pull/5989).
- [Acceptance issue](https://github.com/boardsesh/boardsesh/issues/5912).

The backend deployment is healthy on both replicas and retains 13 families and 11
schedules while producer acceptance runs. A normal operator nightly with
`skipPrune: true` was queued on October 4 at 07:48 UTC. Its pg-boss metadata confirms
a 21,600-second attempt, 120-second heartbeat, one retry, 300-second retry delay,
and 72,000-second deadline. Normal nightly completion, fresh full artifact
verification, and a subsequent live scan remain required before restoring snapshot
scheduling and releasing readers.

Keep the Tigris bucket and read access for at least 30 days after reader cutover.
The Homelab vault contains the complete pre-R2 batch-worker configuration, including
both legacy public bases. An image-only rollback is insufficient. Follow the
[snapshot rollback runbook](board-snapshots.md#moving-the-snapshot-bucket-to-r2).
Three scheduled nightly observations remain a separate stability follow-up.

## OTA: verified and rotated; delivery acceptance in progress

The frozen copy verified 471,925 objects totaling 51,805,190,050 bytes. It copied
333,076 missing objects and retained 138,849 identical objects. Every object passed
full-stream SHA-256, size, and metadata checks, with source-stability verification.
The distinct final verification passed on October 4 at 07:57 UTC, with the same
471,925-object exact key set, sizes, SHA-256 hashes, and metadata on both providers.
Railway's three storage settings were then atomically rotated to R2. The new
deployment succeeded; all unrelated runtime settings and service configuration
remain unchanged. Live historical delivery and native install acceptance are still
required before restoring publishers.

- [Successful copy](https://github.com/boardsesh/boardsesh/actions/runs/37179226708).
- [Distinct verification](https://github.com/boardsesh/boardsesh/actions/runs/37183947453).
- [Native delivery acceptance issue](https://github.com/boardsesh/boardsesh/issues/5848).

Four historical signed production manifests and every referenced asset have a
verified Tigris baseline: current and older iOS and Android runtimes. After rotation,
the same update identities and hashes must pass through fresh R2 asset URLs. A new
isolated update must then install on production-configured iOS and Android clients.
The six publishing workflows remain disabled until acceptance passes.

The pre-cutover `expo.updates.download_time` baseline covers September 4 through
October 4 UTC: 2,620 samples from 1,511 devices, p50 6.371 seconds and p90 22.238
seconds. Report post-cutover measurements with their sample count and observation
window; do not infer a production improvement from isolated test downloads.

Retain the Tigris bucket and its concealed credentials in the Boardsesh vault. New
R2 publications require reverse copy and verification before a storage rollback;
restoring only the endpoint would strand updates added after cutover. Follow the
[OTA rollback runbook](mobile-ota-updates.md#tigris--r2-object-copy-gate).

## Retention and automation

No legacy objects, buckets, or credentials have been deleted. Deletion requires a
separate explicit approval. Restore the original publishing and deployment controls
only after their live acceptance gates pass. Retired snapshot Actions publishing
stays disabled; the homelab worker remains the sole snapshot producer.
