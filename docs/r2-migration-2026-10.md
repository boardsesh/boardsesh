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
original backend family list added snapshot publishing to the 13-family freeze.
Deployment `df886699-7b7d-4b57-a52c-2be1865b3434` passed fresh health, schema,
and render checks, with both replicas registering 14 families and 13 schedules.
Automatic live run `a998008a-92e8-441f-afe3-c49bfe2e069a` started within three
seconds and completed in 47.60 seconds at 09:08 UTC, with the same six-hour lease
and no retries, age skip, or competing-run skip. It checked all 23 layouts and
left all manifests unchanged. Scheduling is restored. Reader PR #5989 merged as
`6daaba710c220f9a3c5244b58d70a8bcda1b1bfa`. A real browser cross-origin
fetch also decoded a gzip artifact into SQLite; its decoded hash and row counts
matched an independent download and SQLite integrity check.

Keep the Tigris bucket and read access for at least 30 days after reader cutover.
The Homelab vault contains the complete pre-R2 batch-worker configuration, including
both legacy public bases. An image-only rollback is insufficient. Follow the
[snapshot rollback runbook](board-snapshots.md#moving-the-snapshot-bucket-to-r2).
Three scheduled nightly observations and comparable download metrics are tracked
in [stability follow-up #6018](https://github.com/boardsesh/boardsesh/issues/6018).

### Native reader acceptance and owner waiver

The current production JavaScript source is frozen at
`6cab8437bb7875e3a84ea228365c344428a6ca3c`, preserving already deployed fixes.
The reviewed manual publisher resolves the original full runtimes naturally;
it does not override fingerprints or publish the newer release train's native
contract into the old cohort. Both actual Linux dry runs passed:
[iOS](https://github.com/boardsesh/boardsesh/actions/runs/37247310643) and
[Android](https://github.com/boardsesh/boardsesh/actions/runs/37247329899).

The iOS Release simulator launched signed current-source QA update
`de8d9831-8387-60b2-9a55-5e2e05f3cb4a` on runtime
`c2643067d9b4f56009900f1954305ca73ea799d1`. A previously empty Tension
`9:4` scope completed one normal download, with bootstrap and scope-complete
markers, no paged fallback, SQLite integrity, grades, and ordered checkpoints.
The deletion boundary remained conservative and unchanged.

Read-only descriptors captured both actual decoded native bodies: core
47,935,488 bytes, SHA-256
`a9bed04d838f7fb36b170227d709ad5e11342b0b22af506420e9936218951b15`;
grades 14,639,104 bytes, SHA-256
`4126f485963905d701e4e9c60f024e171f9a1d3de15614fa101778377ce43667`.
Both matched the verified public artifacts and SQLite metadata. Matching
completion sidecars were not observed; full captured bodies and the completed
native import provide separate evidence. The earlier Kilter import's body
hashes were not captured and are excluded from this integrity claim.

This is Release simulator acceptance, not a physical App Store device test.
Android native acceptance remains incomplete after emulator and debug transport
failures. The owner explicitly accepted the passed iOS basis and waived the
remaining Android gate. No Android native update
installation or fresh bootstrap pass is claimed. Production publication and
restoration receipts are recorded separately from this QA acceptance.

### Production reader publication

[The iOS production run](https://github.com/boardsesh/boardsesh/actions/runs/37253720340)
passed on October 5. It published update
`7da0d206-20c9-005f-e80f-27589b430511`, created at 02:06:26 UTC, on the
unchanged iOS runtime. Both cold and publisher exports matched the served
Hermes SHA-256
`57fa1a5648558156fce23bf5aa249fc7589be6bdc2fb2c4e2adf775827424283`.
The new signed manifest and all 389 private R2 assets, totaling 41,428,090 bytes,
passed full verification; the required source-map upload passed.

A subsequent iOS Release simulator cold restart recorded two successful SDK
launches and zero failed launches for this production update. Both active native
controller records identified that same update and runtime at 02:12:23 UTC.
The previously empty production Tension `10:6` scope then completed one normal
download: 56,050 scoped climbs, 58,346 scoped stats, bootstrap and scope-complete
markers, and no attempts or paged fallback. SQLite integrity passed, with 56,704
scoped grades. Climbs and stats matched their actual ordered checkpoint pairs
at `2026-10-05T02:09:45.264749Z`, sequences `1856672` and `414194288`;
the grades pair matched sequence `8206477`. The conservative deletion boundary
remained unchanged at sequence `188163`.

Read-only descriptors captured the freshly published Tension 10 core body,
36,720,640 bytes, SHA-256
`2943c5976189cbd3d577f636c86ed2d578daffcc2739b2ca1f802e242bfb0315`,
and grades body, 10,608,640 bytes, SHA-256
`5575b6969124f72c1a44ecca53d5e1c1e23ffb8a179722cc6cb90889fa739fef`.
Both matched current verified public artifacts built at 01:23:24.686 UTC,
with SQLite integrity, metadata, and row counts. Matching sidecars were not
observed; the full-body proof and completed native import are separate checks.

[The Android production run](https://github.com/boardsesh/boardsesh/actions/runs/37254050894)
also passed. Update `4a8fb895-f191-404c-4689-c6fd4296da58` was created at
02:12:59 UTC on the unchanged runtime
`04b545294d879a2a9d1fb2ac46a807d3175b39d6`. Cold, publisher, and served
Hermes SHA-256 matched
`3075845f5f93ed16f56a6505680f0201c182a293a618c2764904d9b06e5ca7fe`.
Its signed manifest and all 426 private R2 assets, totaling 42,504,016 bytes,
passed full verification; source-map upload passed. This proves served Android
production delivery, not the waived Android native installation/bootstrap gate.

Both production jobs triggered from merged reader commit
`6daaba710c220f9a3c5244b58d70a8bcda1b1bfa`. The guarded workflow, helper,
tests, TypeScript configuration, and root package/lock/workspace configuration
were byte-identical to reviewed guard commit
`0c56a04d71669d9239fdfc8b64f64cc765803850`; the immutable source remained
`6cab8437bb7875e3a84ea228365c344428a6ca3c`.

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
signatures were preserved. New current-source iOS QA installation and fresh
snapshot bootstrap passed on the Release simulator. The owner waived the
incomplete Android native gate, as recorded above; signed served delivery checks
for both platforms remain required for production publication.

At acceptance the OTA bucket was private with no custom domain. CDN caching was tracked in
[follow-up #6017](https://github.com/boardsesh/boardsesh/issues/6017) and has since been decided: the bucket is
public by URL at `ota-assets.boardsesh.com`, preview bundles included. See
[mobile-ota-updates.md](./mobile-ota-updates.md#asset-delivery-from-the-edge) for the delivery path and its gate.

The pre-cutover `expo.updates.download_time` baseline covers September 4 through
October 4 UTC: 2,620 samples from 1,511 devices, p50 6.371 seconds and p90 22.238
seconds. Report post-cutover measurements with their sample count and observation
window; do not infer a production improvement from isolated test downloads.

The fixed field window, October 4 at 08:00:49 UTC through October 5 at
02:19:03 UTC (end excluded), contains 70 download events from 69 people and
69 sessions, all for older Android runtime
`154bc941c504727afc914057aed2edff2c096576`, predominantly update
`e0571860-9082-d39d-c762-e6dc61310f67`. The verified historical 2.5.0 APK
uses `https://updates.boardsesh.com/manifest`, the same app ID, and the production
channel. Its matching current signed manifest and all 426 referenced private R2
assets passed full verification. This supports the inference that those field
downloads use R2, while the events themselves do not record the hostname.
The dominant update accounts for 69 downloads from 68 people and 68 sessions.
One download belongs to historical update
`794486bd-a3fd-4523-d4b8-781dc30281cb`, whose full delivery was not reverified
in this field check. The final six hours contain 23 downloads from 23 people and
23 sessions. These are unique people and sessions, not a physical-device count.
This does not establish native acceptance for the newly published Android store
runtime. The separate status/launch observation contains 165 events from
105 people and 164 sessions, with zero emergency launches. These events have no
transfer-duration metric, so they cannot supply a new p50/p90 comparison.

Retain the Tigris bucket and its concealed credentials in the Boardsesh vault. New
R2 publications require reverse copy and verification before a storage rollback;
restoring only the endpoint would strand updates added after cutover. Follow the
[OTA rollback runbook](mobile-ota-updates.md#tigris--r2-object-copy-gate).

## Retention and automation

Publishing and deployment controls were restored on October 5, from
02:21:54.242266 through 02:22:05.555540 UTC. Fresh inventories found no
queued, pending, waiting, requested, or running writer jobs in either repository,
including no in-flight worker-image deployment. The Ansible receiver was enabled
first, then `HOMELAB_DEPLOY_ENABLED=true`, then the six paused writer workflows,
with `production-deploy.yml` restored last. No old run was replayed and no new
publication or deployment was dispatched as part of restoration.

Retired snapshot Actions workflow `313375890` stays disabled; the homelab batch
worker remains the sole snapshot producer, with Railway providing its scheduler.
No legacy object, bucket, or credential has been deleted. Deletion requires a
separate explicit approval.

The 30-day reader retention clock starts at the later verified platform publication,
October 5, 2026 at 02:12:59 UTC. Keep legacy snapshot reads and rollback credentials
available through at least November 4, 2026 at 02:12:59 UTC. Reaching that date
does not authorize deleting any object, bucket, or credential.
