# Dedicated credential writer: private web commands

This is a dark prerequisite for #6975. It does not activate either identity authority or establish that every deployed writer has been retired. Track those rollout decisions and receipts in #7430.

`@boardsesh/db/credential-writer-acl` exports the read-only `qualifyCredentialWriter(connection, { expectedRole: 'boardsesh_identity_writer', expectedDatabase, contract: 'private-web-v1' })`. The authenticated connection must have both `current_user` and `session_user` equal to the dedicated LOGIN. A privileged connection followed by `SET ROLE` is refused. The receipt records the contract, authenticated/session role, database name/OID, server version and a digest of the observed grants and reviewed routine/trigger evidence. The digest is not a complete schema fingerprint, a physical-cluster identity, a migration epoch, or permission to activate.

## Exact capability boundary

This first contract supports only the backend private web auth, provider-intent/callback, and signout command handlers. The pool layer separately verifies explicit connection configuration and actual content/writer target identity. There is no fallback to the ordinary content connection.

| Relations | Effective privileges |
| --- | --- |
| `users`, `user_credentials` | SELECT, INSERT, UPDATE |
| `accounts`, `auth_account`, `auth_session`, `verificationTokens` | SELECT, INSERT, UPDATE, DELETE |
| `user_profiles` | INSERT |
| `mobile_refresh_tokens` | SELECT, UPDATE |
| `auth_credential_lineage`, `auth_session_denials`, `auth_email_reservations`, `auth_subject_cutoffs`, `auth_password_recovery_state`, `auth_password_recovery_tokens`, `auth_email_verification_state`, `auth_email_verification_tokens`, `auth_web_oauth_intents` | SELECT, INSERT, UPDATE |
| `auth_email_reservation_members` | SELECT, INSERT; column UPDATE on `observed_at` only |
| `auth_security_mutation_events`, `auth_web_oauth_commands` | SELECT, INSERT |
| `auth_email_projection` | SELECT |

The manifest remains read-only. Normal commands use the shared advisory gate and capture the live authority receipt; this LOGIN cannot switch the manifest or append migration epochs. `users` DELETE, profile reads/updates, native refresh issuance INSERT, integration credentials, job ownership, location content and direct partner OAuth access are outside this contract. The table and column checks include effective PUBLIC grants, grant options and PostgreSQL17+ MAINTAIN. MAINTAIN can run an owner-evaluated materialized-view query despite the caller having no SELECT or ordinary DML rights.

Member verification uses `SELECT FOR UPDATE`. PostgreSQL requires UPDATE on at least one column for that row lock, so the separate static column contract permits only `UPDATE(observed_at)`, with effective SELECT required too. It does not permit whole-table UPDATE or UPDATE of the member's `user_id`, `normalized_email`, or any other column. Those identity keys remain immutable to this LOGIN. The test-only grant helper applies exactly the observation-column grant; no production role provisioning changes here.

The private commands still need their existing transport authentication, command validation, freshness, actor, admission, generation, purpose, replay and transactional checks. A database capability does not replace those checks.

## Password-trigger closure

Password writes already run `trg_user_credentials_partner_revoke_insert` and `trg_user_credentials_partner_revoke_update`. The qualifier pins both exact attachments/WHEN expression/enabled state, the SECURITY DEFINER wrapper and its SECURITY INVOKER `partner_revoke_user(text)` callee by source SHA256, language, search path, lock timeout and ownership matching the credential table. It grants neither routine directly to the writer.

The reviewed callee updates connection generation/revocation fields, then deletes pending grants/codes, access and refresh tokens, consent, refresh ancestors, consent interactions and partner sessions. It does not delete connections or applications. The indirect sink closure includes `oauth_connections`, `oauth_verification`, `oauth_grants`, `oauth_access_token`, `oauth_refresh_token`, `oauth_consent`, `oauth_refresh_ancestors`, `oauth_consent_interactions` and `oauth_session`. This is the existing password-revocation trigger behavior, not adoption of all partner authority commands.

All direct and indirect relations must be ordinary heap tables with builtin types/opclasses and no RLS, partition/inheritance, rewrite rules, custom expression routines or extra triggers. Cascades are checked for the mutation kinds this closure can actually execute. Exact canonical column/default/index/constraint shapes also refuse builtin expression side effects, which PostgreSQL omits from pg_depend. A users ON DELETE cascade cannot be reached because this contract denies users DELETE. Shadowing of the operators/functions used by the pinned bodies is refused. Future implicit routine EXECUTE and future PUBLIC/writer grants are refused. Every application routine is denied direct EXECUTE. Explicit system-catalog/routine/parameter grants are refused, including SET on `session_replication_role`; the existing builtin PUBLIC UPDATE on `pg_settings` is the narrow exception, and the session must remain in origin replication mode.

The LOGIN must have no superuser, create-role, create-database, replication or RLS-bypass attributes, memberships in either direction, owned objects, database/schema CREATE or database TEMP. These are startup observations on this connection. DDL/grant changes after qualification still require coordinated rollout fences and requalification; the receipt is not a durable catalog lock.

## Reproduce the owned proof

