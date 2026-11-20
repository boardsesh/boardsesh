# CNC build packs

Boardsesh sells generated CNC manufacturing packs for climbing-wall panels: DXFs
per panel, printable PDFs, a bill of materials and build notes, licensed per
wall. The app stays free and open source; the packs are the paid thing.

**Buyers iterate for free and pay at the end.** Configuring a wall produces a
watermarked, rasterised PREVIEW — pictures of the sheets, no DXF, no manifest,
stamped NOT FOR MANUFACTURE — and only when the buyer likes what they see do
they finalise it into a purchase. Nobody pays for a wall they have not looked
at, and nobody has to pay to find out what the pack looks like.

The generator itself lives in a private repo and runs as a separate worker
service. This document covers the Boardsesh half: previews, orders, payment,
the job API the generator pulls work from, and the download routes.

## Supported layouts and OG drilling

The catalogue offers Kilter Homewall (layout `8`) and Kilter Original (layout
`1`). Original sizes are `14` (7×10), `8` (8×12), `10` (12×12), and `28`
(16×12). Both Original sets, `1` and `20`, are required at every size. Pricing
uses the existing personal and commercial single-build tiers.

Original orders store `options.includeKicker`: false for 7×10, true by default
and optional for the other three sizes. Original main-wall and kicker holds
share their set IDs, so removing sets cannot remove its kicker. Layout previews,
artwork validation and claimed jobs send this as `manufacturing.include_kicker`;
when true they also send the selected `kicker.mat_clearance_mm`. Homewall still
selects the kicker with sets `28,29`, and older stored orders continue to infer
that selection without acquiring an Original default.

Original foot positions have a 13 mm center bore, plus LED bores 20 mm above
and below. An Original foot LED uses the center bore instead of a T-nut. The
additional pair allows that position to serve a Homewall hold later. Original
LED bores default to 12.7 mm; the configurable bolt bore remains 12.5 mm by
default elsewhere. Packs include the complete matching Homewall pattern:
7×10, 8×12, or a centered 10×12 within either larger Original wall. They do not
claim compatibility with a nonexistent larger Homewall layout.

The worker layout JSON distinguishes `dual` center bores from ordinary bolt
and LED bores. Installed hardware counts are separate from spare compatibility
holes. Original orientation engraving follows the manufacturer's **Number
Angle** column; it indicates the hold number's orientation rather than a
set-screw drilling direction. The source workbooks, normalization and geometry
are maintained in the private generator repo.

Deploy the generator with Original support before deploying this catalogue
version. The existing `cnc-packs` feature gate still controls the shop; there
are no new public routes or database migrations.

## Orders and the durable queue

In production, `CNC_TRANSPORT=pgboss` uses two dedicated worker roles on the
CNC VM: `cnc-interactive` for layout/artwork and `cnc-generation` for previews
and paid packs. Each has its own queue and one active job, so rendering a pack
cannot block the configurator. Six database connections are reserved in total.
The VM makes outbound verified-TLS connections to the existing primary and R2;
it has no public listener, tunnel, public DNS name or browser SSO dependency.

The order remains the source of truth for configuration, payment, licence and
published artifacts. Preview creation, paid webhook handling and regeneration
enqueue pg-boss work in the same transaction as their order change. A generation
is bound to its run ID; publication checks the current attempt fence, generation,
status and claim token again. Refunds and superseded attempts cannot publish.
Full packs take priority over previews. Backend reconciliation adopts queued
legacy rows and marks exhausted/crashed runs terminal; the VM is not the reaper.

Layout/artwork use `requestCncLayout` / `requestCncArtworkValidation` and poll
`cncComputation`. Only hole-free layouts are public. Hole/artwork results belong
to the submitting account, expire after 90 seconds, and never enter generic job
output. Browser polling stops when configuration or account scope changes.
Private requests/results are reclaimed after 24 hours, in bounded backend passes.
The old synchronous GraphQL fields remain compatible through bounded queue waits.

Python runs locally through a versioned stdin/stdout protocol. Startup verifies
the actual generator SHA before consuming anything. Only authorized immutable
artwork bytes cross that boundary. Private fingerprint manifests are written to
the protected order, not to pg-boss output or logs. The worker stops new claims
on SIGTERM and drains for 600 seconds; container and host shutdown budgets exceed
that allowance. Emails and analytics remain backend-owned with leased retries.

One row in `cnc_orders` exists per previewed configuration, and that same row
becomes the licence when the buyer purchases it. Its visible states remain:

| From | Event | To |
| --- | --- | --- |
| — | `createCncPreview` | `preview_queued` |
| `preview_queued` / `preview_generating` (stale lease) | worker claim | `preview_generating` |
| `preview_generating` | complete | `preview_ready` |
| `preview_generating` | fail | `preview_queued`, or `preview_failed` once the attempt budget is spent |
| `preview_ready` | `finaliseCncOrder` | `pending_payment` |
| `pending_payment` | Stripe would not open a session | `preview_ready` (the preview is still good) |
| `pending_payment` | `checkout.session.completed` (paid), or `checkout.session.async_payment_succeeded` | `queued` |
| `pending_payment` | `checkout.session.expired`, or `checkout.session.async_payment_failed` | `cancelled` |
| `queued` / `generating` (stale lease) | worker claim | `generating` |
| `generating` | complete | `ready` |
| `generating` | fail | `queued`, or `failed` once the attempt budget is spent |
| verified charged `pending_payment` or any paid state | `charge.refunded` | `refunded` (generation and downloads stop) |
| `ready` / `failed` | admin regenerate | `queued` |

The table lives in `packages/backend/src/services/cnc/order-state.ts` as data.
Every real transition is a conditional `UPDATE ... WHERE id = $id AND status IN
(...)`, so a zero-row result means somebody else already moved the order and the
caller no-ops. That is what makes a Stripe redelivery and a late worker report
harmless.

Three invariants the table enforces on its own:

- **The only way into `pending_payment` is `finalise`, and the only status it
  opens from is `preview_ready`.** Nothing can be bought that was not previewed
  first.
- **`pending_payment -> queued` happens in exactly one place: the paid
  webhook.** Nothing else queues a pack, which is what stops an unpaid order
  reaching the generator — even though its own preview went through the same
  worker minutes earlier.
- **Nothing moves an existing row back into a preview queue.** Re-previewing
  writes a NEW row (below), so the images already handed to a buyer never start
  describing a different wall.

### Re-previewing

A preview is an immutable snapshot of one configuration, so "preview this
again" is `createCncPreview` again, not a transition:

- **Same configuration** — `config_hash` matches a `preview_queued`,
  `preview_generating` or `preview_ready` row of this buyer's, and that order
  comes straight back. This is also how a client polls a preview it is waiting
  for, so it deliberately costs nothing against the hourly ceiling.
- **Changed configuration** — a different hash, so a new order with a new
  licence id. The old one stays where it is; the UI shows the latest.
- **Failed preview** — `preview_failed` is not a dedupe match, so asking again
  really does queue a new job.

`config_hash` is sha256 over the NORMALISED configuration (the catalogue's
canonical tuple, options with every default filled in, artwork placements), with
object keys sorted, so two clients that reach the same wall by different routes
dedupe against each other and a single moved millimetre does not.
`services/cnc/config-hash.ts`.

### What a preview costs

**Four previews per hour per buyer**, counted in the database
(`countOrdersCreatedSince`) rather than through `applyRateLimit`, whose window
is one minute — four a minute is not the limit anyone meant, and an in-process
limiter that resets on every deploy is not a limit on something that costs real
generator seconds. `applyRateLimit` still runs on top of it as the cheap burst
guard that never reaches Postgres.

The attempt budget is per DELIVERABLE, not per row: `finalise` resets `attempts`
and clears the lease, so a wall whose preview needed two goes still reaches the
paid queue with all three attempts.

