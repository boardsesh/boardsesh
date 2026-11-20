# Identity import and reconciliation

Import uses the live mirror's `syncIdentity` primitive, committing one user at a time under the shared authority gate and user lock. Source credentials and provider subjects are read after locking. Exact bcrypt hashes and provider/subject pairs, including Facebook, are preserved. User IDs and verification timestamps stay in the original `users` table. OAuth tokens and sessions are never imported.

## Commands and connection

`plan` is the default and read-only: it checks every precondition below and reports the writer epoch and how many users the next pass would visit. Only the named `import` verb writes; a missing verb never selects it. Neither command, nor a zero-difference report, activates authority, enables mirrors, or proves every writer participates.

Import connects only as the dedicated credential LOGIN, from `AUTH_IDENTITY_DATABASE_URL` (contract from `AUTH_IDENTITY_DATABASE_CONTRACT`, default `private-web-v1`). The login that copies is the one that qualifies; the administrative URL is never used for writes. Reconciliation keeps the read-only `AUTH_OPERATOR_DATABASE_URL`. Both use the shared connection policy: no `DATABASE_URL` fallback, `--confirm-host` must name the URL's host, remote certificate validation, SQL logging refused, bounded transaction timeouts. `AUTH_IDENTITY_MIRROR=on` must also be set: the operator's statement that every backend runs the live mirror, which no catalog can show.

## Preconditions

Both verbs check, in order, before reading or writing any identity row. Database checks are read-only and come first, so `plan` names the first database precondition that fails; the code gates come last, so a refusal there means every database precondition held. Each failure prints `Identity import refused (CODE).` and exits 1:

