# Better Auth rollout: every switch, and the order to turn them on

Parent: [epic #6975](https://github.com/boardsesh/boardsesh/issues/6975), rollout issue BA-09 [#6983](https://github.com/boardsesh/boardsesh/issues/6983). Owner steps with paste-ready commands live in runbook issue [#7430](https://github.com/boardsesh/boardsesh/issues/7430).

This file answers one question: what can change how sign-in works in production, and in what order. It was written from the code (`grep` for `CURRENT_STORE_`, `AUTH_`, `PARTNER_OAUTH`, `BROWSER_DELEGATION` and `developer-console`), not from the older docs.

## The state today

- **Nothing in the repo sets any switch below.** Check Railway for the live values; do not assume them from this file.
- **The owner flips every switch.** Agents prepare commands and read production. They do not change production variables, flags or the database.
- **Only `PARTNER_OAUTH_MODE` is checked by `infra/railway/config.ts`** (web service: it must be `off`, `hold`, `allowlist` or `open`). No plan catches a typo in any other row. The code does: an unknown value throws at startup or on the first request, except where the row says "reads as off".
- **Unset, empty or `legacy` means off** for every `CURRENT_STORE_*` mode and for `AUTH_WATCH_PAIRING_MODE`.
- **Changing a mode never closes a code gate.** Section "Code gates" lists the ones that refuse regardless of environment.

Where a row says **Both**, set it on the web service and the backend service. **Backend** means the `boardsesh-backend` service (the workers run the same image).

## 1. Partner OAuth (BA-07, BA-08)

| Switch | Where | Values (default) | Turning it on | Needs first | Back out |
| --- | --- | --- | --- | --- | --- |
| `PARTNER_OAUTH_MODE` | Both | `off`, `hold`, `allowlist`, `open` (`off`; empty and unknown values read as `off`; case and surrounding spaces are ignored) | `hold` answers 503 on every partner route without loading Better Auth. `allowlist` and `open` serve the OAuth routes, `/v1` and the developer console. Today both register only developers on the allowlist. | `PARTNER_OAUTH_SECRETS`, `NEXTAUTH_SECRET` (the backend refuses to start the authority without them), `PARTNER_OAUTH_DEVELOPER_ALLOWLIST`, the `api.boardsesh.com` domain, the pre-stage-A list in "Running partner OAuth" in [integration-platform.md](./integration-platform.md) | Backend `off`, then web `off`. For a pause, backend `hold` alone. Refresh tokens are kept. |
| `PARTNER_OAUTH_DEVELOPER_ALLOWLIST` | Backend | Comma-separated user ids (empty: nobody can register) | Lets those users register apps, in `allowlist` and, for now, in `open` too. | A mode other than `off` | Remove the ids. Registered apps keep working. |
| `PARTNER_OAUTH_SECRETS` | Backend | `version:value,version:value`, newest first; each value at least 32 characters; versions 0 to 999,999,999 (unset) | Seals tokens and the `c3.` logbook cursors. | A mode other than `off` | Not a switch. Rotate by putting a new version first; dropping an old version sends its cursors back to a full sync (410). |
| `PARTNER_DEVELOPER_TERMS_VERSION` | Backend | A published terms version (the code constant) | **Ignored in production.** Registration opens when the owner approves the terms and the constant changes in a reviewed PR. Outside production the variable overrides it. | Owner approves `LEGAL.md`, `/legal` and the developer terms text (#7411) | Not applicable. |
| `developer-console` (PostHog server flag, `packages/web/app/flags.ts`) | Web | On or off for a person; off if PostHog is unreachable (off) | Shows `/developers/apps` and `/developers/terms` to the people it targets. The backend checks mode and allowlist again. | A mode other than `off`; the flag created and targeted at the allowlisted developers | Turn the flag off. The pages become 404. |
| `BETTER_AUTH_TELEMETRY` | Backend | Must be unset, empty, `0` or `false` | Nothing. Any other value makes the partner authority refuse to start, because it would override the telemetry-off setting. | Not applicable | Unset it or set it to `0`. |

Connected apps (Settings, Disconnect) works in every mode, `off` and `hold` included.

## 2. Shared secrets and identity settings

These are not modes. Most `CURRENT_STORE_*` modes below need them, and a missing or reused value makes the mode fail.

| Switch | Where | Values (default) | What it does | Needs first | Back out |
| --- | --- | --- | --- | --- | --- |
| `AUTH_CUTOFF_ENFORCEMENT` | Backend | `enforce`, `observe` (`enforce`; any other value is a startup error) | `enforce` refuses every credential that a cutoff, denial or generation bump rejects. `observe` admits and logs them (the pre-BA-04 behaviour). | Nothing | Leave it unset. The backend refuses to start with `observe` while any member of `STAGED_WRITER_MODE_ENV` (`authority-configuration.ts`) is on: `CURRENT_STORE_BROWSER_BINDING_MODE`, `_BROWSER_RENEWAL_MODE`, `CURRENT_STORE_WEB_AUTH_MODE`, `_WEB_OAUTH_MODE`, `_NATIVE_REGISTRATION_MODE`, `_NATIVE_OAUTH_MODE`, `_SYSTEM_BOARD_OWNER_MODE`, `_ACCOUNT_DELETION_MODE`, `_SET_PASSWORD_MODE`, `_PROVIDER_SECURITY_MODE`, `_FIRST_PASSWORD_MODE`, `_WEB_SIGNOUT_MODE`, `AUTH_WATCH_PAIRING_MODE`, `_BATCH_SYSTEM_USERS_MODE`, `_LOCATION_SYNC_MODE`. The proof, fixed-owner order and Google auth-time modes are not in the list. |
| `CURRENT_STORE_AUTH_RPC_SECRET` | Both | At least 32 bytes, no surrounding spaces, different from `NEXTAUTH_SECRET` and `CRON_SECRET` (unset) | Signs private web-to-backend commands. | Nothing | Unset it after the modes that use it are off. |
| `CURRENT_STORE_AUTH_PROJECTION_ID` and `CURRENT_STORE_AUTH_WRITER_EPOCH` | Backend | The current projection id; a positive integer up to 2,147,483,647 (unset) | Tell every staged writer which authority row to expect. A mismatch is refused as stale. | `auth-authority prepare` for the id. Every staged writer also refuses with `AUTHORITY_NOT_ENFORCED` until `activate` succeeds (section "Code gates"). | Unset them after the modes are off. |
| `CURRENT_STORE_DELETED_EMAIL_KEY` | Backend | At least 32 bytes, different from the other secrets (unset) | Keys the address digest kept for 90 days after an account is deleted. Every staged mode needs it, because an unknown address also looks up a digest. | Nothing | **Never rotate it.** Rotating frees every address deleted in the last 90 days. Keep a copy in 1Password. |
| `CURRENT_STORE_AUTH_BACKEND_ORIGIN` | Web | Backend origin URL (unset) | Where the web sends private commands. | The backend modes it serves | Unset after the mode is off. |
| `EMAIL_VERIFICATION_ENABLED` | Backend | `true` or anything else (existing setting) | Staged writers copy it into their authority record. | Not an epic switch | Existing behaviour. |
| `DEBUG_SQL` | Backend | Must not be `true` while a staged writer is on | Staged modes refuse to run with SQL logging on, because it would log credentials. | Not applicable | Unset it. |
| `AUTH_IDENTITY_DATABASE_URL` and `AUTH_IDENTITY_DATABASE_CONTRACT` | Backend | A connection string for the dedicated credential-writer role: same host, port and database as `DATABASE_URL`, a different user and password. The contract is `private-web-v1` (default), `private-browser-v1`, `private-provider-v1`, `private-first-password-v1`, `private-native-handoff-v1` or `private-browser-renewal-v1`. | Opens the separate pool the staged credential writers and their maintenance jobs use. A wrong or shared role is refused at startup of that pool. | The owner creates the role `boardsesh_identity_writer`; no repo script does (`auth-fence apply` creates `boardsesh_web`, a different role). The connection user must be exactly that name. Hosts other than loopback need `sslmode=verify-full`. See [better-auth-credential-database.md](./better-auth-credential-database.md) | Unset both. |
| `AUTH_OPERATOR_DATABASE_URL` | Operator shell | Administrative connection string (unset) | Input to `auth-fence`, `auth-authority`, `auth:import-identities` and `auth:revoke-sessions`; used with `--confirm-host`. Not read by any service. | The reviewed plan hash, trusted CA in `NODE_EXTRA_CA_CERTS` | Unset it. |
| `ACCOUNT_EMAIL_RESOLVE_DATABASE_URL` | Operator shell | Connection string for the intended database; never falls back to `DATABASE_URL` (unset) | Input to `resolve-account-emails.ts`. | Private evidence and decisions files | Unset it. |
| `AUTH_IDENTITY_AUDIT_DATABASE_URL` | Operator shell | A local PostgreSQL URL only (unset) | Input to `audit-auth-identities.ts`; production URLs are refused. | Nothing | Unset it. |

## 3. Staged writer modes (`CURRENT_STORE_*` and `AUTH_WATCH_PAIRING_MODE`)

Each moves one kind of credential write from the old path into the backend's current-store service. All are off by default. A staged writer needs the section 2 values and an `enforced` authority, so **none can work until `activate` runs** (it cannot today). The backend also refuses to start with any of them on while `AUTH_CUTOFF_ENFORCEMENT=observe`, and with `AUTH_IDENTITY_MIRROR=on` unless the native modes are `reserved-staging`.

| Switch | Where | Values (default) | Turning it on | Also needs | Back out |
| --- | --- | --- | --- | --- | --- |
| `CURRENT_STORE_WEB_AUTH_MODE` | Both | `legacy`, `backend-staging` (`legacy`) | Web registration, password sign-in, email verification, forgot and reset password go to the backend. | RPC secret, backend origin on web, projection id and epoch, deleted-email key. Blocked on #7589 (one client can use up the login budget). | Web `legacy` first, then backend. |
| `CURRENT_STORE_WEB_OAUTH_MODE` | Both | `legacy`, `backend-staging` (`legacy`) | Google and Apple web sign-in identity writes go to the backend, with durable flow binding. | Same as above, plus `NEXTAUTH_SECRET` on the backend | Web `legacy` first, then backend. |
| `CURRENT_STORE_WEB_CREDENTIAL_PROOF_MODE` | Both | `off`, `compatible`, `required` (`off`) | The backend issues a signed proof of each web sign-in. `compatible` is **backend only**: the web throws if it runs in it. `required` makes the web reject any sign-in without a proof. | An enforced authority (see section 2) | Both `off`. Order: backend `compatible`, then both `required`; back out in reverse. |
| `CURRENT_STORE_SET_PASSWORD_MODE` | Both | `legacy`, `backend-staging` (`legacy`) | Fresh-sign-in set-password goes to the backend, keeping this device signed in and revoking the others. | Proof mode `required`; mandatory once `AUTH_IDENTITY_MIRROR=on` | Set `legacy`. |
| `CURRENT_STORE_WEB_SIGNOUT_MODE` | Backend (web forwards when staged) | `legacy`, `backend-staging` (`legacy`) | Web sign-out writes a per-session denial. | Cutoff enforcement `enforce`, RPC secret. **The backend refuses to start with `backend-staging`** while historical issuer retirement and old no-SID safety are unproven. | Set `legacy`. |
| `CURRENT_STORE_FIRST_PASSWORD_MODE` | Both | `legacy`, `backend-staging` (`legacy`) | Apple-only accounts can confirm their email and set a first password. Backend side only; the public page stays shut (see "Code gates"). | Section 2 values | Set `legacy`. |
| `CURRENT_STORE_PROVIDER_SECURITY_MODE` | Both | `legacy`, `backend-staging` (`legacy`) | Google and Apple link, unlink and account switching go to the backend, with the five-minute reauthentication rule. Backend side only; the public page stays shut. | Section 2 values, `NEXTAUTH_SECRET`. Google also needs #7590 fixed. | Set `legacy`. |
| `CURRENT_STORE_PROVIDER_GOOGLE_AUTH_TIME_MODE` | Backend | `off`, `auth-time-staging` (`off`) | Counts a Google reauthentication as fresh only with a real `auth_time`. | Provider security mode on; Google client id and secret | Set `off`. |
| `CURRENT_STORE_NATIVE_REGISTRATION_MODE` | Backend | `legacy`, `reserved-staging` (`legacy`) | Native registration reserves the email in the same transaction. | Section 2 values | Set `legacy`. |
| `CURRENT_STORE_NATIVE_OAUTH_MODE` | Backend | `legacy`, `reserved-staging` (`legacy`) | Native Apple and Google sign-in reserve identities the same way. | Section 2 values | Set `legacy`. |
| `CURRENT_STORE_SYSTEM_BOARD_OWNER_MODE` | Backend | `legacy`, `reserved-staging` (`legacy`) | The shared-board system user is created through the reservation. | Section 2 values | Set `legacy`. |
| `CURRENT_STORE_ACCOUNT_DELETION_MODE` | Backend | `legacy`, `reserved-staging` (`legacy`) | Account deletion writes the cutoff and keeps a digest of the address for 90 days, in the same transaction. | Section 2 values, including the deleted-email key | Set `legacy`. |
| `CURRENT_STORE_FIXED_SYSTEM_OWNER_ORDER_MODE` | Backend and workers | `legacy`, `cooperative-staging` (`legacy`) | Fixed system-owner writes take one non-blocking lock key, so identity writers and content writers cannot deadlock. | Nothing; required by location sync | Set `legacy`. |
| `CURRENT_STORE_LOCATION_SYNC_MODE` (+ `_ORIGIN`, `_RPC_SECRET`) | Backend and workers | `legacy`, `backend-staging` (`legacy`) | The gym location sync applies through one backend command. | Fixed-owner order `cooperative-staging`; its own 32-byte secret, different from every other secret | Set `legacy`. |
| `CURRENT_STORE_BATCH_SYSTEM_USERS_MODE` (+ `_ORIGIN`, `_RPC_SECRET`) | Backend and workers | `legacy`, `backend-staging` (`legacy`) | Recommendation and hold-classifier jobs get their system user from the backend. | Section 2 values; its own secret | Set `legacy`. |
| `AUTH_WATCH_PAIRING_MODE` | Backend | `legacy`, `source-bound-staging` (`legacy`) | Garmin pairing binds to the source session. | Required before `AUTH_NATIVE_REVOCATION_MODE=generation` | Set `legacy`. |

## 4. Authority switches (BA-04)

| Switch | Where | Values (default) | Turning it on | Needs first | Back out |
| --- | --- | --- | --- | --- | --- |
| `AUTH_IDENTITY_MIRROR` | Backend | `off`, `on` (`off`) | Every credential write also writes the canonical Better Auth tables, so the import has nothing to chase. | Delegated set-password, staged native writers, the fence and the rehearsal. **The backend refuses to start with `on`**, always: the check has no condition that passes. | `off`. The tables stay. |
| `AUTH_LEGACY_BRIDGE_MODE` | Backend | `off`, `shadow`, `on` (`off`) | `shadow` verifies legacy sessions against the canonical store and reports without issuing. `on` re-issues them as canonical sessions. | `on` needs web sign-out staged and generation revocation, both blocked, so it cannot start. Today no web route is mounted; the native refresh path reads it. | `off`. Existing denials are still enforced. |
| `AUTH_NATIVE_REVOCATION_MODE` | Backend | `legacy`, `generation` (`legacy`) | Native credentials die by account generation instead of one by one. | `AUTH_WATCH_PAIRING_MODE=source-bound-staging`. **The backend refuses to start with `generation`** until Garmin offline tick queue preservation is proven. | `legacy`. |

## 5. Browser design that #7596 deletes. Do not turn any of these on.

[#7596](https://github.com/boardsesh/boardsesh/issues/7596) replaces the host-only cookie, browser binding, lease and receipt design with one shared-domain session cookie and one central client guard, and deletes the code below. The binding was never on in production. These rows exist so nobody flips them.

| Switch | Where | Values (default) | What it would do | Why it stays off |
| --- | --- | --- | --- | --- |
| `CURRENT_STORE_BROWSER_BINDING_MODE` | Both | `legacy`, `backend-staging` (`legacy`) | Writes a server row and host-only cookies per browser. | Deleted by #7596. Bugs #7588 (locks the users row on every request) and #7594 (rollback leaves cookies that break legacy sign-in) are closed by deleting it. |
| `CURRENT_STORE_BROWSER_RENEWAL_MODE` | Both | `legacy`, `backend-staging` (`legacy`) | Renews a browser session through custody records. | Deleted by #7596. Needs binding. |
| `CURRENT_STORE_EXPIRED_BROWSER_BINDING_MODE` | Both | `legacy`, `backend-staging` (`legacy`) | Recovers a browser whose binding expired. | Deleted by #7596. Needs binding. |
| `CURRENT_STORE_BROWSER_PASSWORD_MODE` | Both | `legacy`, `backend-staging` (`legacy`) | Publishes password credentials through the binding. | Deleted by #7596. Needs binding. |
| `BROWSER_DELEGATION_SECRET` | Backend only | At least 32 UTF-8 bytes, different from the cookie, RPC, cron and deleted-email keys (unset) | Signs the 120-second backend leases (`bsbd1_` tokens). | Deleted by #7596. Never set it on the web or in a public environment. |
| Proof cookies (`BROWSER_PROOF_COOKIE_PREFIX`, no env switch) | Web | Active only under binding | Carry browser proofs in cookies. | Deleted by #7596. |
| Eight readiness functions that return `false` in code | Web (seven), Expo web (one) | No variable changes them | Open the public pages. Files in `packages/web/app/lib/auth/`: `browser-consumer-readiness.ts`, `browser-coordinator-readiness.ts`, `browser-password-readiness.ts`, `browser-renewal-readiness.ts`, `expired-browser-binding-readiness.ts`, plus `first-password-readiness.ts` and `provider-security-readiness.ts`; and `packages/mobile/src/lib/browser-consumer-readiness.web.ts`. Binding has no file of its own. | The first five and the Expo one are replaced by #7596's single mode switch. First password and provider security are **kept**, with their publication layer rewritten. |

## Code gates

A code gate is a constant or an assertion. No variable, flag or script option closes one.

**The three that block `auth-authority activate`** (`AUTHORITY_ACTIVATION_BLOCKERS` in `packages/backend/src/scripts/auth-authority.ts`). `activate` throws `ACTIVATION_CODE_GATES_OPEN` while the list is not empty. `status` and `prepare` print the list. `auth:import-identities` refuses for the same reason. The names are constants with no description in code; the meanings below come from runbook #7430.

| Gate | What it waits for |
| --- | --- |
| `GARMIN_OFFLINE_TICK_QUEUE_PRESERVATION` | Proof that the Garmin watch keeps its offline tick queue on a rejected refresh and on a same-account re-pair, including installed older watch builds. The owner has only a test watch, and public release is planned for December. Real-watch QA with the original signing key is still open. #7442 (owner-scoped outbox) is merged. |
| `STAGED_WEB_PROOF_GENERATION_STAMP` | The staged web sign-in proof carrying the account generation, with the cookie window closed, and evidence that every still-valid older web cookie (including no-session-id cookies) logs out safely.  The owner must also confirm the old sign-in issuers are retired (the old Vercel project's deployments and rollback issuers). |
| `NATIVE_REVOKE_RESET_LOCK_ORDER` | Native sign-out and password reset taking their locks in the BA-04 order, proved against real PostgreSQL with concurrent calls. #7440 added the reviewed lock-order fix and the inactive generation writer. The gate stays until the list in the source is emptied in a reviewed PR. |

**Startup assertions** (`packages/backend/src/index.ts`) refuse to boot: `AUTH_CUTOFF_ENFORCEMENT=observe` with any staged writer on; `AUTH_IDENTITY_MIRROR=on`; `AUTH_NATIVE_REVOCATION_MODE=generation`; `CURRENT_STORE_WEB_SIGNOUT_MODE=backend-staging` (its own assertion in `web-session-configuration.ts`, not tied to a gate constant); `AUTH_LEGACY_BRIDGE_MODE=on` without both of the last two.

## Order to turn things on

Each step names what must be true first. Stop at the first step whose condition is false.

### A. Partner OAuth, stages A to D

Nothing else in this document has to be on. Full runbook: "Running partner OAuth" in [integration-platform.md](./integration-platform.md). Owner items still open in #7430 before the first switch-on: developer terms approval, the connection budget, and the `api.boardsesh.com` domain. Nightly CI for the browser journey is open as #7605.

1. **Before stage A:** see "Before the first switch-on" in [integration-platform.md](./integration-platform.md). In short: `NEXTAUTH_SECRET` and `PARTNER_OAUTH_SECRETS` (backend variables) exist before the mode switch, `PARTNER_OAUTH_DEVELOPER_ALLOWLIST` is set on the backend, the `developer-console` flag targets the allowlisted developers, the AASA exclusions have been live 7 days, and `DB_POOL_MAX=4` is set on the web.
2. **Stage A:** `PARTNER_OAUTH_MODE=allowlist` on the web, then the backend. The owner's test app and test accounts only. Rehearse `hold` and `off`. Stage lengths and caps are in "Stages" in the same doc.
3. **Stage B:** add the Sequence and DivePeaks developers to the allowlist and the flag. Needs stage A clean.
4. **Stage C:** real climbers connect. Same caps (25 live, 20 new in 24 hours per app).
5. **Stage D:** `PARTNER_OAUTH_MODE=open`. Needs BA-02 shipped or registration that proves the email, the milestone 2 docs, a second independent security review, a Cloudflare rule for floods from many IPv6 /48s, and the email to a climber when an app connects. Until then `open` registers the same allowlisted developers as `allowlist`.

### B. Email uniqueness (BA-02)

Independent of everything else. No switch; these are database steps.

1. Send the 17 contact emails for the kind A groups and wait 14 days for replies.
2. Resolve the approved groups with `resolve-account-emails.ts` (plan, review the printed hash, apply). #7426, #7429, #7433 and #7448 are merged.
3. Fresh read-only audit: zero collisions, zero non-normalized users.
4. Build `users_email_lower_key` concurrently, then add and validate `users_email_normalized`. SQL is in #7430.
5. Mark #7436 ready and merge it. It must not merge before steps 1 to 4. #7444 is a one-off CLI labelled do-not-merge, because it merges accounts without ownership proof. #7446 and #7432 are open; #7430 tracks them.

### C. Identity authority (BA-04): fence, prepare, activate, import, switch

Needs step B done, because `activate` refuses while collisions or non-normalized emails remain. Every step here is parked until the three code gates close and a rehearsal passes.

1. **Fence:** `auth-fence.ts apply --confirm-host pgdr.boardsesh.com --plan-sha256 <reviewed hash>`. Creates `boardsesh_web` with no password. Set its password, move the web onto it, retire every old web pool.
2. **Prepare:** `auth-authority.ts prepare`. Leaves the phase `prepared`. **Do not run it in production until #7591 is fixed:** it silently stops all account deletion.
3. **Activate:** `auth-authority.ts activate`. Refuses while any of the three gates is open. The first enforced epoch is 1. Enforcement of denials needs the denial reader (#7439) on every backend first.
4. **Writer modes (section 3).** #7430 says the exact order will be recorded there before any switch, so none is fixed here. The dependencies are: proof `compatible` before `required`; `required` before set-password; fixed-owner order before location sync; native modes `reserved-staging` before the mirror. Turn on one mode at a time and watch it before the next.
5. **Mirror:** `AUTH_IDENTITY_MIRROR=on`. Blocked in code until the activation gates close.
6. **Import:** `vp run auth:import-identities -- --confirm-host pgdr.boardsesh.com --key-file ~/Private/boardsesh-ba04/digest-key --checkpoint ~/Private/boardsesh-ba04/checkpoints --batch 200 --pause-ms 100`. Reconcile read-only afterwards and 24 hours later.
7. **Switch:** `AUTH_LEGACY_BRIDGE_MODE=shadow`, then `on` once web sign-out is staged and generation revocation is allowed. Before generation revocation, `AUTH_WATCH_PAIRING_MODE=source-bound-staging`.

### D. First-party clients (BA-05, BA-06)

1. Native and watch (BA-06): code is on main (#7447, #7450, #7463, #7464). Open: installed original-key watch, queued ticks, hardware and FIT QA, downgrade.
2. Web and Expo web (BA-05): [#7596](https://github.com/boardsesh/boardsesh/issues/7596) builds one session cookie and one mode switch. That switch does not exist yet. Until it does, do not set any row in section 5.
3. First password and provider link, unlink and switching: backend modes can go on after step C; the public pages come with the #7596 rewrite.

### E. Retire NextAuth (BA-10)

No switch. Remove NextAuth only after the legacy cookie has been kept for 30 days after the cutover (owner decision 23), rollback has been rehearsed against a restored database, and the installed-client compatibility API (native, Garmin) is kept. #6984 stays open until then.
