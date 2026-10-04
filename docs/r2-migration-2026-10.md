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

## Board snapshots: normal producer accepted

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
- [Actual R2 dev-database load and fresh-volume/restart smoke](https://github.com/boardsesh/boardsesh/actions/runs/37188682247/job/111398556368).

The normal operator nightly `05d160e7-a0ca-4b2b-a633-6f0ba3389e27` completed on
October 4 at 08:20 UTC in 17 minutes 5 seconds, without retries or pruning. All
68 newly published artifacts passed the full verifier. A filtered gzip-only
Kilter layout 3 job completed in 14 seconds; all 22 unselected layouts were
unchanged, and the full 68-artifact verifier passed again. The subsequent live
scan `2757521d-5f55-4487-87c7-e4e62a27be38` started 3.55 seconds after enqueue,
checked all 23 layouts in 45 seconds, and found no stale layouts. It did not skip
for queue age or an active exporter; all three manifests remained identical.

Actual pg-boss metadata confirmed a 21,600-second attempt, 120-second heartbeat,
one retry, 300-second retry delay, and 72,000-second deadline. Restoring the
original backend family list adds snapshot publishing to the 13-family freeze:
14 families and 13 schedules. Require fresh replica health, schedule registration,
and a subsequent automatic job with the same lease before considering scheduling
restored. Reader release additionally requires actual native update installation
and a fresh R2 snapshot import; the linked acceptance issue records those gates.

Keep the Tigris bucket and read access for at least 30 days after reader cutover.
The Homelab vault contains the complete pre-R2 batch-worker configuration, including
both legacy public bases. An image-only rollback is insufficient. Follow the
[snapshot rollback runbook](board-snapshots.md#moving-the-snapshot-bucket-to-r2).
Three scheduled nightly observations remain a separate stability follow-up.

## OTA: storage and historical delivery accepted

The frozen copy verified 471,925 objects totaling 51,805,190,050 bytes. It copied
333,076 missing objects and retained 138,849 identical objects. Every object passed
full-stream SHA-256, size, and metadata checks, with source-stability verification.
The distinct final verification passed on October 4 at 07:57 UTC, with the same
471,925-object exact key set, sizes, SHA-256 hashes, and metadata on both providers.
Railway's three storage settings were then atomically rotated to R2. The new
deployment succeeded; all unrelated runtime settings and service configuration
remain unchanged. All four historical delivery probes passed after rotation;
native installation of a newly published update remains a release gate.

- [Successful copy](https://github.com/boardsesh/boardsesh/actions/runs/37179226708).
- [Distinct verification](https://github.com/boardsesh/boardsesh/actions/runs/37183947453).
- [Native delivery acceptance issue](https://github.com/boardsesh/boardsesh/issues/5848).

Four historical signed production manifests passed against their Tigris baselines:
current and older iOS and Android runtimes. Every one of the 1,630 referenced assets
(167,624,808 bytes) passed full SHA-256 verification through fresh URLs for the
correct private R2 account and bucket. Update identities, runtimes, branches, and
signatures were preserved. A new isolated update must also install on
production-configured iOS and Android clients before restoring the six publishing
workflows; the linked native acceptance issue records that result.

The OTA bucket remains private with no custom domain. CDN caching is tracked separately in
[follow-up #6017](https://github.com/boardsesh/boardsesh/issues/6017). The deployed
xprem v3.2.5 supports a generic `CDN_BASE_URL`; selecting a public domain or
authenticated proxy still requires a preview privacy decision and live acceptance.

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
