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

## Verification

Owned-fixture tests cover explicit pool target selection and existing TLS behavior,
configuration refusal without connection-string leakage, actual SQL logging
suppression with a working logging positive control, and shutdown failure isolation.
The credential role's catalog and mounted command evidence are recorded separately
in the capability document. Mounted HTTP proofs use the production default
factory and an actual restricted LOGIN for both selected stores: registration,
resend and verification, password sign-in and recovery/reset, provider intent
and resolution, first-password setup and signout. Their generic shared database
handle throws on access, and an actual content-login write is refused. Source
readiness does not qualify production rollout.
