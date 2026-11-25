# Spray recognition: homelab rollout

## Native client compatibility

The mobile app uses service recognition. The former on-device ONNX runtime,
model downloader/cache, benchmark route, Android autolinking shim, and iOS
increased-memory-limit entitlement have been removed. This removal requires a
fresh iOS/Android binary; it cannot be delivered only through an OTA update.
Older installed binaries may retain cached model files, but current code neither
downloads nor loads them. Camera permissions and shared TypeScript
recognition/training decoding remain. Recognition exposure is gated independently
of native release publication. No photos or wall records are removed by the
runtime cleanup.

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

The detector's pg-boss pool uses the workers' read deadlines: 30 s client-side,
25 s server-side (`docs/operations/db-connectivity.md`, "Worker job-queue read
deadline"). As a backstop, a probe every 15 s reads pg-boss's worker state. If
the detection loop has not fetched, finished a job or reported an error for
300 s, the detector logs `work_loop_stalled` and exits, and Docker's
`restart: unless-stopped` starts a fresh process. A failing fetch still counts as
a live loop, since a restart cannot fix a database outage.
`boardsesh_detector_work_loop_age_seconds` exposes the age on `/metrics`.

The probe guards the Drizzle pool too, which claims and finishes jobs and has no
read deadline. A probe that fails is a database outage: `/health` turns 503 and
the detector keeps running. A probe still waiting after 180 s means a hung
socket: the detector logs `probe_stalled` and exits the same way. Docker never
restarts a container just for being unhealthy, so the exit is what recovers it.

Mobile polls in the foreground and resumes by draft version. New-wall owners
can choose manual placement while waiting. A reset has no empty-result fallback
that can silently remove all existing holds: it retains the published wall and
can be resumed from its stored photo after leaving the app.

## Queue progress and completion delivery

My Boards shows saved drafts, waiting imports with a queue position when known,
running imports, ready-to-review results and failures. Owned unpublished walls
temporarily lead the first page ahead of pinned/recent boards. First publication
restores their usual order; published resets are never promoted. A published wall remains
usable during a photo reset; its review action resumes the exact draft version.
Progress details are editor-only. Queue rank is based on pg-boss's active work
and eligible waiting jobs, in priority/FIFO order, with blocked/deferred jobs
excluded. No rank is shown for processing, backoff or ambiguous ties. Foreground
board screens poll a lightweight batch read every five seconds while work is
active; detection screens poll every two seconds. Connection loss masks cached
ranks without reporting a model failure.

The detector's successful, attempt-fenced transaction persists its result and
queues `spray-wall-detection-completed` together. A stale worker cannot generate
a completion event. The backend consumer rechecks that the source draft and
requester's edit access remain valid. The detection UUID deduplicates the feed
notification. Only successful recognition sends a completion notification;
results still require review/publication.

Expo Push device registration is separate from Live Activity APNs registration.
Devices register the account, installation, Expo token, platform and locale;
logout deactivates that account's registration. Recognition requests may prompt
for permission, but denial and registration errors leave imports and in-app
notifications available. Browser users receive the in-app notification only.
Native token-change callbacks reuse the supplied device token when exchanging it
for an Expo token. Requesting a native token again from that callback emits
another event and can loop. Matching events and concurrent registrations share
work; delayed exchanges cannot replace a newer token or another account's registration.
Backend delivery uses per-device records, retry jobs and receipt checks, and
retires invalid tokens. Expo phone delivery is best effort; an accepted ticket
is not proof the phone displayed an alert.

## Deploy order

1. Provision a dedicated `boardsesh_detector` login on the primary. Store its
   password and a new private-bucket read-only R2 token in the Homelab 1Password
   item **Boardsesh hold detector**. Never put credentials in Git or PR bodies.
2. Apply migrations through `0252_cloudy_venus.sql` (including `0251_safe_moon_knight.sql`) using
   the existing migration-owner connection with
   `MIGRATION_DETECTOR_ROLE=boardsesh_detector`. The migrator initializes
   pg-boss 12.33.0 and queues under that owner, then grants DML to the runtime
   and worker roles. Backend and worker startup disable schema migration. Do
   not grant runtime CREATE privileges as a workaround for startup errors.
3. Deploy the backend with progress APIs, notification-device registration and
   completion/delivery consumers before updating the detector. Then deploy the
   attested `ghcr.io/boardsesh/hold-detector` image
   pinned by digest through the Ansible repo. VM 158 is proposed; provisioning
   must validate cluster/IP allocation. Use the role's private `/health` and
   `/metrics` endpoints and Boardsesh alerts. No public inference API exists.
4. Configure the EAS project's APNs and FCM push credentials, and verify the
   app exposes its EAS project ID. If Expo push-security access-token protection
   is enabled, set backend `EXPO_ACCESS_TOKEN`; otherwise it is optional. Ship
   the app after the new backend APIs are available. Set `GOOGLE_SERVICES_JSON`
   to the path of the Android package's `google-services.json` in the Android
   native build (`android-apk-rn.yml`) AND in every OTA workflow
   (`mobile-ota-production.yml`, `mobile-ota-check.yml`, `mobile-ota-preview.yml`,
   `mobile-ota-backport.yml`): it changes the Android fingerprint, so setting it
   on the build alone stops Android OTAs landing (`scripts/mobile-ci-env-parity.test.ts`
   enforces this). Until a binary built with it ships, Android cannot get an Expo
   push token. Upload the matching FCM V1 service account to EAS as described in
   [Expo's FCM credential setup](https://docs.expo.dev/push-notifications/fcm-credentials/).
   Android needs a new binary
   with the `expo-notifications` config plugin before exposing phone alerts; an
   OTA cannot supply its native configuration. Validate foreground/background
   delivery and authenticated cold-launch taps on real iOS and Android devices.
   Separately merge native cleanup into `release/next` and build new binaries without ONNX or the increased-memory
   entitlement. Retain camera permissions. Old binaries can use service jobs;
   the native dependency removal itself cannot be accomplished by OTA.
5. Complete the service gates below and record evidence before worker promotion.
   Include a busy queue, leaving/reopening a draft, a published reset, permission
   denial and successful completion delivery in tester observations.

## Service release gates (not yet satisfied)

Spray-wall creation and reset screens are now enabled by default; the former
`spray-walls` mobile flag is retired. These gates apply to detection-worker
promotion and quality verification. Mobile availability does not satisfy them.

Database TLS is a deployment gate for **both** pools (Drizzle/postgres.js and
pg-boss/node-postgres). The credential URL must use `sslmode=verify-full` and the
server certificate must match that URL's hostname. A self-signed `localhost`
certificate does not meet this gate for a public Railway hostname. For a private
issuer, mount its public trust certificate read-only and set `NODE_EXTRA_CA_CERTS`
before Node starts. Never mount the server private key on the detector. Verify
successful authenticated queries with both drivers, and rejection of untrusted
and wrong-host certificates. Certificate changes on the primary require a
separate reviewed operator rollout and rollback path; passing code tests alone
does not resolve server trust or authorize starting the worker.

The offline threshold remains **40% gesture savings**. The existing Node-model
work reports **48.2%**; that is prior evidence, not a new measurement from this
rollout. Reproduce on the pinned image/model before promotion. Do not substitute
Python runtime scores: the int8 runtimes have previously differed.

Gesture savings is 1 − (2 × misses + false positives) ÷ (2 × holds): placing a
hold by hand counts 2 gestures and deleting a false positive counts 1. The 48.2%
above follows from that run's precision 0.6909 and recall 0.6214 on the 964-hold
spray `eval` split. `ml/holds/eval.py` writes it as `gesture_savings`, and
`publish_model.py` records it in the manifest as `eval.gestureSavings`.

A retrained model (SW-20, #5471) has to pass the gate on **two** held-out splits:
the hand-labelled spray `eval` split and the `eval` split of the climbers' walls
export. It ships only when gesture savings rises on both against the shipped
model's score on the same split, and stays at 40% or more on both. The
hand-labelled split is the unbiased one, because climbers' labels include the old
model's suggestions that they kept unchanged. The steps are in `ml/holds/README.md`,
"Retrain runbook".

| Service check | Minimum evidence before promotion |
| --- | --- |
| Initial validation | At least 24 hours; a photographed, reset and climbed real wall; 20 reviewed walls across at least 5 users; uploads ≥95%; count-difference proxy ≤15%. |
| Reset validation | At least another 24 hours; at least 10 walls reset (`Board Created` with `isReset: true`); upload and correction gates still pass; no unresolved worker/auth/privacy errors. The in-place reset preview and apply events no longer exist, so there is no preview-to-apply ratio. |
| Ongoing operation | Continue monitoring queue age, failures, latency and RSS; roll the worker back on gate regression. |

Use the existing `SPRAY_ROLLOUT_GATES` definitions. `Spray Holds Reviewed` now
contains both `candidateCount` and `holdCount`, so the count-difference proxy
can be calculated on the same event. It is **not** edit count or F1; equal counts
can hide corrections. Exclude older events without a candidate count, and do
not join unrelated users' detection/review events to manufacture a denominator.

The correction ratio no longer has to be estimated. Every saved hold now records
where it came from (SW-20, #5471): `source` is `manual` for a hold placed by hand,
and an `auto` hold carries `auto_review` = `accepted` (kept as suggested),
`confirmed` (switched on individually) or `edited` (geometry changed). Suggestions
the climber deleted are worked out from the detection's candidates. For the walls
in a training export, `candidates.json` lists every candidate with its fate
(kept, edited, deleted, not shown), so corrections per wall are counted exactly:
edited + deleted + manual holds, over saved holds. Use that count for walls saved
after provenance shipped; older walls have no `auto_review` and still need the
proxy.

Record each observation window, image digest, model hash, participant count,
reviewed-wall count, uploads attempted/succeeded, candidate/saved counts and
walls reset on #5451. No gate may be marked complete from unit tests,
elapsed time alone or fabricated tester events.

## Rollback

Stop the worker or restore the last verified image digest; pending jobs and
drafts remain durable. The retired `spray-walls` flag no longer hides the mobile
surface; new-wall owners can still choose manual placement.
Leave published walls, photos, queue tables and detection history intact. The
DR replica is not promoted or repurposed. Restore primary/storage connectivity,
then retry failed jobs. Imports that expired while the detector was down are
re-queued as described in the next section. An image rollback must retain the job's pinned model;
incompatible model identities fail rather than silently changing predictions.

## Reviving imports that expired during a detector outage

A detection waits at most 24 hours in the queue. If the detector claims nothing
for that long, the backend's reconcile marks it `failed` with `QUEUE_EXPIRED`,
and the climber only gets proposed holds if they find Retry. After an outage,
`packages/backend/src/scripts/revive-expired-spray-detections.ts` queues those
imports again through the same request code the API uses, for the person who
asked, so the usual completion notification reaches them.

The script exists in production only once the PR that added it (#8181) is
merged and the backend has deployed. Restart the detector and confirm it is
claiming jobs first. A revived import gets a fresh 24 hours and expires again if
nothing claims it.

An operator runs this, not an agent. It runs inside the backend service, because
the backend's `DATABASE_URL` points at a Railway-internal host that resolves
only there. It uses that injected `DATABASE_URL`, the writable primary; never
paste credentials into a command or log. `--apply` refuses a connection that is
not a primary.

1. Open a backend shell with explicit targets:

   ```sh
   railway ssh --project afceee45-0af1-46b3-abbe-8b9094c23bc6 \
     --environment 8cd7204e-8ba4-4790-bb64-6a150971eacd \
     --service 5912f97f-aa1e-4274-8fbf-eed5da0dceb9
   ```

2. The image has the source and `tsx` but no `vp`. Move to the backend package
   and check the deployed build has the script:

   ```sh
   cd /app/packages/backend
   test -f src/scripts/revive-expired-spray-detections.ts
   ```

3. Dry run. It prints one line per expired import with the decision, `revive` or
   `skip:<reason>`, using the first 8 characters of each id, and writes nothing:

   ```sh
   node --import tsx src/scripts/revive-expired-spray-detections.ts --since 2026-11-21T07:00:00Z
   ```

   Check the skips against the table below. `--until` (exclusive) narrows the
   window; both flags need a zone (`Z` or `+10:00`).

4. Apply. Each revived line gains `new=<id>`, the new detection:

   ```sh
   node --import tsx src/scripts/revive-expired-spray-detections.ts --since 2026-11-21T07:00:00Z --apply
   ```

5. Run the dry run from step 3 again. Lines revived in step 4 now read
   `skip:superseded`; lines skipped before keep their reason. A second `--apply`
   revives nothing, so a run that stopped on an error can be re-run as is. A
   failure prints only the error's class and Postgres code, never its message,
   because a query error's message carries the requester's id and the photo key.

Each import is checked again inside its write transaction, under the same
requester and wall locks the API takes. The hourly limit of 10 requests is not
checked here, because these are requests the climber already made once. A
revived request still counts toward that climber's own limit for the next hour.

| Skip reason | Meaning |
| --- | --- |
| `requester-gone` | The requesting account was deleted. |
| `wall-deleted` / `board-deleted` | The wall or its board was deleted. |
| `wall-archived` | A published reset replaced the wall. |
| `not-draft` | The version was published or superseded. |
| `photo-changed` | The draft has a different photo now. |
| `superseded` | A later request exists for the same draft and photo: a retry, or this script's earlier run. |
| `manual-edits` | The climber placed or took off holds by hand on the draft while waiting. |
| `no-edit-access` | The requester can no longer edit the wall (`canEditBoard`, the API's rule). |
