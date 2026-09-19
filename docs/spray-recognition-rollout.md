# Spray recognition: homelab rollout

## Current architecture

Mobile uploads a photo through the existing authenticated backend endpoint and
creates a draft version. `requestSprayWallDetection` records a durable request
and its pg-boss job in one PostgreSQL transaction. Requests for the same draft
and photo return the same job; explicit retry of a failed job creates one new
request. Editing authorization applies to creation, polling and retry. A user
may create at most ten requests per hour, serialized across backend replicas.

The dedicated homelab worker connects to the **writable Railway primary**, not
the physical standby. It reads the private object directly using a separate
R2 read-only token. Queue payloads contain only a detection UUID. Results remain
private database rows; no signed photo URL, image bytes or coordinates are sent
to analytics or worker logs. A proposal never inserts holds or publishes a wall.

The Node runtime pins ONNX Runtime 1.30.0 and model `2026-09-18-seg`, with SHA-256
`04847246ceaef144759cd7e1edb00268217a71c1a32709813c2957318572fcb1`.
It uses one warm inference thread, two CPU threads and one job at a time. EXIF
orientation is applied before detection; the result must match the stored
photo's dimensions. Shared decoding produces radius-unit outlines; malformed
or zero-area outlines fall back to circles.

Jobs have a 120-second lease, 30-second heartbeat, three retries with 15-second
exponential backoff capped at 120 seconds, and a 24-hour pending lifetime.
Worker-thread termination bounds native inference, including a model reload,
to 90 seconds. Attempt tokens fence completions from crashed/stale workers.
Draft publication, deletion or source changes invalidate late results. The
backend runs a bounded reconciliation page each minute and handles dead letters.

Mobile polls in the foreground and resumes by draft version. New-wall owners
can choose manual placement while waiting. A reset has no empty-result fallback
that can silently remove all existing holds: it retains the published wall and
can be resumed from its stored photo after leaving the app.

## Deploy order

1. Provision a dedicated `boardsesh_detector` login on the primary. Store its
   password and a new private-bucket read-only R2 token in the Homelab 1Password
   item **Boardsesh hold detector**. Never put credentials in Git or PR bodies.
2. Deploy database migrations using the existing migration-owner connection,
   with `MIGRATION_DETECTOR_ROLE=boardsesh_detector`. The migrator initializes
   pg-boss 12.33.0 and queues under that owner, then grants DML to the runtime
   and worker roles. Backend and worker startup disable schema migration. Do
   not grant runtime CREATE privileges as a workaround for startup errors.
3. Deploy the backend, then the attested `ghcr.io/boardsesh/hold-detector` image
   pinned by digest through the Ansible repo. VM 158 is proposed; provisioning
   must validate cluster/IP allocation. Use the role's private `/health` and
   `/metrics` endpoints and Boardsesh alerts. No public inference API exists.
4. Ship mobile service integration. Separately merge native cleanup into
   `release/next` and build new binaries without ONNX or the increased-memory
   entitlement. Retain camera permissions. Old binaries can use service jobs;
   the native dependency removal itself cannot be accomplished by OTA.
5. Complete the gates below and record evidence before each exposure change.

## Release gates (not yet satisfied)

The offline threshold remains **40% gesture savings**. The existing Node-model
work reports **48.2%**; that is prior evidence, not a new measurement from this
rollout. Reproduce on the pinned image/model before promotion. Do not substitute
Python runtime scores: the int8 runtimes have previously differed.

| Stage | Minimum evidence before promotion |
| --- | --- |
| Testers | At least 24 hours; a photographed, reset and climbed real wall; 20 reviewed walls across at least 5 users; uploads ≥95%; count-difference proxy ≤15%. |
| 10% | At least another 24 hours; at least 10 reset previews; reset applies/previews ≥60%; upload and correction gates still pass; no unresolved worker/auth/privacy errors. |
| Everyone | Continue monitoring queue age, failures, latency and RSS; roll exposure back on gate regression. |

Use the existing `SPRAY_ROLLOUT_GATES` definitions. `Spray Holds Reviewed` now
contains both `candidateCount` and `holdCount`, so the count-difference proxy
can be calculated on the same event. It is **not** edit count or F1; equal counts
can hide corrections. Exclude older events without a candidate count, and do
not join unrelated users' detection/review events to manufacture a denominator.

Record each observation window, image digest, model hash, participant count,
reviewed-wall count, uploads attempted/succeeded, candidate/saved counts and
reset previews/applies on #5451. No gate may be marked complete from unit tests,
elapsed time alone or fabricated tester events.

## Rollback

Set `spray-walls` exposure off, or reduce it to testers. Stop the worker or
restore the last verified image digest; pending jobs and drafts remain durable.
Leave published walls, photos, queue tables and detection history intact. The
DR replica is not promoted or repurposed. Restore primary/storage connectivity,
then retry failed jobs. An image rollback must retain the job's pinned model;
incompatible model identities fail rather than silently changing predictions.