## Stripe

Out-of-order refunds resolve ownership through canonical PaymentIntent metadata.
That lookup has a 10-second timeout and no SDK retries; a lookup outage leaves the
webhook unprocessed so Stripe can redeliver it.


Hosted Stripe Checkout, AUD, Stripe Tax for GST. Two tiers in v1: Personal
(one wall, own non-commercial use) and Commercial single-build (one identified
customer installation, which is why those orders carry a site name).

### Stripe dashboard prerequisites

Set up before the first live sale, none of it in code:

- **Terms of Service URL** — Settings → Public details. `consent_collection`
  requires one to be set or Checkout Sessions fail to create.
- **Stripe Tax enabled, with an AU GST registration.** `automatic_tax.enabled`
  on the session assumes Tax is switched on and the registration exists; it
  does not enable either for you.
- **The two AUD prices** — one per tier, named by the env vars below. Prices
  live in Stripe, never in the repo.
- **The webhook endpoint, with all five events** — see the table below. Fewer
  than five is a silent gap: a missing `async_payment_failed`, say, leaves a
  declined delayed-payment order in `pending_payment` forever, with nothing to
  cancel it.
- **Payment methods** — instant methods (card, Apple Pay/Google Pay, etc.) are
  always safe to enable. Delayed-payment methods are safe too now that the
  webhook handles their async events; see the note under the events table
  below.

### Checkout

`Mutation.finaliseCncOrder` takes a `preview_ready` order the caller owns, writes
the tier, the licensee and the licence acceptance onto it, moves it to
`pending_payment`, and then opens the session. That order matters — the webhook
finds the row by `metadata.orderId`, so the row has to exist before a payment
can complete, and here it has existed since the buyer asked for a preview.

**The configuration is not re-submitted.** `FinaliseCncOrderInput` carries an
`orderId` and the licence details, nothing else: the row already holds the wall
the buyer approved in the preview they are looking at, and taking it again would
be a way to pay for one wall and receive another. The price comes from the
catalogue entry for the ORDER's own tuple, so a wall retired between preview and
finalise is refused rather than sold at last week's number.

If Stripe will not open a session the order goes back to `preview_ready`, not to
`cancelled`: the preview is still perfectly good, and making a buyer regenerate
one because of our outage would cost them a slot in the hourly budget as well as
the wait. `sendCncOrderStuckAdminEmail` still pages an operator when that revert
ALSO fails, because a row stranded in `pending_payment` has no
`checkout.session.expired` coming to retire it.

The session carries the order back three ways, deliberately redundantly:

- `metadata.orderId` — what the webhook looks the row up by.
- `metadata.licenceId` — cross-checked against the row, so a session pointing at
  the wrong order is ignored rather than queueing somebody else's pack.
- `client_reference_id` — the licence id again, for the Stripe dashboard, which
  is where support actually looks.

The same metadata is copied onto the PaymentIntent, because a refund arrives as
a charge with no session in sight.

Sessions expire 31 minutes out. Stripe's floor is 30 minutes measured against
its own clock when the request lands, so the extra minute is latency cushion,
not a product decision.

### Webhook

`POST /api/cnc/stripe/webhook` — registered in `server.ts`, handler in
`packages/backend/src/handlers/cnc-stripe-webhook.ts`.

No CORS and no bearer token: the `stripe-signature` header over the **raw** body
is the authentication. The route reads the body as a string and verifies before
parsing — anything that re-serialises the JSON first breaks verification in a
way that looks like a wrong secret. The body is never logged; it carries the
buyer's email and the full charge record.

Subscribe these five events in the dashboard:

| Event | Effect |
| --- | --- |
| `checkout.session.completed` | Queues the pack, but only when `payment_status` is `paid` — the event also fires for delayed-payment methods where the money is not there yet. |
| `checkout.session.async_payment_succeeded` | A delayed-payment method (e.g. a bank debit) cleared after the session completed. Queues the pack exactly like a paid `checkout.session.completed`, with `paidAt` taken from this event's own `created`. |
| `checkout.session.expired` | Cancels the reserved order. |
| `checkout.session.async_payment_failed` | A delayed-payment method was declined. Cancels the reserved order the same way `checkout.session.expired` does — there is no separate state-table event for it. |
| `charge.refunded` | Marks the order refunded and blocks downloads. Found by payment intent; partial refunds count. |

Only instant payment methods (card, Apple Pay/Google Pay, etc.) need to be
enabled for the happy path. Delayed-payment methods (bank debits and the like)
are safe to enable too: `async_payment_succeeded`/`async_payment_failed` above
is what makes them work correctly — a session that completes before the money
actually clears no longer risks queueing a pack for a payment that can still
fail.

Status codes are a contract with Stripe's retry machinery:

- **400** only for a body that did not come from Stripe (bad or missing
  signature, oversized payload).
- **500** when the database or canonical payment lookup temporarily fails;
  Stripe can redeliver the unprocessed event.
- **200** for everything else, including ignored event types, unpaid sessions,
  unresolvable orders and redeliveries. An event we decided not to act on is
  handled, not failed.

The event claim, order transition and processed stamp commit in one database
transaction. Concurrent deliveries serialize on the event id; only a fully
processed duplicate receives `{received: true, duplicate: true}`. A failed or
killed transaction rolls back its claim, allowing Stripe to retry. Legacy
unfinished claims are locked and retried rather than acknowledged as complete.

Refunds are correlated by the stored PaymentIntent id or, when checkout
completion has not arrived, canonical PaymentIntent metadata cross-checked
against the order and licence. Checkout and refund processing lock the order,
so either delivery order converges to `refunded`. A verified charged order can
move directly from `pending_payment` to `refunded`; later checkout completion
cannot queue it. Unrelated charges remain ignored.

### Stripe Tax

`automatic_tax.enabled` is on for every session, and Checkout collects the
address it needs. Getting this wrong is a tax problem rather than a UX one, so
it is not configurable per order. The AU GST registration is set up in the
Stripe dashboard, not in code.

`cnc_orders.amount_cents` stores `session.amount_total` — what the buyer was
actually charged, **GST-inclusive**. It is never the catalogue's pre-tax
`priceCents`. The `Build Plans Pack Purchased` analytics event also carries
`amount_excluding_tax_cents`, the GST-exclusive equivalent computed from
`session.total_details.amount_tax` (null when Stripe reported no tax
breakdown) — that field exists for revenue reporting and is not persisted on
the order row.

## Legacy HTTP worker API

This section documents rollback compatibility. When `CNC_TRANSPORT=pgboss`,
all `/api/cnc/worker/*` routes return 404 and the custom claim loop is disabled.
Do not deploy an HTTP poller alongside the pg-boss consumers. The production
worker requires no shared HTTP worker secret or backend-to-homelab URL.


The generator PULLS work. Boardsesh never calls it to start a job, which is what
lets the worker restart, scale and redeploy without anything here knowing. Every
route lives under `/api/cnc/worker/`, is dispatched by
`packages/backend/src/handlers/cnc-worker.ts`, and carries:

```
Authorization: Bearer ${CNC_WORKER_SECRET}
Content-Type: application/json
```

The secret is compared in constant time. **The whole API 404s when
`CNC_WORKER_SECRET` is unset** — unmounted, not broken, the same convention
`apns-stats.ts` uses. A wrong secret is a 401.

No CORS anywhere: no browser calls any of it.

### Two credentials, not one

The bearer secret says *you are the worker fleet*. The job's `claimToken` says
*you are the worker that currently holds this job*. Both are needed on every
route except `claim`, because a worker whose lease expired mid-job is still a
legitimate member of the fleet and must not be able to finish over its
replacement. The claim token is folded into the same conditional `UPDATE` as the
status, so "this report belongs to the current lease" is atomic rather than a
read the reclaim can race.

