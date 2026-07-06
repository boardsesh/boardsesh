# Backend email (SMTP)

The `packages/backend` service sends transactional email through a small
Nodemailer module (`src/email/email-service.ts`). Today it powers the gym
ownership-claim flow:

- **Claim verification** — the link a claimant clicks to prove control of an
  email at the gym's website domain (transfers ownership on click).
- **Admin notification** — a heads-up to the review inbox when a claim needs a
  human (no verifiable domain on file).
- **Approval / ownership-lost** notices to the claimant and the displaced owner.

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