Use a fresh dedicated local PostgreSQL18/PostGIS image with canonical repository migrations. Do not target the seeded development DB, a shared role cluster, or a production connection. The checked-in bootstrap accepts only loopback port55480 and `epic6975_credential_YYYYMMDD`; CI accepts only its explicit `epic6975_credential_ci` on5432. The URL and every PG* connection field must match before any database call. The bootstrap refuses nonempty public schemas and applies each Drizzle journal entry in its own transaction with both exact ledgers. The test fixture independently verifies all SQL hashes, journal timestamps and insertion order before creating synthetic LOGIN roles or grants.

```sh
export PGHOST=127.0.0.1 PGPORT=55480 PGUSER=postgres
export PGDATABASE=epic6975_credential_20261113
export PGPASSWORD='<owned-local-fixture-password>'
export CREDENTIAL_WRITER_PROOF_DATABASE_URL="postgresql://postgres:${PGPASSWORD}@127.0.0.1:55480/${PGDATABASE}"
bash packages/backend/scripts/bootstrap-credential-writer-proof-database.sh
vp test run --config packages/backend/vite.credential-writer-proof.config.ts --reporter=agent
```

The test-only fixture grants are not a production role plan. It creates fixed synthetic `boardsesh_identity_writer` and `boardsesh_retired_runtime` logins only after target/history qualification. The proof uses actual separately authenticated connections, not SET ROLE. Keep all catalog-mutating proof suites serial on their owned cluster; ordinary command tests may use unique account IDs.

The PG18 full-schema proof has 28 cases: positive LOGIN/transaction qualification; wrong principal/database and SET ROLE refusal; unsafe attributes/memberships/ownership/TEMP/CREATE; missing/excess/column/PUBLIC/grant-option/default grants; routine/system/parameter escape checks; RLS/rule/trigger/default/cascade drift; real password-trigger commit and rollback without raw partner DML; the still-open old-runtime bypass of a web-only fence; and actual MAINTAIN-only owner execution with both fence verifiers refusing it. Four added member-lock cases execute real `FOR UPDATE`, refuse its missing observation-column grant, and separately reject whole-table UPDATE and UPDATE of each identity key. Local evidence: PG18.6, PostGIS3.6.4,311 exact journal entries,28/28 passing. A separate owned PG15.19 schema-only fixture also qualifies the exact30-relation contract and executes the web MAINTAIN version guard successfully; this is SQL/catalog compatibility, not a complete PG15 migration or extension proof. No production catalog, account or credential was read or changed.

## Mounted commands and required CI

The complete serial task passes 32 cases: 28 catalog cases followed by four mounted HTTP flows across both selected stores. The HTTP handlers use their production default credential factory and separately authenticated writer LOGIN. They cover registration, resend invalidating the old verification link, verification, password sign-in, recovery/reset, provider intent/resolution, first-password setup with preserved continuation age and generation, reverse password mirroring, and signout. A generic shared-handle trap rejects fallback. Before admission reads are granted, the content LOGIN's inherited users DML is revoked and a real attempted write fails with 42501; the earlier web-only fence counterexample cannot accidentally leave a writable content principal for this proof.

`test-credential-writer` owns a separate runner and the repository's already-pinned PG18/PostGIS image. It applies the canonical journal to the fresh `epic6975_credential_ci` database, then runs both proof files unfiltered, serially and without task caching. The proof config stays outside the root/default projects that have no database services. Its failure or cancellation fails the required aggregate. An unconditional workflow/bootstrap boundary guard checks target mismatches and libpq routing/session overrides before any network or database command, with a positive control reaching the trapped first catalog probe.

The bootstrap refuses inherited `PGHOSTADDR`, `PGSERVICE`, `PGSERVICEFILE`, `PGSYSCONFDIR` and `PGOPTIONS`; ordinary TLS client settings remain available. No production provisioning is performed. The existing isolated-authority PgBoss inventory correction is reused from the independently reviewed location proof, so dedicated fresh-database suites are not mistaken for shared backend role tests.

```sh
vp run test:credential-writer --reporter=junit --outputFile.junit=./test-results/junit-credential-writer.xml
```

Pass these arguments directly to `vp run`; an extra literal `--` reaches Vitest as an argument boundary and hides the reporter flags. With the proof's backend root, this writes `packages/backend/test-results/junit-credential-writer.xml`, the exact CI upload path. The final owned replay records two suites, 32 tests and zero failures/errors/skips in that artifact. Targeted connection/configuration/privacy/lifecycle tests also pass 77 cases, the node driver suite 41, and shutdown isolation 5. These receipts qualify source and the synthetic fixture only; rollout remains separate.

## Remaining rollout fences

The current web fence checks `boardsesh_web`; that cannot fence an old backend/worker/import/admin process still holding a broadly privileged runtime LOGIN. The characterization proof deliberately shows a separately authenticated old runtime writing users while the web verifier passes. This child neither changes existing runtime/job reconcilers nor withdraws their grants.

Before any activation, adopt and qualify every remaining identity writer on the correct physical transaction, narrow both migration-runtime and job-role reconciliation, deny protected table **and column** DML to every retired principal, and prove old pooled/prepared/queued/inflight work cannot commit across the cutover. Native issuance/revocation/cleanup, deletion's full content transaction, compound machine/location commands, partner authority and maintenance/operator commands require their own capability closure. Deployment credentials, replica/pool routing and full rollback must be qualified with live receipts. Stateless issuers holding an accepted signing key remain a separate retirement gate even after SQL DML is denied. Existing activation blockers remain unchanged.