| Precondition | Code |
| --- | --- |
| Arguments, `--confirm-host`, private key and checkpoint directory | `INVALID_ARGUMENTS`, `HOST_CONFIRMATION_REQUIRED`, `CONNECTION_CONFIGURATION_REJECTED`, `PRIVATE_*`, `CHECKPOINT_*` |
| The operator states the live mirror is on | `IDENTITY_MIRROR_REQUIRED` |
| `auth_account` has the copied columns and the unique `(provider_id, account_id)` index; the manifest has `writer_authority` | `MIRROR_TABLES_MISSING` |
| The connection logs in as `boardsesh_identity_writer` and `qualifyCredentialWriter` passes for the contract | `CREDENTIAL_WRITER_UNQUALIFIED` |
| The current manifest is `enforced` under the current normalizer | `AUTHORITY_NOT_ENFORCED` |
| `verifyFence` passes for `boardsesh_web` | `WEB_FENCE_UNVERIFIED` |
| The writer authority is `current-store` | `AUTHORITY_NOT_CURRENT_STORE` |
| No code gate in `IDENTITY_COPY_BLOCKERS` remains (`LEGACY_WEB_IDENTITY_WRITERS`: the web still writes identity tables outside the mirror; see [the code gate](better-auth-identity-mirror.md#the-code-gate)) | `IDENTITY_COPY_CODE_GATES_OPEN` |
| No activation code gate in `AUTHORITY_ACTIVATION_BLOCKERS` (`auth/authority/activation-gates.ts`) remains. `enforced` is database state an administrator could set by hand, so neither the import nor the mirror takes the phase as proof that `activate`'s gates closed | `ACTIVATION_CODE_GATES_OPEN` |

The manifest, fence and authority checks are one read-only snapshot. A check that could not run (connection refused or lost, a timeout) is `PRECONDITION_CHECK_UNAVAILABLE`, never a verdict; a rejected login is `CREDENTIAL_WRITER_UNQUALIFIED`. The mirror's own startup checks are the same list plus its configuration; see [identity mirror](better-auth-identity-mirror.md#preconditions).

While importing, every user's transaction re-reads the manifest after the shared gate and refuses with `STALE_AUTHORITY` unless it is still the enforced current-store projection and epoch the run qualified. A switch or re-prepare mid-run stops the import before that user's write; completed batches keep their checkpoints. A copy failure (for example `AUTH_IDENTITY_PROVIDER_OWNER_CONFLICT`, `AUTH_IDENTITY_SOURCE_GENERATION_STALE`) also stops the run with its code and rolls back only that user. Database conditions print `SQLSTATE_<code>`; anything else prints `UNEXPECTED_ERROR`, never driver text.

## Private state, batches and reports

Reconciliation uses only a repeatable-read, read-only snapshot and can run before activation, labelled not ready. Exit status 2 means differences exist; 1 means execution failed. Reports contain counts and keyed digests only.

The digest key is 64 lowercase hexadecimal characters in an owner-only 0600 file. Its directory and the initially empty checkpoint directory must be owner-only 0700 directories outside every git repository. Symlink paths are refused. Immutable checkpoint files are created exclusively with mode 0600, one per completed batch, bound by keyed digest to host, port and database. Cursors never appear in command arguments or reports. A failed partial batch safely replays committed users. Corrupt or incomplete checkpoints fail closed; preserve them for investigation.

Batches default to 200 users (maximum 200), pausing 100 ms between batches. New users sorting before a saved cursor require live mirrors. Run full reconciliation after each import pass; reaching the end of a cursor is not completeness evidence. Keep the same digest key to compare reports. Reconciliation compares password bytes, provider/subject pairs, source generation and unexpected canonical rows. Shared IDs and verification timestamps have no second copy to drift.

## Proof

`vp run test:identity-import-proof` runs in CI's `test-credential-writer` job, straight after the fresh canonical database is bootstrapped from the full migration journal. It template-copies that database, provisions the `private-provider-v1` LOGIN and the web fence from the live catalog, and reaches `enforced` the way the other owned proofs do (prepare, then the phase set directly). Only the code gates are mocked, with a module mock in the test as the other suites do; every database check is real. It seeds a password user, a Google-only user, an Apple-only user on a private-relay address, a user with a password and both providers, an unverified user, an account mid-deletion and a fully deleted tombstone, a duplicate-email pair in two case spellings, a Facebook-only identity and a user three resets in, then proves:

- with every database precondition held, the open code gates still refuse mirror boot and both import verbs (`IDENTITY_COPY_CODE_GATES_OPEN`, then `ACTIVATION_CODE_GATES_OPEN` once the copy gate is closed);
- with the gates closed, the mirror qualifies and `plan` reports every user;
- an import stopped by a stray canonical row resumes from its fifth checkpoint, processes only the remaining two users and rewrites none of the committed rows;
- every user ID, exact bcrypt string, provider subject (Facebook unmapped) and `users` row is unchanged, no token or session is copied, and the adapter reads verified and unverified state correctly;
- a second full pass changes nothing and reconciliation reports zero differences with equal digests;
- a wrong LOGIN password, an unreachable server, a broken manifest phase, web fence, LOGIN grant, unique index and authority each refuse at mirror boot and at both import verbs with their own code and write nothing; a misconfigured projection or epoch refuses the mirror with `AUTHORITY_STALE`;
- after a switch, a restart on the old configuration boots inert instead of refusing, and a redeploy at the new epoch qualifies;
- an import whose manifest moves between two batches stops with `STALE_AUTHORITY` after the first;
- a mirrored reset after a switch rolls back with `STALE_AUTHORITY`, and a process that never qualified refuses with `MIRROR_NOT_QUALIFIED`;
- with Better Auth as the authority, every imported credential verifies with its original password and provider subjects resolve to their original owners.

The duplicate-email pair and its mixed-case member only show that the import keys on user IDs and ignores email. `activate` refuses that state (`EMAIL_COLLISIONS_REMAIN`, `NORMALIZED_EMAILS_REQUIRED`), so production cannot reach `enforced` with it.

Owner commands belong only in GitHub issue #7430. Implementation agents must never run these commands against production.
