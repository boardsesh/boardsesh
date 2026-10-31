# Project news email

Climbers can ask for "Email me project news": a few emails a year about what's
new in Boardsesh and how to support it. It is off until the climber turns it
on, in every country. This page is the contract for the opt-in, the
unsubscribe link, and the send script that does not exist yet.

There is no bulk sender in this repo. Build one only against the rules below.

## What climbers see

- **App:** Settings → Account → Email → "Email me project news". Off by
  default. Hidden while signed out and in screenshot mode
  (`EXPO_PUBLIC_SCREENSHOT_MODE=1`), because store captures never show
  anything about supporting Boardsesh. Disabled offline: an answer is recorded
  by the server when it lands, never queued.
- **Website:** the same switch on `/settings`, below Analytics.
- **Privacy policy:** `/privacy`, "What we collect", "Project news email", in
  all four locales.
- **Release notes and store listings:** never mention this switch together
  with support or donations. What's New renders inside the app on every
  storefront.

## Storage

`user_project_news_email_events` (`packages/db/src/schema/app/project-news-email.ts`,
migration `0288_project_news_email_consent`), append-only:

| Column       | Meaning                                                         |
| ------------ | --------------------------------------------------------------- |
| `user_id`    | `users.id`, `ON DELETE CASCADE`                                 |
| `subscribed` | `true` = opted in, `false` = opted out                          |
| `source`     | `web`, `ios`, `android` (Settings switch) or `email_link`       |
| `decided_at` | server clock (`clock_timestamp()`), never the client's          |

- The newest row by `id` is the current answer. No row means never asked,
  which reads as off.
- A row is written only when the answer changes, under a per-user advisory
  lock. A repeated tap or a second unsubscribe click writes nothing.
- The rows are the evidence of consent the Spam Act 2003 (s 16) and GDPR
  Art. 7(1) ask for. They are kept until the account is deleted.
- Not a column on `users` or `user_profiles`: an append-only log keeps when
  consent was given and withdrawn, the same reasoning as
  [analytics consent](./analytics-consent.md).

**Account deletion:** `deleteAccount` deletes the `users` row; the foreign key
cascades every opt-in row away. **Data export:** every board's Boardsesh JSON
carries `projectNewsEmail`, the full history oldest first
([user-data-exports.md](./user-data-exports.md)).

## GraphQL

Both need a signed-in climber and only touch that climber's rows.

```graphql
query { myProjectNewsEmailConsent { subscribed decidedAt } }
mutation { setProjectNewsEmailConsent(input: { subscribed: true, source: "ios" }) { subscribed decidedAt } }
```

`source` accepts `web`, `ios` or `android`. `email_link` is refused: only the
unsubscribe endpoint writes it. Rate limit: 20 writes a minute per climber.

## Unsubscribe link

```
GET  {BACKEND_PUBLIC_URL}/api/project-news/unsubscribe?token=<token>
POST {BACKEND_PUBLIC_URL}/api/project-news/unsubscribe?token=<token>
```

- **GET** (and HEAD) shows a one-button page and changes nothing. Mail
  scanners and link previews fetch every link in an email, so a GET must never
  unsubscribe anyone.
- **POST** switches the email off, recorded with `source = email_link`. The
  page's button posts back to the same URL. Mail apps that support RFC 8058
  POST `List-Unsubscribe=One-Click` to it directly.
- No sign-in. The token is the credential, and all it can do is switch this
  one account's project news email off.
- Answers: 200 page on success (also when already off, or when the account
  was deleted), 400 for a broken or expired link (the page points to Settings),
  503 when the secret is not configured.

**Token:** `base64url(JSON { p, u, iat, exp }) . base64url(HMAC-SHA256)`, made
by `services/project-news-unsubscribe-token.ts`.

- `u` is the user id, `p` is the purpose string, `iat`/`exp` are epoch seconds.
- The key is HKDF-SHA256 from `PROJECT_NEWS_UNSUBSCRIBE_SECRET` with the info
  string `boardsesh-project-news-unsubscribe-v1`. The signature is checked in
  constant time before the payload is read.
- A token lasts 365 days. The Spam Act needs a link that works for at least
  30 days after the send; a year covers old emails. A token claiming a longer
  life is refused.
- Mint links with `buildProjectNewsUnsubscribeUrl(userId)`. It throws when the
  secret is missing, so a send cannot go out without a working link.

**`PROJECT_NEWS_UNSUBSCRIBE_SECRET`** (backend env, at least 32 characters):
its own secret, not `NEXTAUTH_SECRET`, so rotating the auth secret does not
break links already sent, and rotating this one signs nobody out. Rotating it
breaks every link already sent, so only rotate after a leak; the Settings
switch still works. Generate with `openssl rand -base64 48`. Set it on the
backend service before the first send.

## The send script (not built)

Read recipients at send time, never from a cached list:

```ts
import { selectProjectNewsRecipients } from '../services/project-news-email';
const recipients = await selectProjectNewsRecipients(); // [{ userId, email, name }]
```

It returns accounts whose newest answer is "on" AND whose
`users."emailVerified"` is set. The same query in SQL:

```sql
SELECT u.id, u.email, u.name
FROM (
  SELECT DISTINCT ON (user_id) user_id, subscribed
  FROM user_project_news_email_events
  ORDER BY user_id, id DESC
) latest
JOIN users u ON u.id = latest.user_id
WHERE latest.subscribed AND u."emailVerified" IS NOT NULL
ORDER BY u.id;
```

Per message:

- `From:` a real Boardsesh address that accepts replies.
- Body: who is sending (Boardsesh, the sole trader behind it, a contact
  address) and a visible unsubscribe link.
- Headers: `List-Unsubscribe: <{unsubscribe url}>` and
  `List-Unsubscribe-Post: List-Unsubscribe=One-Click`.
- One token per recipient per send.

Caveat: when `EMAIL_VERIFICATION_ENABLED` is off, native sign-up stamps
`emailVerified` at creation (`handlers/native-auth.ts`), so "verified" there
means "signed up", not "clicked a link". Apple "Hide My Email" addresses
(`privaterelay.appleid.com`) only deliver from a sender domain registered with
Apple.

## Legal checklist before any send

1. **Opted in only, everywhere.** No email to an account without an "on"
   answer, in any country, EU and UK included. No "existing customer"
   exception, no one-off blast to every account.
2. **Sender identity.** Every email names Boardsesh and how to reach us
   (Spam Act s 17).
3. **Unsubscribe.** A working link in every email and the one-click headers;
   honour it within 5 business days (Spam Act s 18). The endpoint does it
   at once.
4. **Fresh list.** Recipients come from `selectProjectNewsRecipients()` at
   send time.
5. **Privacy policy.** If the send uses an email provider not already named
   in `/privacy` under "Third-party services", add it there first.
6. **Content.** Donation asks never claim tax-deductibility and never promise
   perks. The email is outside the app, so it may link to `/support`.
