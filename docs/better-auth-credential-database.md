# Backend credential connection

This source slice supports BA-03/BA-04 in [epic #6975](https://github.com/boardsesh/boardsesh/issues/6975).
Operator decisions, private credentials and rollout actions remain in [#7430](https://github.com/boardsesh/boardsesh/issues/7430).

## Private web commands

The default database for the three private web command handlers is now a separately
authenticated `boardsesh_identity_writer` connection. Password/registration/recovery/
verification commands, provider commands and signout keep their existing public
adapters, private service authentication, validation, rate limits and reply shapes.
The handler obtains its database only after those checks pass. Each core operation
continues to own its existing complete transaction; this change does not split a
credential write from its reservation, profile, cutoff or revocation work.

Default legacy modes still refuse these private transports before opening the
credential connection. Missing, invalid or unqualified credential configuration
returns the existing sanitized unavailable reply. It never falls back to the
generic content connection. Existing explicit database injection remains an
in-process integration-test seam, not an HTTP parameter.

`AUTH_IDENTITY_DATABASE_URL` must name the same logical host, port and database as
`DATABASE_URL`, with a distinct login and password. The writer login is fixed to
`boardsesh_identity_writer`. Both URLs reject query parameters that could override
their targets; only `sslmode` is accepted. Non-loopback writer connections require
`sslmode=verify-full`, using the process's existing trusted CA configuration.
The catalog qualifier checks the actual authenticated/session principal and
database in addition to the URL. A transient read-only probe compares the
content and writer connections' primary server, database OID, postmaster start
and version before the pool is published. This qualifies the observed startup
targets; future routing changes require requalification. It does not use
`SET ROLE` or a caller-set GUC.

The pool is lazy, shared by these handlers within one backend process, and capped
at two connections. Connection setup has a two-second deadline; statement and
idle-transaction defaults are ten seconds. Existing command-specific tighter
transaction limits still apply. SQL logging is disabled on this Drizzle handle,
including when content-pool diagnostics are enabled. Failed qualification closes
the owned pool and permits a later retry. Changing its target while a cached
initialization/connection exists refuses rather than reusing a different target.
Process shutdown drains requests before closing the pool; one owner's close
failure does not skip the other owners, and admission closes last.

## Remaining capability work

The static `private-web-v1` catalog contract is deliberately limited to these three
handlers. It is not evidence that old runtime/worker identities have lost writes.
Native issuance/refresh/cleanup, account deletion, machine batches/location sync,
partner authority and maintenance commands need their own reviewed complete
transaction adoption. Their required content and revocation closure must be
included explicitly before stripping generic-role grants.

Migration and queue grant reconciliation must preserve the final role fence.
Prepared/queued old statements, memberships, column/default grants and indirect
write paths still need the assembled cutover proof. The extra two connections per
backend process, plus one transient content connection during qualification,
belong in the rollout connection budget. No role is created or
granted by this connection factory, no production URL is provisioned, and no
existing activation gate is removed. Retiring old processes holding accepted
signing keys remains a separate issuer gate.

## Private browser commands

The default-off browser service uses
`/api/internal/auth/browser-binding/v1/{bootstrap,describe,read,intent,login,logout}`.
Only `CURRENT_STORE_BROWSER_BINDING_MODE=backend-staging` enables it. Each command
requires the private service bearer, exact versioned DTO/path and a fresh request
before obtaining the credential pool. Browser cookies do not authorize this
service. Its startup selector also requires enforced cutoff readers.

`AUTH_IDENTITY_DATABASE_CONTRACT` defaults to the unchanged `private-web-v1`
profile. Browser commands explicitly require `private-browser-v1`, including its
reviewed browser-binding/intent table closure. A pool qualified for that profile
can also serve the existing web commands. The narrower default profile cannot
serve browser commands. Unknown profiles, a mismatched qualification receipt or
contract changes while the pool is cached refuse without a content-pool fallback.
The connection budget remains two retained writer connections and one transient
content-target probe per backend process.

The explicit `private-native-handoff-v1` profile extends the reviewed
first-password profile with native refresh-token insertion. Earlier profiles
continue to reject that extra permission. Selected browser transfers spend
their capability and create the native pair in one qualified transaction.
Receipt cleanup and first-password scrubbing keep using compatible qualified
profiles after browser features switch off. See
[selected browser to native sign-in](./better-auth-native-browser-handoff.md).

Bootstrap chooses its 30-day correlation deadline from the database clock; the
caller cannot select it. Describe returns only the authoritative binding cursor,
selection state and credential kind. It cannot retrieve identity or raw proof.
Read and authenticated transitions require actual current-version client-held
source bytes. The backend alone attaches the legacy decryption secret; callers
cannot submit a secret or substitute a canonical token for a JWE. Read obtains
the profile in the same admitted transaction, and its UID must match the session.

Each raw legacy proof is capped at 16 KiB of UTF8, and the entire JSON request is
capped at 64 KiB. Two maximal actual ASCII proofs fit that envelope. JSON escaping
can increase wire size; the overall body cap still applies before database work.
Replies are measured as serialized UTF8 before headers and capped at 64 KiB.
Oversized profiles produce a sanitized unavailable reply without partial identity
or truncation. No browser cookie is emitted by this service.

Shared transport defaults remain 16 KiB request / 64 KiB reply. Trusted facade
budgets retain the already merged 1 MiB ceiling, including location sync's
512 KiB request / 1 MiB reply. HTTP fields cannot choose these budgets. The
browser staging service has aggregate per-operation limits of 180 mutations or
600 read/describe requests per minute; public deployment throughput and fairness
remain an explicit qualification gate.

The owned full-schema HTTP proof covers both selected authorities and source
kinds with the actual restricted LOGIN and default pool factory. It verifies
correlation-only refusal, exact-candidate retries, logout denial, shortened
canonical primary expiry, wrong or unavailable legacy keys, request/reply limits,
profile identity and the absence of cookies or leaked source material.

Public bootstrap remains disabled. Canonical www/app coordination, CSRF/Origin
adapters, version-named host-only proof cookies, every authoritative reader,
ordinary renewal, missing-proof recovery and final Chromium/WebKit application
replay are still required. These private commands do not close those gates or
authorize production schema, role, configuration or mode changes.

## Verification

### Provider profile and versioned fixtures

`private-provider-v1` is an explicit reviewed superset of the web and browser
profiles on the same authenticated LOGIN. It adds SELECT/INSERT/UPDATE on the two
0313 provider intent/reauthentication tables, without maintenance DELETE. Direct
partner revocation permits only the pinned strict SECURITY INVOKER
`public.partner_revoke_user(text)`, with no PUBLIC or grantable EXECUTE. Its
column grants read only predicate/join/revocation fields, update the four existing
connection revocation fields, and delete the eight existing credential/code
relations. They do not permit token reads, issuance, extension, ownership changes
or connection deletion. Every other application routine remains unavailable.

The 0313 security-event CHECK contains nine explicit kinds. The unchanged web and
browser catalog receipts reject that shape even after excess provider grants
are removed. Applying 0313, provisioning the reviewed provider grants and choosing
the explicit backend profile therefore require a coordinated rollout. A profile
name is not an attestation, and no production role, URL or activation flag is
changed by the qualifier or fixture tools.

The required credential CI job keeps two databases and serial tasks. Historical
web/browser proofs use exactly the published 313-entry journal through 0312;
both the normalized journal and every SQL byte are pinned by fixed SHA256
provenance. Only the fixed `--historical-private-browser-v1` bootstrap option can
materialize that prefix. It is never called current-canonical. Provider proofs
use the full current canonical journal, including 0313, and rerun the actual
private web/browser HTTP commands through `private-provider-v1` alongside the
provider command proofs. Both JUnit artifacts are required. There is no generic
migration cutoff, schema CHECK rewrite or permissive old-profile fallback.

The ordinary staged first-password path remains closed pending its separate
account-bound existing-email confirmation and publication proof. Email
confirmation itself must not create fresh provider reauthentication evidence.

Owned-fixture tests cover explicit pool target selection and existing TLS behavior,
configuration refusal without connection-string leakage, actual SQL logging
suppression with a working logging positive control, and shutdown failure isolation.
The credential role's catalog and mounted command evidence are recorded separately
in the capability document. Mounted HTTP proofs use the production default
factory and an actual restricted LOGIN for both selected stores: registration,
resend and verification, password sign-in and recovery/reset, provider intent
and resolution, the first-password boundary and signout. Their generic shared database
handle throws on access, and an actual content-login write is refused. Source
readiness does not qualify production rollout.