A **409 always means the same thing: this job is not yours any more.** Drop it.
Do not retry.

### `POST /api/cnc/worker/claim`

```json
{ "workerId": "railway-replica-abc123" }
```

200 with `{"job": null}` when there is nothing to do — the common answer, since
the worker polls every few seconds. Otherwise:

```json
{
  "job": {
    "orderId": 41,
    "licenceId": "BS-CNC-K7QM3T",
    "deliverable": "full",
    "claimToken": "0f0a…",
    "generation": 1,
    "attempt": 1,
    "tier": "personal",
    "licensee": { "name": "…", "email": "…", "customerSiteName": null },
    "config": {
      "boardName": "kilter",
      "layoutId": 8,
      "sizeId": 25,
      "setIds": [26, 27, 28, 29],
      "options": { "sheetStock": "2440x1220", "…": "…" },
      "artwork": [
        {
          "assetId": null,
          "mime": null,
          "text": "Send it",
          "font": null,
          "mode": "engrave",
          "placement": { "panelIndex": 0, "xMm": 600, "yMm": 900, "widthMm": 200, "rotationDeg": 0 }
        }
      ]
    },
    "catalogVersion": "2026-09-06.1",
    "layoutRequest": {
      "board": { "board_name": "kilter", "layout_id": 8, "size_id": 25, "set_ids": [26, 27, 28, 29] },
      "manufacturing": {
        "sheet": { "length_mm": 2440, "width_mm": 1220, "thickness_mm": 18 },
        "grid_pitch_mm": 100,
        "tnut_hole_diameter_mm": 12.5,
        "led_hole_diameter_mm": 12.5,
        "stud_clearance_offset_mm": 60,
        "kicker": { "mat_clearance_mm": 50 }
      }
    },
    "output": {
      "engrave": { "holdIds": false, "angleTicks": false },
      "dxfFlavour": "R12_circles",
      "paper": "A3"
    },
    "outputKey": "cnc-packs/<owner>/<licence_id>/g1/full/a1/pack.zip",
    "previewPrefix": "cnc-packs/<owner>/<licence_id>/g1/full/a1/preview/",
    "bucket": "<private bucket name>",
    "issuedAt": "2026-09-06T02:14:11.402Z"
  }
}
```

Notes the worker implementer needs:

- **`deliverable` is the only thing to branch on.** `"full"` is the licensed
  pack, unchanged. `"preview"` is the free one: render every sheet (panels,
  kickers, supports, assembly) as a RASTER page — PNG at 110 dpi with a
  repeating diagonal `PREVIEW · NOT FOR MANUFACTURE · <licenceId>` watermark at
  35 % opacity — assemble them into one `preview_sheets.pdf` with no vector
  content at all, upload each sheet PNG individually under `previewPrefix`
  (`panel1.png`, …, `assembly.png`), and put a `README_PREVIEW.txt` and a
  counts-only `BOM.md` in the zip. **No DXF, no assembly DXF, no manifest, no
  fingerprint.** The INFO layer text says `PREVIEW`. Target under 15 s for a
  10x12: reuse the existing render path at preview resolution.
- **A preview job has no licensee and no tier.** `tier` is `null` and
  `licensee.name` is `null`, because nothing has been licensed yet — the
  watermark is what the sheets say instead of a name. A `full` job always has
  both.
- **`outputKey` is the preview's own key on a preview job**
  (`g<generation>/preview/a<attempt>/preview.zip`), separate from the full
  pack at `g<generation>/full/a<attempt>/pack.zip`.
- **`previewPrefix` is where the sheet PNGs go, and it is enforced.** Every key
  in a completion's `previewKeys` must start with it and end in `.png`, or the
  completion is refused with a 409 and nothing is stored. Those strings become
  reads of the private bucket, which also holds user data exports, so the rule
  lives at the write.
- **The envelope is camelCase; `layoutRequest` is snake_case.** The envelope is
  Boardsesh's; `layoutRequest` is the generator's own pydantic model, byte for
  byte what `POST /layout` takes, so it can go straight into `compute_layout`
  with no second translation.
- **`outputKey` is dictated, never invented.** `anon` appears when the buyer
  deleted their account. Every generation and attempt has its own path, including
  preview images. A worker that loses its lease can upload only to its own
  attempt path. The claim-token-guarded completion publishes the winning keys;
  downloads read those saved keys rather than recomputing them from the latest
  attempt counter. Stale artifacts are never published or deleted automatically.
- **`attempt` is 1-based and counts reclaims.** `generation` only moves on an
  admin regenerate.
