# CNC build packs

Boardsesh sells generated CNC manufacturing packs for climbing-wall panels: DXFs
per panel, printable PDFs, a bill of materials and build notes, licensed per
wall. The app stays free and open source; the packs are the paid thing.

The generator itself lives in a private repo and runs as a separate worker
service. This document covers the Boardsesh half: orders, payment and the
webhook. The worker job API, the download route and the regenerate runbook land
with the next PR and are documented here then.

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

## Environment

Backend, all fail-closed when unset:

| Var | Without it |
| --- | --- |
| `STRIPE_SECRET_KEY` | Checkout refuses to take an order. |
| `STRIPE_WEBHOOK_SECRET` | The webhook route 404s. |
| `STRIPE_PRICE_CNC_PERSONAL` | The personal tier cannot be sold. |
| `STRIPE_PRICE_CNC_COMMERCIAL` | The commercial tier cannot be sold. |
| `CNC_WORKER_URL` / `CNC_WORKER_SECRET` | Layout previews and artwork validation refuse rather than guess. |

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
