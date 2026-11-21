# Backend email (SMTP)

The `packages/backend` service sends transactional email through a small
Nodemailer module (`src/email/email-service.ts`). Today it powers the gym
ownership-claim flow:

- **Claim verification** — the link a claimant clicks to prove control of an
  email at the gym's website domain (transfers ownership on click).
- **Admin notification** — a heads-up to the review inbox when a claim needs a
  human (no verifiable domain on file).
- **Approval / ownership-lost** notices to the claimant and the displaced owner.

It also sends the partner developer console's change email
(`src/email/partner-app-emails.ts`, #7598): the developer hears when an app is
registered on their account, or one of their apps' redirect URIs change, its
client secret is replaced or it is deleted. Same transport, same best-effort rule,
sent after the change commits and only to a verified address; see
[integration-platform.md](../integrations/integration-platform.md), "The change email".

An admin can approve a queued claim after a handover has already given the gym
to that claimant. That approval closes the old queue entry but does not transfer
the gym again. New approvals record whether they actually changed the owner, so
a later no-op approval does not make a newer claim look stale. Older approvals
without that record remain unknown and are treated conservatively as possible
ownership changes; no history is inferred or backfilled. Claim-transfer records
keep the original gym UUID when duplicate gyms are merged, so source-gym history
does not become a transfer on the canonical gym.

The transporter is lazy: importing the module never opens an SMTP connection, and
nothing is sent until a claim actually fires. Notification emails are best-effort
(a send failure is logged, never thrown) so a flaky mailer can't roll back an
ownership transfer or strand a queued claim.

## Environment variables

Set these on the **backend** service (Railway or any `docker run`):

| Variable             | Required | Default                                       | Notes                                                                                               |
| -------------------- | -------- | --------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `SMTP_USER`          | **yes**  | —                                             | SMTP username. Sending throws if unset.                                                             |
| `SMTP_PASSWORD`      | **yes**  | —                                             | SMTP password / app token.                                                                          |
| `SMTP_HOST`          | no       | `smtp.fastmail.com`                           | SMTP server host.                                                                                   |
| `SMTP_PORT`          | no       | `465`                                         | `465` = TLS-on-connect; `587` = STARTTLS.                                                           |
| `SMTP_SECURE`        | no       | derived from port                             | `true`/`false` override. When unset, `secure` is `true` only for port `465`. Set `false` for `587`. |
| `EMAIL_FROM`         | no       | falls back to `SMTP_USER`                     | From address on outbound mail.                                                                      |
| `ADMIN_EMAIL`        | no       | `admin@boardsesh.com`                         | Where claim-review notifications go. **Must route to a real inbox.**                                |
| `BACKEND_PUBLIC_URL` | no       | `https://ws.boardsesh.com`                    | Public backend origin; builds the claim verify link (`/api/gym-claims/verify`).                     |
| `WEB_PUBLIC_URL`     | no       | `BOARDSESH_URL` → `https://www.boardsesh.com` | Public web origin; builds the `/admin/gym-claims` review link.                                      |

### Port / `secure` pairing

`secure: true` means the connection is TLS from the first byte — correct for port
`465`. Port `587` negotiates TLS via STARTTLS and needs `secure: false`, or the
connection hangs. The service derives `secure` from `SMTP_PORT` (only `465` →
`true`); override with `SMTP_SECURE` for a non-standard provider.

## Prerequisite before the claim flow helps in prod

- SMTP creds present (`SMTP_USER` + `SMTP_PASSWORD`) — without them the domain
  verification email can't be sent and the mutation surfaces an error.
- `ADMIN_EMAIL` pointed at an inbox a human watches — the admin-review path is
  the fallback for gyms with no verifiable domain.

## Bug reports and Apple private relay

Bug-report acknowledgements use `@boardsesh/email` and skip recipients at the
exact `privaterelay.appleid.com` domain before contacting SMTP. Fastmail can
accept a submission before Apple rejects delivery asynchronously, so catching a
transport exception cannot prevent the resulting bounce. Other recipient
domains and other transactional email flows retain their existing behavior.

The feedback record and GitHub issue creation are independent of email delivery.
Reporters can instead read and answer GitHub-backed messages inside the app; see
[bug-report conversations](./bug-report-conversations.md) for the contributor
marker, public-visibility disclosure, and signed webhook setup. The email-contact
setting applies to email only.