- **`artwork[].assetKey` and `mime` come off the ORDER, not off
  `cnc_art_assets`.** The asset row cascades away with its uploader's account
  while the licence survives, so the copy taken at checkout is the one that
  still answers on a regenerate. See [Artwork](#artwork).
- **503** means the private bucket is not configured on our side. Retry later;
  it is an operator problem.

The claim is one transaction: `SELECT … FOR UPDATE SKIP LOCKED` over queued rows
plus stale leases, then the claim write in the same transaction. Two workers
polling at once get different rows or nothing. The claim also runs the reaper
first (see below), so **there is no scheduler job** — the worker's own poll is
what fails abandoned work.

**Paid packs are handed out before free previews**, then oldest first within
each. A buyer who has paid is waiting; a buyer previewing is still deciding, and
a burst of previews must never leave a purchase sitting behind them. It is a
sort key on the one scan rather than two queries, because a second pass would
need a second lock and could hand a worker nothing while a row sat free between
them.

### `POST /api/cnc/worker/jobs/:orderId/heartbeat`

```json
{ "claimToken": "0f0a…" }
```

200 when the lease is still yours, 409 when it is not. Send one every 60 s.

### `POST /api/cnc/worker/jobs/:orderId/complete`

```json
{
  "claimToken": "0f0a…",
  "zipKey": "cnc-packs/user_abc/BS-CNC-K7QM3T.zip",
  "sizeBytes": 4194304,
  "sha256": "<64 lowercase hex>",
  "fingerprintManifest": { "…": "…" },
  "bomSummary": { "…": "…" },
  "previewKeys": ["…"],
  "generatorVersion": "1.4.0"
}
```

Upload the zip **first**, then report. Boardsesh verifies before it marks the
order ready, because "ready" is what unlocks the buyer's download and an order
that says ready and 404s is worse than one still generating:

| Check | Failure |
| --- | --- |
| `zipKey` equals the job's `outputKey` | 409 |
| a HEAD finds an object at that key | 409 |
| its size equals `sizeBytes` | 409 |
| the lease is still yours | 409 |

On success the order moves to `ready` and the buyer gets the pack-ready email.
`bomSummary`, `previewKeys` and `generatorVersion` are folded into the stored
manifest.

**A preview completion** posts the same body against the same route and is told
apart by the order's status, not by anything in the body. It adds one check —
every `previewKeys` entry must be a `.png` under the job's `previewPrefix` — and
then:

| Full | Preview |
| --- | --- |
| `zip_key`, `zip_size_bytes`, `zip_sha256`, `generated_at` | `preview_zip_key`, `preview_zip_size_bytes`, `preview_keys`, `preview_generated_at`, `previews_generated + 1` |
| status `ready` | status `preview_ready` |
| pack-ready email to the buyer | no email — the buyer is watching the page |
| `fingerprintManifest` stored verbatim | no fingerprint; the column holds `{deliverable: "preview", bomSummary, generatorVersion}` |
| `Build Plans Pack Purchased` already fired at the webhook | fires `Build Plans Preview Generated` |

`fingerprintManifest` is optional on the body for exactly this reason: there are
no covert channels in a watermarked raster, so there is nothing to record.

**Complete is idempotent by claim token.** The token is *not* cleared on the
ready transition — it becomes the receipt for that completion. A worker whose
200 was lost to a dropped connection can send the identical body again and gets
`{"ok": true, "status": "ready", "duplicate": true}`: no second transition, no
second email. Any other token, and any other status, is still 409 — including a
report from a worker whose lease was reclaimed while it was uploading. Nothing
else can act on the surviving token either: heartbeat and fail both require
`generating`, and an admin regenerate clears it.

A job that cannot be turned into a payload never reaches this route. `claim`
refuses an order with no licensee name (it is printed on every sheet) and one
whose stored artwork placement is missing any of `panelIndex`, `xMm`, `yMm`,
`widthMm` or `rotationDeg`. Both fail the order outright and mail an operator,
because a retry would rebuild the identical unbuildable payload. **The manifest is never logged and never
leaves the backend** — it is the map of which covert channels carry which
values, and publishing it would tell a leaker exactly what to strip.

### `POST /api/cnc/worker/jobs/:orderId/fail`

```json
{ "claimToken": "0f0a…", "errorCode": "SEAM_TOO_CLOSE_TO_HOLE", "message": "row 12", "retryable": true }
```

`message` has no length limit — a generator traceback is easily longer than a
few thousand characters, and a 400 on the failure report would leave the order
stuck in `generating` with nobody told. Boardsesh truncates it to 2000
characters on the way into `last_error`; the 2 MB body cap is the real ceiling.

The worker reports what happened; the state machine decides what it means:

- `retryable: false` → `failed` immediately.
- `retryable: true` → back to `queued` until the attempt budget (3) is spent,
  then `failed`.

A preview failure runs the same budget on its own pair of statuses
(`preview_queued` / `preview_failed`).

`failed` mails an operator with the real error. **`preview_failed` does not**:
nobody paid for it, the buyer sees the failure on the page they are looking at
and can ask again, and one email per misconfigured wall somebody is
experimenting with would bury the emails that mean a purchase is stuck. It is
still logged at `error`.

The buyer only ever sees a fixed public message — a different one for each, since
"we have been notified and will be in touch" is not true of a free preview.
`last_error` is stored truncated to 2000 characters.

### Leases and the reaper

| Constant | Value | Where |
| --- | --- | --- |
| Lease window | 10 min without a heartbeat | `CNC_LEASE_MS` |
| Attempt budget | 3 | `CNC_MAX_ATTEMPTS` |

A `generating` (or `preview_generating`) row whose heartbeat is older than the
lease window is reclaimable while `attempts < 3`; the next claim takes it,
increments `attempts` and issues a **fresh claim token**, which is what makes the
dead worker's eventual report a 409. Once the budget is spent, the first
statement of the next claim (`failStaleExhaustedJobs`) moves the row to `failed`
(or `preview_failed`) and mails an operator for the paid one — without it, a
worker that dies on its third attempt would sit in `generating` forever, because
the claim's candidate filter excludes it.

A null heartbeat counts as stale: that is a worker that died between claiming and
its first report.

### `GET /api/cnc/worker/assets/:assetId?orderId=&claimToken=`

Streams one uploaded art asset from the private bucket. Two shapes, both behind
the fleet secret, like every other worker route:

- **Leased** — `orderId` and `claimToken` both present. The buyer has checked
  out and this is the worker currently building *that* order. Two more gates
  on top of the secret: the job's lease (so the caller is the worker holding
  *this* order, not merely a member of the fleet) and the order's own artwork
  list naming this asset id. Resolution prefers the `cnc_art_assets` row
  (authoritative for key and mime) and falls back to the copy the order stored
  at checkout. The asset id alone is deliberately never enough here — it
  reaches the route from the generator, which got it from a job payload, and
  the private bucket it would otherwise address also holds user data exports.
- **Unleased** — both absent. `validateCncArtwork` runs before checkout, so
  there is no order yet to lease against; the fleet secret is the whole gate,
  and the asset is looked up by id alone (`getArtAssetById`, no ownership or
  order scoping). Safe because `asset_ref` — the only way an id ever reaches
  the generator — is only ever set to an asset Boardsesh already checked
  belongs to the caller (`resolveArtworkAssets`), and because `:assetId`'s own
  charset restriction in the route pattern is what stops the id addressing
  anything else.

One of the two params present without the other is a 400, not read as either
shape.

The key is re-matched against `cnc-art/<user>/<uuid>.<ext>` before it becomes a
read on either path, even having come from our own row: this is the one place a
stored string turns into a bucket fetch. The response's content type is the
mime sniffed at upload, held to an allowlist (`image/svg+xml`, `image/png`) — a
stored mime outside it is a 500, logged, rather than a guess — with a
`Content-Disposition: attachment; filename="<assetId>.<ext>"` and
`X-Content-Type-Options: nosniff`.

## Artwork

A buyer may route up to four items into their pack: typed labels and uploaded
SVGs. Both go through the same input (`CncArtworkInput`), the same generator
validation, and the same limits — published on `CncCatalog.artworkRules` from
the very constants that enforce them, so a configurator's slider bounds and a
server rejection cannot disagree.

Ownership is checked at `createCncPreview`, which is where the asset's key and
mime are copied onto the order row and therefore the only place an order is ever
written. `cnc_art_assets.order_id` is stamped at FINALISE instead, and stamping
is now best-effort: one upload legitimately appears in several orders (every
preview iteration is a row of its own, and a buyer may build two walls with the
same logo), so `order_id` is a cleanup-sweep marker rather than an exclusive
claim. A short attach costs traceability, never authorisation.

`artworkRules.allowedKinds` is the menu, and `CncArtworkKind` is the vocabulary.
Today the menu is `['text', 'svg']`. **PNG is deliberately in the vocabulary and
out of the menu**: `POST /api/cnc/art` accepts a PNG, so the upload, storage,
worker-stream and cleanup paths are exercised by real raster files, but the
generator's tracer is v2 — so `resolveArtworkAssets` refuses a PNG asset at
checkout with `CNC_INVALID_CONFIG` and the configurator hides the option.
Enabling it is `CNC_ALLOWED_ARTWORK_KINDS` in `services/cnc/catalog.ts` plus a
`CNC_CATALOG_VERSION` bump, once the tracer exists. The configurator hiding the
option is a courtesy; the resolver refusing the asset is the enforcement.

`CncCatalog.artworkFonts` mirrors `FONT_FILES` in the generator's
`cncpack/dxf/text.py`, default first. Only faces that ship inside the
generator's image can be offered: every character is outlined against a real
font file, and the generator rejects an unknown font rather than substituting
one — precisely so the shape the buyer approved is the shape that gets cut.
Adding a face means shipping the file in the generator first, then adding the
key to `CNC_ARTWORK_FONTS` and bumping `CNC_CATALOG_VERSION`.

### `POST /api/cnc/art`

Handler `packages/backend/src/handlers/cnc-art-upload.ts`; answers `OPTIONS` and
sets CORS the way `/api/user-data-export` does, because the configurator posts to
it from the browser.

Its own handler rather than a third `createGymImageUploadHandler` config. The
gym uploads are raster-only precisely so an inline `<svg>` can never execute on
the anonymous kiosk, embed and gym surfaces that serve them back. Build-pack
artwork is the opposite: SVG is the format that routes well, and nothing ever
renders these bytes in a browser — they go to the private bucket and come back
out exactly once, to the generator, over an authenticated worker route with
`nosniff`.

| | |
| --- | --- |
| Auth | User `Authorization: Bearer <session token>`, via `validateToken`. |
| Rate limit | 20 per user per hour (`checkRateLimitRedis`, operation `cncArtUpload`). |
| Body | `multipart/form-data`, field `art`, one file, busboy-capped at 5 MB. |
| Accepts | PNG (sniffed with `detectImageMimeType`, 64–4096 px each side via `sharp`) and SVG (sniffed by root element, then sanitised). |
| Stores | `uploadToS3('private', bytes, cncArtAssetKey(userId, uuid, ext), mime, { cacheControl: 'private, no-store' })`, **then** `createArtAsset`. |
| Returns | `{ assetId, mime, widthPx, heightPx, sizeBytes }`. |

