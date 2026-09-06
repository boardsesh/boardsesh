# CNC build packs

Boardsesh sells generated CNC manufacturing packs for climbing-wall panels: DXFs
per panel, printable PDFs, a bill of materials and build notes, licensed per
wall. The app stays free and open source; the packs are the paid thing.

The generator itself lives in a private repo and runs as a separate worker
service. This document covers the Boardsesh half: orders, payment, the job API
the generator pulls work from, and the download route.

## The order row is the queue

One row in `cnc_orders` per purchased licence. It carries the licence identity
(`licence_id`, printed on every file in the pack), the configuration that was
bought, the payment, and the generation lease — all in one place, so "who paid
for this" and "who is generating it right now" can never disagree.

| From | Event | To |
| --- | --- | --- |
| — | `createCncCheckoutSession` | `pending_payment` |
| `pending_payment` | `checkout.session.completed` (paid), or `checkout.session.async_payment_succeeded` | `queued` |
| `pending_payment` | `checkout.session.expired`, or `checkout.session.async_payment_failed` | `cancelled` |
| `pending_payment` | Stripe would not open a session | `cancelled` |
| `queued` | worker claim | `generating` |
| `generating` | complete | `ready` |
| `generating` | fail | `queued`, or `failed` once the attempt budget is spent |
| any paid state | `charge.refunded` | `refunded` (downloads stop) |
| `ready` / `failed` | admin regenerate | `queued` |

The table lives in `packages/backend/src/services/cnc/order-state.ts` as data.
Every real transition is a conditional `UPDATE ... WHERE id = $id AND status IN
(...)`, so a zero-row result means somebody else already moved the order and the
caller no-ops. That is what makes a Stripe redelivery and a late worker report
harmless.

**`pending_payment -> queued` happens in exactly one place: the paid webhook.**
Nothing else queues an order, which is what stops an unpaid one reaching the
generator.

## Stripe

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

`Mutation.createCncCheckoutSession` writes the order in `pending_payment` and
then opens the session. That order matters — the webhook finds the row by
`metadata.orderId`, so the row has to exist before a payment can complete.

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
- **500** only when the database would not answer — the one failure worth a
  redelivery.
- **200** for everything else, including ignored event types, unpaid sessions,
  unresolvable orders and redeliveries. An event we decided not to act on is
  handled, not failed.

Idempotency is a uniqueness constraint, not application logic: the event id goes
into `cnc_stripe_events` with `ON CONFLICT DO NOTHING` before any side effect,
and a second delivery of the same id loses that race and answers
`{received: true, duplicate: true}`. A handler that throws releases its claim so
the retry can work; a process *killed* mid-handler leaves a row with a null
`processed_at`, which is the intended "started and died" trace.

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

