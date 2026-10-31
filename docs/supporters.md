# Supporters

How a payment through the `/support` Payment Links becomes a supporter tag on
a Boardsesh account, and how that tag is shown.

A donation buys nothing in the app and is not tax-deductible. The Supporter tag is a
thank-you label and nothing else: it changes no limit, no feature and no
place in any queue. Copy anywhere in the product must not suggest otherwise.

## What exists

- **Payment** stays on the live Stripe Payment Links that `/support` already
  uses (`packages/web/app/support/support-links.ts`, contract in
  [production-deploy.md](./production-deploy.md#the-support-link-contract)).
  There is no custom Checkout and no custom amount.
- **Linking.** A signed-in climber gets an opaque claim id from
  `createSupportClaim` and the client puts it in the Payment Link's
  `client_reference_id`. The Stripe webhook reads it back and links the
  payment to the account.
- **Claim by email.** Someone who paid without signing in, or before linking
  existed, runs `claimSupporterByEmail`: the backend looks up the account's
  verified email in Stripe and applies what it finds.
- **Hand grants.** GitHub Sponsors has no automatic link (accounts sign in
  with Google or Apple only), so an admin records it with `grantSupporter`.
- **The tag** shows on public profiles on web and mobile only when the climber
  opted in and is currently a supporter.

## Tables

All three live in `packages/db/src/schema/app/supporters.ts` (migration
`0288_stripe_supporters`) and cascade on account deletion. Stripe stays the
source of truth for money and billing details; these hold only what the tag
rule needs.

| Table                       | What it holds                                                                                                                                     |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `stripe_supporters`         | One row per account: linked subscription id and status, `credit_until`, `show_publicly` (default false), `source`, first `supported_at`.         |
| `stripe_support_claims`     | Claim ids handed to Payment Links, and the ledger of Checkout Sessions already counted (`checkout_session_id`, unique). Also `currency`, `src`.   |
| `stripe_support_operations` | A per-account billing lease, so Stripe calls run outside database transactions and a crash in the middle of one can be resumed (account deletion). |

`stripe_supporters.source` is `stripe`, `github_sponsors` or `admin` (CHECK).
A row created only by `updateSupporterVisibility` before any payment has no
`supported_at`, and `mySupporterStatus.source` reads null for it.

`stripe_support_claims.show_publicly` is unused: visibility lives on
`stripe_supporters` only. `checkout_expires_at` is copied from the session
for reference.

## Claim flow

1. The signed-in client calls `createSupportClaim(cadence, currency, src)`.
   `cadence` is `monthly` or `one_time`, `currency` is `aud` or `usd`, and
   `src` is cleaned the same way the web does it (lowercase `[a-z0-9-]`, at
   most 40 characters). It returns `sc_` plus 32 hex characters. The call is
   rate-limited (20 per window) and prunes the account's unused claims older
   than 30 days.
2. The client opens the Payment Link with `client_reference_id=<claim id>`
   instead of the `src` tag. The `src` is kept on the claim row.
3. Stripe sends `checkout.session.completed`. The webhook treats
   `client_reference_id` as a claim **only when it starts with `sc_`**;
   anything else (`web-support`, `app-settings`, …) is a `src` tag and the
   payment stays anonymous, exactly as before this system existed.
4. The session id is written into the claim row. If that claim already holds
   another session (the same link paid twice), a new ledger row is added for
   the same account. The unique index on `checkout_session_id` means a
   session is counted once, whether the webhook or claim-by-email gets there
   first.

A deleted account takes its claims with it; a payment that arrives later for
one of them stays anonymous.

## Credit rule

Pure functions in `packages/backend/src/services/supporter-status.ts`.

- **Currently a supporter** (`isCurrentSupporter`): a linked subscription
  whose status is `active`, `trialing` or `past_due`, or `credit_until` later
  than now.
- **One-off gifts** add tag time (`creditMonthsFor`): one calendar month per
  US$10 (1000 `usd` minor units) or per A$15 (1500 `aud` minor units),
  rounded down. A gift under one month still sets `supported_at` but adds no
  time.
- **Stacking** (`extendCredit`): new months are added to whichever is later,
  now or the current `credit_until`. Months are calendar months in UTC; a day
  past the end of the target month lands on its last day (31 Jan + 1 month =
  28 or 29 Feb).
- **Currencies**: only `aud` and `usd`. A session in any other currency is
  logged and ignored, and the webhook still answers 200.
- **Monthly** payments add no `credit_until`; the subscription status is the
  whole rule.
- **Claim by email** credits found gifts as of their own payment times: their
  months stack in payment order from each payment date, and only the time
  still left today is added (on top of any credit still running). A gift
  whose months already ran out adds nothing; a half-used one adds its unused
  half.
- **Hand grants** store the admin's `credit_until` as given; a past date ends
  a grant.

## Tag rule

`PublicUserProfile.isSupporter` is resolved only by the `publicProfile`
resolver (`resolveProfileSupporterTag` in
`packages/backend/src/graphql/resolvers/support.ts`):

- true only when `show_publicly` is true **and** the climber is currently a
  supporter;
- false when the viewer cannot see the profile's activity (a private profile
  the viewer does not follow);
- false, with an error log, when the lookup fails;
- null on every other `PublicUserProfile` (follower lists, search results).

`publicSupporters(limit, offset)` lists the same set (opted in and current),
newest `supported_at` first, at most 500 per page.

## GraphQL

Schema in `packages/shared-schema/src/schema/support.ts`.

| Operation                                       | Who        | Notes                                                                                     |
| ----------------------------------------------- | ---------- | ----------------------------------------------------------------------------------------- |
| `mySupporterStatus: MySupporterStatus`          | anyone     | Null when signed out.                                                                     |
| `publicSupporters(limit, offset)`               | anyone     | Rate-limited.                                                                             |
| `createSupportClaim(cadence, currency, src)`    | signed in  | Returns the claim id.                                                                     |
| `updateSupporterVisibility(showPublicly)`       | signed in  | Works before the first payment lands.                                                     |
| `claimSupporterByEmail`                         | signed in  | Needs a verified email and `STRIPE_SECRET_KEY`. Rate-limited (5 per window). Idempotent. |
| `grantSupporter(userId, source, creditUntil)`   | admin only | `source` is `github_sponsors` or `admin`. Global admin role required. A future date only extends existing tag time and a Stripe supporter keeps source `stripe`; a past date ends the credit (revoke). |

`claimSupporterByEmail` reads completed Checkout Sessions with
`GET /v1/checkout/sessions?customer_details[email]=…&status=complete` (up to
5 pages of 100) and the subscriptions of up to 10 customers found with
`GET /v1/customers?email=…`. Stripe matches email case-sensitively, so it
tries the stored spelling and its lowercase. A session another account
claimed with its own `sc_` id is left alone, so is the subscription such a
session started, and a subscription already linked to another account is
never moved.

## Webhook

`POST /webhooks/stripe` on the backend
(`packages/backend/src/handlers/stripe-webhook.ts`), routed before GraphQL so
the body reaches the signature check untouched (`readRawBody` in
`handlers/http-utils.ts`, capped at 256 KiB).

- **Fails closed.** Without `STRIPE_SECRET_KEY` or `STRIPE_WEBHOOK_SECRET` it
  answers 503 and does nothing; Stripe keeps retrying until it is configured.
- **Signature.** Verified with `STRIPE_WEBHOOK_SECRET` over the exact bytes.
  A missing or wrong signature is a 400 and writes nothing.
- **Errors.** A processing error is a 500, so Stripe retries. Every path is
  idempotent per event and per session id.

| Event                                      | What happens                                                                                                  |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------- |
| `checkout.session.completed`               | `mode=payment` and paid: ledger the session, add credit. `mode=subscription`: read the subscription and link it. |
| `checkout.session.async_payment_succeeded` | Same as completed, for delayed payment methods.                                                               |
| `checkout.session.async_payment_failed`    | Logged. Nothing was recorded for an unpaid session.                                                           |
| `checkout.session.expired`                 | Logged. The unused claim is pruned later.                                                                     |
| `customer.subscription.created`            | Status sync for a subscription already linked; ignored otherwise.                                             |
| `customer.subscription.updated`            | Status sync: the subscription is read back from Stripe, so an out-of-order event cannot store a stale status. |
| `customer.subscription.deleted`            | Same; the status becomes `canceled` and the tag ends unless credit remains.                                   |

### Stripe dashboard setup

Add a webhook endpoint at `https://ws.boardsesh.com/webhooks/stripe` (the
backend host: `WS_HOSTNAME` in `infra/cloudflare/config.ts`; the Cloudflare
rules there only filter GET requests, so Stripe's POST passes) subscribed to
the seven events above. Copy its signing secret into `STRIPE_WEBHOOK_SECRET`.

## Admin grants

Global admins grant supporter status from the **Supporters** tab of the web
admin page (`/admin`, `packages/web/app/components/admin/supporter-grant-panel.tsx`).
Find the account by name or paste its id, pick the source (`github_sponsors`
or `admin`) and a whole number of months from 1 to 120. The form sends
`grantSupporter` with `creditUntil` = today plus those calendar months in UTC
(the same month arithmetic as the credit rule). The backend stores that date
as given: a second grant replaces the first end date instead of adding to it,
and it does not touch a linked Stripe subscription. It also replaces time a
Stripe one-off gift bought and sets `source` to the granted one, so a grant
shorter than the account's current `credit_until` cuts that gift's time short.

## Triage label (internal)

Internal ops only. Never mention this label in product copy, tooltips, locale
strings or public docs.

Issues from current supporters get the GitHub label `supporter`, so the
maintainers can see them in the tracker. Every current supporter counts, not
only those who chose public credit. Two paths add it, and neither ever
removes a label:

- **In-app bug reports.** `submitAppFeedback` checks the signed-in reporter
  with `isAccountCurrentSupporter` (`packages/backend/src/services/supporter-lookup.ts`,
  the `isCurrentSupporter` rule) and adds the label to the issue it opens.
  The title and body do not change, so the label is the only sign on the
  public issue. A failed lookup means no label and is logged; the report is
  still filed. The `app_feedback` row stores nothing extra: the reporter's
  `user_id` is on the row, and their status can be looked up there.
- **GitHub Sponsors.** The `label-supporter-issues` job in
  `refresh-acknowledgements.yml` runs weekly (Monday 07:00 UTC) and on dispatch.
  It lists the org's current sponsorships (`activeOnly: true`,
  `includePrivate: true`) with a Repo Bot App token that has only
  Organization Members: read, then adds the label to each OPEN issue those
  sponsors wrote and that does not carry it yet. Writes use the job's
  `GITHUB_TOKEN` with `issues: write`, the only job in that workflow that has
  it. The log prints counts only, never a login or an issue number: `gh`
  failures are rethrown without their command line, and GitHub's error text
  for a per-sponsor issue lookup is dropped. One sponsor's failed lookup or
  one failed label write is counted, the rest still run, and the job then
  fails. Script:
  `scripts/label-supporter-issues.ts` (`--dry-run` to plan without writing).
  An issue a sponsor opens mid-week is labelled on the next run.

## Account deletion

`deleteAccount` runs as a billing operation (`withSupportOperation`, kind
`deleting`). It stores the intent first (the linked subscription id and the
setter-name choice), then sets a live subscription to end at the close of its
paid period (`cancel_at_period_end`), outside any transaction, and only then
deletes the account. If Stripe cannot confirm the cancellation the account is
kept and the climber is told so; a retry resumes the stored intent. An account
with no subscription never calls Stripe. Everything else `deleteAccount` did
before (spray walls, privacy withdrawal, boards, the PostHog erasure job,
kiosk tombstones, photo purge) is unchanged.

## Environment

Backend only (Railway backend service):

| Name                    | Purpose                                                                                     |
| ----------------------- | ------------------------------------------------------------------------------------------- |
| `STRIPE_SECRET_KEY`     | Reads sessions and subscriptions back; cancels at period end on deletion. Restricted key OK: read Checkout Sessions, Customers, Subscriptions; write Subscriptions. |
| `STRIPE_WEBHOOK_SECRET` | Verifies webhook signatures.                                                                |

The web service keeps its own Payment Link variables
([production-deploy.md](./production-deploy.md#runtime-variables-on-the-railway-web-service)).