Status codes: `401` unauthenticated · `413` over the 5 MB cap · `415` neither a
PNG nor an SVG · `422` a readable file we will not route (the sanitiser's reason,
or a PNG outside the pixel bounds) · `429` over the hourly budget · `503` the
private bucket is not configured. Every non-2xx body carries `{ error, reason }`
where `reason` is a stable code the web maps to a translated sentence.

Three rules the handler will not bend:

- **The declared content type is never consulted.** The mime on the row, and
  therefore the mime the worker asset route serves, is derived from the bytes.
- **The stored bytes are the sanitised bytes**, and `sha256` is of those — not of
  what was uploaded.
- **Nothing logs file contents.** A rejection logs the user, the size and the
  reason code, and nothing else.

### The SVG sanitiser

`packages/backend/src/services/cnc/svg-sanitiser.ts`. Parses with
`@xmldom/xmldom`, audits, and **re-serialises the cleaned document** — that
output is what goes in the bucket. Passing the original through would leave
every construct the parser tolerated but the auditor never looked at.

It is at least as strict as the generator's own `cncpack/geometry/svg.py`
re-audit, which is the point: a rejection there is a paid order that fails to
build.

| Rule | |
| --- | --- |
| Size | 2 MB of UTF-8, the same `MAX_SVG_BYTES` the generator uses. |
| Elements | **Allowlist**: `svg g path rect circle ellipse line polyline polygon text tspan defs clipPath title desc`. Anything else is a rejection — not a strip. |
| Stripped | `<metadata>` and `<sodipodi:namedview>` (editor bookkeeping every Inkscape export carries), and comments. |
| DTD | Any `DOCTYPE`/`ENTITY` is a rejection, so nothing is ever expanded. |
| Instructions | The XML declaration is kept; every other processing instruction — `<?xml-stylesheet?>` above all — is a rejection. |
| Attributes | No `on*`; no `javascript:`; no `url(` anywhere; no `expression(` or `@import` in a `style`; `href`/`xlink:href`/`src`/`from`/`to` must start with `#`. |
| Geometry | `viewBox` required and must parse to four finite numbers with a positive extent. At most 2000 `<path>` elements and 1 MB of `d` data. |

`url(` is refused outright where the generator allows `url(#fragment)`. A
gradient or clip reference never survives into a toolpath, and the parenthesised
form is exactly where a same-document check is easy to get subtly wrong.

Returns `{ ok: true, svg, viewBox }` or `{ ok: false, reason, message }`.

### Orphan sweep (not built)

An upload becomes an orphan the moment a buyer picks a file and then closes the
tab: the object is in the bucket and the row's `order_id` is null forever. That
is the intended failure — the write order (object, then row, then the order's
stamp at checkout) always fails towards an orphan rather than towards a licence
that cannot be built.

**Follow-up, not implemented here:** a scheduler job (`packages/scheduler`, see
`docs/backend/scheduler.md`) that deletes `cnc-art/` objects whose `cnc_art_assets` row
still has `order_id IS NULL` after 7 days, and then the row. Three things it has
to get right, all of which are why it is not a five-line cron:

- Drive it off the ROW, never off a bucket listing. `cnc-art/` is a prefix
  inside the same private bucket as user data exports, and a lister that walked
  the bucket would be one prefix bug away from deleting those.
- 7 days, not 7 hours. A buyer who uploads a logo, sleeps on the price and buys
  on Monday must still find their file there.
- An asset attached to ANY order is never swept, even if that order was
  cancelled or refunded — `order_id` answers "may this be deleted", and a
  regenerate months later still has to be able to fetch it.

Until it exists, orphan growth is bounded by the per-user rate limit (20 uploads
an hour) and the 5 MB cap.

### The asset model

`cnc_art_assets` is a receipt for bytes in the private bucket:

| Column | Why |
| --- | --- |
| `id` | A uuid, client-visible. Not a serial: enumerable ids would let one buyer walk another's uploads by counting. |
| `user_id` | **Cascade.** An upload is the buyer's own file — nothing about a licence, a fingerprint trail or a refund needs it to outlive the account. |
| `key` | `cnc-art/<user_id>/<uuid>.<ext>`, unique. Two rows on one object would let deleting one asset break the other's order. |
| `mime`, `size_bytes`, `sha256` | Of the **stored** bytes; an SVG is sanitised and re-serialised before it is written. |
| `width_px`, `height_px` | Raster only. Null for an SVG, which has no intrinsic pixel size. |
| `order_id` | **Set null.** Stamped at finalise; answers "may this file be deleted". Losing an order must not delete the file it named. |

### Ownership

Every path that can reach an asset checks it:

- `validateCncArtwork` refuses an id that is not the caller's **before** asking
  the generator. That call makes the generator *fetch* the asset, so an
  unchecked id would be a way to have Boardsesh read somebody else's upload on
  request — even if all that comes back is "it fits".
- `createCncPreview` runs the same check before writing the order row — the only
  place an order is ever written — and copies the asset's key and mime onto it
  there.
- `finaliseCncOrder` stamps the order onto the assets. Best-effort, and
  deliberately not a gate: ownership was already proven when the preview row was
  written, and one upload legitimately appears in several orders now (every
  preview iteration is a row of its own, and a buyer may build two walls with
  the same logo). An unstamped file looks like a draft to a cleanup sweep, which
  is a far better failure than refusing a sale over a marker.

An unknown id and a foreign one produce the same `CNC_INVALID_CONFIG`, for the
same reason `cncOrder` returns null for both.

Only the **first** order to use an asset stamps it. `order_id` answers whether
the file may be deleted, and the answer is no from the moment any licence
depends on it — so a reuse leaves the first order's stamp in place and sells
anyway.

A cancelled checkout hands the stamp back. `releaseArtAssetsForOrder` clears
`order_id` for the order in both cancel paths: the resolver's own
`finaliseFailed` (Stripe would not open a session) and the webhook's
`checkout.session.expired` / `async_payment_failed`. The release is best-effort:
a failure is logged and the cancellation goes through regardless.

### What the job carries

`createCncPreview` copies each asset's key and mime **onto the order's `artwork`
JSON**, alongside the placement:

```json
{
  "assetId": "0b3f5a1c-…",
  "assetKey": "cnc-art/<user_id>/0b3f5a1c-….svg",
  "mime": "image/svg+xml",
  "text": null,
  "font": null,
  "mode": "engrave",
  "placement": { "panelIndex": 0, "xMm": 600, "yMm": 900, "widthMm": 200, "rotationDeg": 0 }
}
```

That duplication is deliberate and it is what `user_id`'s cascade forces: a
buyer who closes their account takes the asset rows with them while the licence
survives (`cnc_orders.user_id` is set null). An order holding only an asset id
would lose its artwork the day its buyer left, and a regenerate months later
would fail. The order's copy is the durable record; the table is the ownership
edge.

`buildWorkerJob` therefore reads `assetKey`, `mime` and `font` off the order row
rather than looking anything up, and `kind` is derived at the boundary: an item
with an asset is `svg`, anything else is `text`. That derivation is safe only
because `png` is off `allowedKinds` and `resolveArtworkAssets` refuses a PNG
asset — enabling `png` means teaching `toArtworkItems` to read the asset's mime
first. `font` rides along only for a
label — an SVG carries its own outlines, so a face name on one is a value the
generator has nowhere to apply.

## Downloads

`GET /api/cnc/packs/:licenceId/download` — handler
`packages/backend/src/handlers/cnc-download.ts`.