## The worker job API

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
      "artwork": [{ "assetId": null, "mime": null, "text": "Send it", "mode": "engrave", "placement": { "…": "…" } }]
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
    "outputKey": "cnc-packs/<user_id or \"anon\">/<licence_id>.zip",
    "bucket": "<private bucket name>",
    "issuedAt": "2026-09-06T02:14:11.402Z"
  }
}
```

Notes the worker implementer needs:

- **The envelope is camelCase; `layoutRequest` is snake_case.** The envelope is
  Boardsesh's; `layoutRequest` is the generator's own pydantic model, byte for
  byte what `POST /layout` takes, so it can go straight into `compute_layout`
  with no second translation.
- **`outputKey` is dictated, never invented.** `anon` appears when the buyer
  deleted their account: the licence outlives it, so the key has to stay stable.
  A regenerate writes to the same key on purpose — the new zip replaces the old
  one rather than leaving a second licensed copy around.
- **`attempt` is 1-based and counts reclaims.** `generation` only moves on an
  admin regenerate.
- **`artwork[].mime` is always null until the `cnc_art_assets` table exists.**
  The field is in v1 of the contract so the shape does not change when it starts
  arriving.
- **503** means the private bucket is not configured on our side. Retry later;
  it is an operator problem.

The claim is one transaction: `SELECT … FOR UPDATE SKIP LOCKED` over queued rows
plus stale leases, then the claim write in the same transaction. Two workers
polling at once get different rows or nothing. The claim also runs the reaper
first (see below), so **there is no scheduler job** — the worker's own poll is
what fails abandoned work.

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

On success the order moves to `ready`, the claim token is cleared, and the buyer
gets the pack-ready email. `bomSummary`, `previewKeys` and `generatorVersion` are
folded into the stored manifest. **The manifest is never logged and never
leaves the backend** — it is the map of which covert channels carry which
values, and publishing it would tell a leaker exactly what to strip.

### `POST /api/cnc/worker/jobs/:orderId/fail`

```json
{ "claimToken": "0f0a…", "errorCode": "SEAM_TOO_CLOSE_TO_HOLE", "message": "row 12", "retryable": true }
```

The worker reports what happened; the state machine decides what it means:

- `retryable: false` → `failed` immediately.
- `retryable: true` → back to `queued` until the attempt budget (3) is spent,
  then `failed`.

`failed` mails an operator with the real error. The buyer only ever sees a fixed
public message. `last_error` is stored truncated to 2000 characters.

### Leases and the reaper

| Constant | Value | Where |
| --- | --- | --- |
| Lease window | 10 min without a heartbeat | `CNC_LEASE_MS` |
| Attempt budget | 3 | `CNC_MAX_ATTEMPTS` |

A `generating` row whose heartbeat is older than the lease window is reclaimable
while `attempts < 3`; the next claim takes it, increments `attempts` and issues a
**fresh claim token**, which is what makes the dead worker's eventual report a
409. Once the budget is spent, the first statement of the next claim
(`failStaleExhaustedJobs`) moves the row to `failed` and mails an operator —
without it, a worker that dies on its third attempt would sit in `generating`
forever, because the claim's candidate filter excludes it.

A null heartbeat counts as stale: that is a worker that died between claiming and
its first report.

### `GET /api/cnc/worker/assets/:assetId?orderId=&claimToken=`

Streams one uploaded art asset from the private bucket.

The asset id alone is deliberately not enough. `cnc_art_assets` does not exist
yet, so there is no table to resolve an id against and no ownership edge to
check — the order's own artwork list is the only place that says which assets
belong to which job, so the lease is required too. Today this **404s with a
clear message** for every asset, because nothing writes an asset key yet. The
lease check stays as the second gate once the table lands.

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

| Case | Status |
| --- | --- |
| Streams the zip | 200, `Content-Type: application/zip`, `Content-Disposition: attachment; filename="boardsesh-build-plans-<licenceId>.zip"`, `Cache-Control: no-store`, `X-Content-Type-Options: nosniff` |
| No or bad credentials, expired grant | 401 |
| Unknown licence, someone else's licence, grant for another order | 404 — **identical responses**, so the id space is not an oracle |
| Order refunded | 403 |
| Not `ready` yet, or ready with no object | 409 / 404 |

A served download increments `download_count`, stamps `last_downloaded_at` and
fires `Build Plans Pack Downloaded`. It is counted once the bytes are on their
way rather than once they arrive — a client that aborts halfway still asked for
the pack, and that is the behaviour worth noticing.

### Download grants

`Mutation.createCncDownloadGrant(licenceId)` returns `{url, expiresAt}`.

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

## Regenerating a pack

`Mutation.regenerateCncPack(licenceId)`, admin only (`requireAdmin`).

Allowed from `ready` and `failed`. It puts the order back in `queued` with
`generation + 1`, the attempt budget reset to 0 and the lease cleared — **same
licence id, same output key**, so the rebuilt zip replaces the old one instead of
issuing a second licensed copy of the same wall. The generation counter is what
tells two builds of one licence apart in the fingerprint trail.

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

## Environment

Backend, all fail-closed when unset:

| Var | Without it |
| --- | --- |
| `STRIPE_SECRET_KEY` | Checkout refuses to take an order. |
| `STRIPE_WEBHOOK_SECRET` | The webhook route 404s. |
| `STRIPE_PRICE_CNC_PERSONAL` | The personal tier cannot be sold. |
| `STRIPE_PRICE_CNC_COMMERCIAL` | The commercial tier cannot be sold. |
| `CNC_WORKER_URL` | Layout previews and artwork validation refuse rather than guess. |
| `CNC_WORKER_SECRET` | The same, plus the whole `/api/cnc/worker/*` job API 404s — the generator can claim nothing. Shared with the worker, which sends it as a bearer token. |
| `CNC_DOWNLOAD_TOKEN_SECRET` | No download grants can be minted, so browser downloads stop. Bearer-token downloads keep working. Rotating it invalidates every outstanding grant (a buyer clicks Download again). |
| `BACKEND_PUBLIC_URL` | Grant URLs are built against `https://ws.boardsesh.com`. Set it anywhere the backend is not on that host. |

Object storage: packs are written to and served from the **private** bucket
(`PRIVATE_S3_BUCKET_NAME` and its credentials — see `docs/user-media-storage.md`).
Without it the claim route and the download route both answer 503; there is
nowhere to put a pack and nowhere to read one from.

Prices live in Stripe. The catalogue's `priceCents` is display copy of them, and
a price change is a dashboard action rather than a deploy.

Emails reuse the existing SMTP config (`SMTP_USER`, `SMTP_PASSWORD`,
`EMAIL_FROM`) and `ADMIN_EMAIL` for the pack-failed notification. Every send is
best-effort: the order is already paid and durable by the time one runs.

## Local end-to-end

```
stripe listen --forward-to localhost:8080/api/cnc/stripe/webhook
```

Use the `whsec_` it prints as `STRIPE_WEBHOOK_SECRET`, set the test secret key
and the two test price ids, and pay with card `4242 4242 4242 4242`.