There is no signed object-store URL anywhere in this system. Every download
re-checks ownership and refund status at the moment it is served, which is what
makes a refund take effect immediately and what stops a forwarded link working
for whoever receives it.

Two ways to authenticate, because there are two callers:

- **`Authorization: Bearer <session token>`** — the app, cross-origin, so this
  route does CORS and answers `OPTIONS` the same way `/api/user-data-export` does.
- **`?token=<grant>`** — a browser navigation, which cannot carry a header.

`?kind=preview|full`, defaulting to `full` — the parameter is new and every
existing caller omits it, so defaulting the other way would turn a download in
flight into a watermarked picture of a DXF.

| Case | Status |
| --- | --- |
| Streams the zip | 200, `Content-Type: application/zip`, `Content-Disposition: attachment; filename="boardsesh-build-plans-<licenceId>.zip"` (preview: `boardsesh-build-plans-preview-<licenceId>.zip`), `Cache-Control: no-store`, `X-Content-Type-Options: nosniff` |
| No or bad credentials, expired grant | 401 |
| Unknown licence, someone else's licence, grant for another order | 404 — **identical responses**, so the id space is not an oracle |
| Order refunded | 403 |
| That deliverable is not available yet, or is with no object | 409 / 404 |

The two kinds have different windows, and the route re-asks the same question
the grant already answered:

- **`full`** — `ready` only.
- **`preview`** — `preview_ready` onward, including after the pack is bought and
  built. Finalising does not take the preview away; it is the thing the buyer
  approved, and they may well want it beside the real pack. It stops at a
  refund, like everything else the order entitles them to.

A served FULL download increments `download_count`, stamps `last_downloaded_at`
and fires `Build Plans Pack Downloaded`. It is counted once the bytes are on
their way rather than once they arrive — a client that aborts halfway still
asked for the pack. **A preview fetch counts for neither**: the number exists to
spot a licensed file being pulled twenty times, and pooling free watermarked
fetches into it would make it mean nothing.

### `GET /api/cnc/packs/:licenceId/preview/:name?token=`

One watermarked sheet, as an image. Its own route rather than a `kind` on the
download because it is the only thing in this system a browser fetches as an
`<img src>`: it answers `image/png` with `Cache-Control: private, max-age=3600`,
where every other route here is a `no-store` attachment. `private` because the
grant in the URL makes it one buyer's image and a shared cache must never hold
it; an hour because that is how long the grant lasts anyway.

`:name` is a BASENAME, never a key. It is matched against the basenames of
`preview_keys` — keys the worker's completion already proved sit under this
order's prefix — and the key that answers is the stored one, re-checked against
`cnc-packs/<user>/<licence>/preview/<name>.png` before it becomes a read. So no
part of what a client holds is a path into the private bucket. A name this order
does not have is a 404, not a 400: the client got the list from us.

### Download grants

`Mutation.createCncDownloadGrant(licenceId, kind)` returns `{url, expiresAt}`,
with `kind` already on the URL it hands back.

The grant exists only because a browser navigation cannot carry an
Authorization header, and a session token in a URL lands in history, in a
referrer and in every proxy log. So it is the weakest thing that works:
HMAC-SHA256 over `base64url("orderId:userId:exp")` with
`CNC_DOWNLOAD_TOKEN_SECRET`, **five minutes**, one order, one user, no
revocation — and the download route re-checks ownership and refund status when it
is redeemed anyway. The token says who asked; it never says what they may have.

Clients should ask for a fresh grant on every click rather than caching one.
Rotating `CNC_DOWNLOAD_TOKEN_SECRET` invalidates every outstanding grant, which
costs a buyer one extra click.

**Preview-image grants last an hour** (`CNC_PREVIEW_IMAGE_GRANT_TTL_MS`), and
`CncOrder.previewImages` mints one per sheet so the gallery renders from a
single order read rather than a round trip per thumbnail. Five minutes would
turn into broken images while a buyer sits looking at a wall, and what the
longer window unlocks is a PNG stamped NOT FOR MANUFACTURE. The expiry rides
inside the signed payload, so there is one token shape and one verifier.

## Regenerating a pack

`Mutation.regenerateCncPack(licenceId)`, admin only (`requireAdmin`).

Allowed from `ready` and `failed`. It puts the order back in `queued` with
`generation + 1`, the attempt budget reset to 0 and the lease cleared. The licence
id stays the same, while each attempt writes to a new generation path. A successful
completion publishes the new key without allowing old workers to overwrite it.
The download filename remains the licence filename.

Runbook, when a buyer's pack failed:

1. Read the pack-failed admin email: it carries the licence id, the buyer and
   the generator's real error.
2. Fix the cause (a generator deploy, a catalogue value, a stuck worker).
3. Call `regenerateCncPack` with the licence id. Confirm the order page moves
   `queued → generating → ready`.
4. The buyer gets the pack-ready email automatically. Nothing else is needed —
   the licence id on their invoice and in their inbox is unchanged.

The attempt reset is not cosmetic: a `failed` order has already spent its three
attempts, and requeueing without it would give the rebuild exactly one try.

**Known limitation.** A regenerate that itself fails leaves the *previous* zip
sitting at the output key. Nothing serves it — `isDownloadable` refuses an order
that is not `ready`, so the buyer's download stays shut — but the object is not
deleted either, and a later successful regenerate simply overwrites it. Nobody
gets a stale pack; an operator just has to regenerate again to make the licence
downloadable, rather than the old build quietly standing in for the new one.

## Environment

Backend, all fail-closed when unset:

| Var | Without it |
| --- | --- |
| `STRIPE_SECRET_KEY` | Checkout refuses to take an order. |
| `STRIPE_WEBHOOK_SECRET` | The webhook route 404s. |
| `STRIPE_PRICE_CNC_PERSONAL` | The personal tier cannot be sold. |
| `STRIPE_PRICE_CNC_COMMERCIAL` | The commercial tier cannot be sold. |
| `CNC_TRANSPORT` | Set `pgboss` for the outbound-only deployment; unset retains legacy HTTP compatibility. |
| `CNC_RELEASE_MODE` | Set `beta` for the restricted sandbox launch. Missing/unknown mode in pg-boss refuses new private computations, uploads, previews and checkout. `public` is selected only after actual GST confirmation and the live checkout cutover. |
| `CNC_BETA_USER_IDS` | Comma-separated exact account IDs authorized for beta. Empty or malformed lists deny access. Beta checkout requires a test/sandbox Stripe secret or restricted key. Existing owner downloads remain available. |
| `CNC_GENERATOR_SHA` | In pg-boss mode, requests refuse without the reviewed 40-character generator SHA. Must match the image. |
| `CNC_WORKER_URL` | Legacy HTTP transport only; leave unset in pg-boss production. |
| `CNC_WORKER_SECRET` | Legacy HTTP transport only; leave unset in pg-boss production. |
| `CNC_DOWNLOAD_TOKEN_SECRET` | No download grants can be minted, so browser downloads stop. Bearer-token downloads keep working. Rotating it invalidates every outstanding grant (a buyer clicks Download again). |
| `BACKEND_PUBLIC_URL` | Grant URLs are built against `https://ws.boardsesh.com`. Set it anywhere the backend is not on that host. |

Object storage: packs are written to and served from the **private** bucket
(`PRIVATE_S3_BUCKET_NAME` and its credentials — see `docs/operations/user-media-storage.md`).
Without it the claim route and the download route both answer 503; there is
nowhere to put a pack and nowhere to read one from.

Prices live in Stripe. The catalogue's `priceCents` is display copy of them, and
a price change is a dashboard action rather than a deploy.

Emails reuse the existing SMTP config (`SMTP_USER`, `SMTP_PASSWORD`,
`EMAIL_FROM`) and `ADMIN_EMAIL` for the pack-failed notification. Every send is
best-effort: the order is already paid and durable by the time one runs.

## The web surface

The shop routes under `/build-plans` are server-gated by `cnc-packs`; disabled
visitors receive `notFound()`. The licence alone has a public-contract exception:
exact web `CNC_RELEASE_MODE=public` serves it without identity lookup or PostHog,
including while the storefront flag is off. Missing, unknown and `beta` values
retain the licence's existing flag gate and DRAFT copy. Other shop and order
routes keep their existing access gates.

Explicitly setting web `CNC_RELEASE_MODE=public` removes only the licence's
editorial DRAFT, pending-review and placeholder wording. The terms, jurisdiction,
prices and informational/no-legal-advice footer remain unchanged. All build-plan
routes retain `noindex, follow`, and the sitemap remains empty through the initial
public rollout. This preparation can deploy while web mode is absent without
changing the test-user beta.

| Route | What it is |
| --- | --- |
| `/build-plans` | The hero and the configurator. Server-renders the catalogue, then hands it to a client component for the choosing. |
| `/build-plans/licence` | Manufacturing terms; independently available only in exact web public mode. |
| `/build-plans/orders` | The buyer's own orders, newest first. |
| `/build-plans/orders/[licenceId]` | One order: status timeline, the configuration it was bought under, and the download button once it is ready. |

`FEATURE_FLAG_OVERRIDES=cnc-packs` is how you reach any of them locally.

### The configurator

Seven steps, in the order they appear: **layout**, **size**, **kicker**,
**options**, **engrave**, **licensee**, **tier**. Each one fires a
`CNC Configurator Changed` funnel event debounced by 900 ms, so a buyer
dragging through the option list produces one event describing where they
stopped rather than twenty describing where they passed through.

The layout selector offers Kilter Homewall and Kilter Original. Sizes are
filtered by layout; switching layout resets manufacturing options and artwork
so a drawing cannot silently carry into different panel geometry. The existing
`board` funnel step records layout changes.

State lives in a reducer in `configurator-state.ts`, and the options a wall may
carry come from the backend catalogue rather than the client — the same registry
checkout validates against, so the configurator cannot offer a combination the
order would reject.

### The draft

Every change is written to IndexedDB under `cnc:configurator-draft`, debounced
by 600 ms, and read back once before the first save can run.

This exists for exactly one flow: an anonymous buyer configures a wall, presses
Buy, and is sent through OAuth. That leaves the page entirely, so without the
draft they come back to the defaults and have to configure it again — at the
exact moment they had decided to pay. The restore is also why the sign-in
callback URL is `/build-plans` rather than wherever the modal was opened from.

The draft is cleared twice: once when checkout succeeds (the wall has been
bought, so there is nothing left to restore) and once on sign-out, because it
carries the licensee name and email and the next person on a shared machine has
no business seeing them.

### Polling an unfinished pack

`/build-plans/orders/[licenceId]` re-queries every 5 s
(`ORDER_POLL_INTERVAL_MS`) while the order is `queued` or `generating`, and
stops once it reaches a terminal status. A pack takes a couple of minutes to
cut, so five seconds is fast enough that the page never feels stuck and slow
enough that a buyer leaving the tab open over lunch costs a few hundred
requests rather than a few hundred thousand.

Order timestamps are formatted with `createOrderDateFormatter`, which pins
`timeZone: 'UTC'`. The page is server-rendered and then hydrated, and those are
two runtimes in two zones; without the pin the same instant prints as two
different clock times and React reports a hydration mismatch.

## The admin queue

`/admin/build-plans` lists every order, newest first, behind the same
`checkAdmin` gate as the rest of `/admin`. It is the operator's view of the
three fields `CncOrder` withholds from the buyer — the licensee email, the
attempts spent, and the generator's real error — plus a Regenerate button on any
`ready` or `failed` order.

It is **not** behind the `cnc-packs` flag, on purpose. The flag decides whether
the shop is open to the public; orders that already exist still have to be
supportable if it is turned back off, and an operator locked out of the queue by
a rollout percentage is exactly the wrong failure.

Behind it, `Query.adminCncOrders(status, limit, cursor)` (`requireAdmin`,
60/min on its own bucket, 25 rows by default and 100 at most). Keyset
paginated on `(created_at, id)` rather than offset paginated: purchases land at
the front of this list while somebody is paging through it, and an offset would
show a row twice or skip one. A cursor that does not decode starts at the top
rather than erroring — it is an opaque token an operator can only have got from
us, and a first page is a more useful answer to a truncated paste than a
failure.

No index backs that ordering yet. `cnc_orders` holds one row per sale, so the
sort is over a small table; an index added before there is volume to justify it
is a write cost paid for a guess.

## Launch

Current scope remains the two-account **test-user beta**, pending actual GST
registration ([issue 7518](https://github.com/boardsesh/boardsesh/issues/7518)).
The owner authorized preparing the public release now and launching after GST
confirmation. Owner licence/printed-plan approval was recorded on 2026-11-14
(the deployment conversation's “I approve now” reply); it does not assert an
independent lawyer review or prove that tax registration is complete. Do not
repeat that approval request. The remaining external launch condition is actual
GST confirmation, followed by the prepared operational cutover below.

### Prepare while GST is pending

1. Stage and verify the live AUD tax-inclusive Personal (14900 cents) and
   Commercial single-build (75000 cents) prices, and the owned webhook at
   `https://ws.boardsesh.com/api/cnc/stripe/webhook`. Require all five events:
   `checkout.session.completed`, `checkout.session.async_payment_succeeded`,
   `checkout.session.async_payment_failed`, `checkout.session.expired` and
   `charge.refunded`. Store the new signing secret in the Homelab vault without
   printing it. The staging helper leaves the live webhook **disabled**; preparation
   neither enables it nor activates live credentials in production.
2. Keep backend `CNC_RELEASE_MODE=beta`, its sandbox key/prices/webhook secret,
   the exact two `CNC_BETA_USER_IDS`, and their PostHog targeting unchanged.
   Keep web mode missing or `beta`: the licence remains DRAFT, every build-plan
   route stays noindex, and anonymous/other accounts remain excluded.
3. Verify the existing pinned pg-boss workers, build receipts, restricted roles,
   private R2 uploads, owner-only complete downloads and monitoring. Preserve
   `FINGERPRINT_SECRET` and `CNC_DOWNLOAD_TOKEN_SECRET`. No VM recreation or legacy
   HTTP worker URL/secret is needed. The currently deployed generator source
   `6c6a11d7c6dc6ba42c4ab69d06a2344a29366586` still emits unconditional DRAFT text
   in full-pack `LICENCE.txt` (`packaging/licence.py`) and `README_CNC.txt`
   (`packaging/templates/README_CNC.txt.j2`). Prepare a separately reviewed,
   immutable publication-ready renderer image with those editorial notices
   removed and substantive clauses unchanged; verify a complete full pack.
   Prepare its future pin change without activating it before GST confirmation.
   Retain today's beta pin now. Preview `NOT FOR MANUFACTURE` remains required.
4. Record live Stripe Tax/registration status and the required Checkout
   Terms-of-Service URL, `https://www.boardsesh.com/build-plans/licence`.
   `automatic_tax.enabled` and `consent_collection` do not configure those
   account settings. Do not create a GST registration on an assumption or make
   real verification charges. A sandbox Tax success is not live readiness.

### Cut over only after actual GST confirmation

1. Confirm actual GST registration, the live Stripe preflight and the reviewed
   publication-ready full-pack release. Turn the storefront flag off and set
   backend `CNC_RELEASE_MODE=disabled`; redeploy its current image. Reconcile all
   pending sandbox Checkout sessions and asynchronous payments before replacing
   the single active Stripe key/signing secret: wait for settlement or explicitly
   expire unpaid sandbox sessions and verify their final state. Preserve orders,
   artifacts and the sandbox configuration for rollback; do not treat test orders
   as live purchases. With new creation disabled, pause both consumers, promote
   the reviewed publication-ready image/app/generator pins and matching backend
   `CNC_GENERATOR_SHA` together, then verify the paused release before resuming.
   Use the homelab's typed-boolean pause/promotion procedure.
2. While the backend stays disabled, stage matching live `STRIPE_SECRET_KEY`,
   `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_CNC_PERSONAL` and
   `STRIPE_PRICE_CNC_COMMERCIAL`. Redeploy the current backend image and verify
   it has loaded these bindings while release mode remains disabled. Verify
   identities, AUD 14900/75000-cent amounts, inclusive-tax behavior and GST
   readiness. Retain `CNC_TRANSPORT=pgboss`, the
   reviewed publication-ready generator pin and download secret. The stored beta
   allowlist can remain; public mode ignores it.
3. Set **web** `CNC_RELEASE_MODE=public` and deploy its current image. Verify the
   anonymous Terms URL returns 200 with approved wording while the storefront flag
   remains off and backend disabled. Confirm the live Checkout Terms-of-Service
   URL is `https://www.boardsesh.com/build-plans/licence`. Substantive clauses,
   amounts, jurisdiction and noindex must remain unchanged.
4. Enable the owned staged **live** webhook, then read back its enabled state,
   exact URL, API version, matching signing-secret receipt and all five events
   listed above. Verify delivery readiness before changing backend mode. The
   preparation helper intentionally does not perform this activation. Avoid real
   verification charges.
5. Only then set backend `CNC_RELEASE_MODE=public` and redeploy; verify health.
   Widen `cnc-packs` deliberately and remove only a conflicting CNC entry from
   production `FEATURE_FLAG_OVERRIDES`, preserving unrelated overrides. Wait for
   the web's 60-second cache; verify public configuration/preview, live catalogue,
   owned downloads and monitoring. Keep noindex/empty sitemap through the initial
   rollout. For an incident, close the storefront and disable backend release
   mode, then follow the homelab durable-pause/rollback runbook. Leave the public
   Terms URL available; preserve secrets, orders and schema.

Once the public flag has been stable at 100%, a separate PR can retire the gate
under `docs/operations/feature-flags.md`. That later work removes `requireCncPacksFlag()`
and its `notFound()` from the public build-plan routes, retires `CNC_PACKS_FLAG`,
adds indexable metadata and sitemap entries for `/build-plans` and
`/build-plans/licence`, and archives the PostHog flag. Orders remain noindex
utility pages. This preparation does none of that and adds no further lawyer or
printed-plan approval step.

### Follow-ups, not built

Five things that are deliberately out of the v1 scope, in the order they are
likely to be wanted:

- **Pruning old previews.** Every preview leaves a zip and a handful of PNGs in
  the private bucket, and a buyer who never finalises leaves them forever. The
  four-an-hour ceiling bounds the rate, not the total. The shape is a sweep over
  `preview_generated_at` older than 30 days on orders that never reached
  `pending_payment`: delete the objects, null the columns, leave the row (it is
  the record that the licence id was issued). Nothing about the read paths needs
  to change — `hasPreview` and `previewImages` already key off the columns.
- **Art asset orphan sweep.** An upload that never reached checkout stays in the
  bucket forever. Bounded today by the 20-an-hour rate limit and the 5 MB cap;
  the design and the three things it has to get right are under "Orphan sweep
  (not built)" above.
- **PNG artwork.** `POST /api/cnc/art` already accepts and sniffs a PNG, so the
  whole storage and cleanup path is exercised — but the generator's tracer is
  v2, so `png` is absent from `CncArtworkRules.allowedKinds` and an order naming
  a PNG asset is refused with `CNC_INVALID_CONFIG`. Adding it is a generator
  change plus one entry in that list.
- **10-build pack credits.** Today the 10-build tier is a `mailto:` on the
  pricing page. Doing it properly means a credit balance that is not an order
  row — one payment, ten licences drawn down over months — which is a second
  table and a second state machine, not a third tier in `catalog.ts`.
- **OEM licensing.** Also `mailto:` today, and probably always negotiated rather
  than self-serve.

## Local end-to-end

```
stripe listen --forward-to localhost:8080/api/cnc/stripe/webhook
```

Use the `whsec_` it prints as `STRIPE_WEBHOOK_SECRET`, set the test secret key
and the two test price ids, and pay with card `4242 4242 4242 4242`.

### Local testing without Stripe

`CNC_CHECKOUT_BYPASS=1` skips the payment leg entirely. **The bypass applies at
FINALISE, not at preview** — a preview never touches Stripe, so it needs nothing
skipped and runs identically with the flag on or off. `finaliseCncOrder` moves
the previewed order to `pending_payment` as usual, then queues it itself with
the catalogue tier price and a `bypass-<licenceId>` session id, and returns the
order page (`/build-plans/orders/<licenceId>?checkout=success`) instead of a
Stripe URL. Everything after that — the worker claim, generation, the pack in
the private bucket, the download grant — is the real path. The order-received
email and the `Build Plans Pack Purchased` analytics event are **not** sent: a
fake sale must not reach a real inbox or a real funnel.

It refuses to be on unless all four hold, and they are checked on every call
(`services/cnc/checkout-bypass.ts`):

- `CNC_CHECKOUT_BYPASS` is exactly `1`,
- `NODE_ENV` is not `production`,
- `RAILWAY_ENVIRONMENT` is unset — every deployed service has one, and Railway
  prod leaves `NODE_ENV` unset, so the previous condition alone would not catch
  it,
- `STRIPE_SECRET_KEY` is unset. A stack that can charge a card never fakes a
  payment, which is what keeps the bypass and real money mutually exclusive
  rather than merely unlikely.

The backend logs one loud warning at boot when it is on. Use it for the
generator, the worker loop and the download; use `stripe listen` above for
anything about the payment itself.

The whole local loop with the bypass on, no Stripe anywhere:

1. `createCncPreview` → the order comes back `preview_queued`.
2. The worker claims it as a `preview` job and completes it → `preview_ready`,
   `previewImages` populated.
3. `createCncDownloadGrant(licenceId, PREVIEW)` or the image URLs on the order
   → the watermarked sheets.
4. `finaliseCncOrder` → straight to `queued`, no payment.
5. The worker claims it as a `full` job → `ready`, and
   `createCncDownloadGrant(licenceId)` serves the real pack.

## Tension Board 2

The catalogue supports five TB2 sizes: 10 × 8, 12 × 8, 10 × 12, 12 × 12
and 12 × 16. Tension names sizes **height × width**. The configurator groups
Mirror (layout 10) and Spray (layout 11) into one board choice.

`tb2DimensionStandard` defaults to `metric`; `imperial` selects Tension's inch
specification. The worker owns the dimensions and bore diameters. Boardsesh
sends the standard, sheet stock and support-strip choice without Kilter pitch,
T-nut, kicker or stud-offset defaults. Changing the standard clears artwork
placements, which were measured against the previous geometry.

`tb2Engraving` accepts `none`, `mirror`, `spray`, or `both` (the default).
Spray alone uses layout 11; the other choices use layout 10. The reducer updates
the tuple with the option and checkout validates this pairing. Both layouts
share the complete drilling grid. The generated panels identify Mirror with
left-side labels and single direction ticks, Spray with right-side labels and
double ticks, and include a physical legend for the selected engravings.

The saved options drive preview hashes, order summaries and regenerated jobs.
The job envelope carries `output.engrave.layoutMode`; the nested layout request
carries `manufacturing.dimension_standard`. Deploy the TB2-capable generator
before exposing this catalogue revision. Existing Kilter worker requests retain
their previous shape. Build-plan routes keep their existing feature gate and
`noindex` metadata.
