# Current-store account deletion

This is an implementation slice of [BA-03 #6977](https://github.com/boardsesh/boardsesh/issues/6977) in [epic #6975](https://github.com/boardsesh/boardsesh/issues/6975). It adds independently selected security bookkeeping to the existing backend GraphQL account-deletion transaction. It does not activate an authority, migrate identities, change production privileges or delete a real account.

## Caller and authority boundary

The existing Expo flow is `DeleteAccountScreen` → `useDeleteAccount` → the shared `DELETE_ACCOUNT` GraphQL operation → `userMutations.deleteAccount`. Its input, Boolean response, confirmation UI and local sign-out behavior stay the same. No new web-to-backend credential command is needed: the mutation already belongs to the backend. The surviving web profile endpoint is read-only, and the profile mutation accepts cosmetic display-name/avatar fields rather than email changes.

`CURRENT_STORE_ACCOUNT_DELETION_MODE` defaults independently to `legacy`. The `reserved-staging` mode requires the exact configured current-store projection and writer epoch. Missing or malformed configuration must fail without falling back to legacy deletion. A normal legacy request must not read a projection or require current-store authority secrets.

The existing authenticated GraphQL principal supplies a server-established user ID. It does not prove recent authentication, a requesting-device session, or original authentication age. This slice preserves the existing deletion authorization rather than inventing any of those assurances. Production activation still needs an accepted sensitive-operation authentication contract.

## Transaction and lock order

The staged path first applies the existing statement and lock timeouts and locks the enforced projection. It then keeps the existing deletion order: spray-account lock, descending wall locks and board locks, followed by the target user update lock in privacy withdrawal. A user update lock before the wall locks would deadlock a wall/version writer that holds a wall and needs a creator foreign-key key-share lock. No identity helper may move that user lock earlier.

Immediately before the final user deletion, the staged path reads the current security generation and records an `account-deletion` mutation for both first-party and partner domains. The cutoff, retained deletion tombstone, security event, reservation changes, content cleanup and actual user deletion share the same outer transaction. Existing foreign-key cascades remove credentials, provider accounts, sessions and mobile refresh rows. A final-delete failure must restore all of them and the earlier content changes.

Owned email reservations become `blocked_deleted`. Ambiguous keys stay ambiguous and retain historical membership: deleting one collision member never elects a surviving owner. The implementation does not release keys, merge accounts, reassign ownership or consume legacy email-keyed links by selecting a current email owner. Retaining deleted keys is an implementation safety default, not approval of a permanent registration or privacy-retention policy.

A server-generated operation ID is captured once for the logical deletion request. The existing three-attempt retry remains limited to PostgreSQL deadlocks, whose transactions rolled back. A retry reuses the operation ID and re-reads generation. Unknown outcomes, configuration errors, permission failures and duplicate committed operation IDs must not become cached success or automatic retries.

PostHog erasure still uses the existing queue savepoint. Kiosk tombstone publication and spray-photo purge remain after the deletion commits; an aborted transaction must never start those effects. No provider network request is added inside the transaction.

## Limits and decisions

The projection lock is held during the existing potentially large content deletion. Five-second statement and four-second lock timeouts bound individual statements and waits, not the whole request. Large-account admission, total-work bounds, contention and failure measurements remain activation gates. This implementation must not be described as having a proven end-to-end time budget.

Persisting an event does not make old web/native JWT validators, caches, WebSockets, exchanges or partner consumers enforce it. Complete issuer/validator adoption and a measured enforcement window remain BA-04/BA-07 work. The selector is not a database privilege fence; stale direct writers and deployed roles require separate proof.

The user's password policy is unchanged: authenticated password set/change keeps the proven requesting device while revoking other credentials; forgotten reset revokes every session. The current set-password route has only a legacy user ID. Positive web source/publication lineage, original authentication-age evidence, renewal/logout handling and reader adoption are prerequisites to implementing that policy. A callback timestamp, rolling JWT issue time or legacy session identifier cannot replace them.

## Qualification

The independently authored 43-case PostgreSQL 18 selection passed with zero skips in 20.09 seconds at the recorded source hashes. It exercises actual GraphQL authentication with native JWS and legacy web JWE credentials, real final-delete failure and content rollback, reservation drift and history, the configured lock timeout, and the reset-after-bcrypt race. The deadlock retry case injects PostgreSQL `40P01`; it is not a measured multi-lock deadlock. The concurrent refresh-row insertion proves its foreign-key subpath, not the installed native refresh rotator or a spray-version publisher.

The existing seven-file regression selection passed 103 cases and skipped 42. All skips belonged to the published-climb matrix, whose infrastructure flag deliberately skips its entire file. A separate owned-fixture configuration disables the global infrastructure orchestrator and cleanup, then enables that matrix against a fresh salted worker database. Its first run executed all 42 cases: 39 passed and three failed because read clients still targeted the missing template database. Both owned test configurations now leave the replica URL empty, so read clients use the same rewritten worker primary as writes. The failed namespace is retained. The corrected matrix run passed all 42 cases with zero skips in 15.09 seconds; the skipped selection alone was not accepted as matrix coverage.

The November 5 tool interruption left whole checking and mobile QA without final launcher/cleanup receipts. Their original claims are retained with interruption records. The mobile child log reported 20 passing cases, but it is not accepted as completed qualification. Missing old handles and a host process audit established that no QA or preview process remained before new runs were prepared. No failed or interrupted database namespace is reset or reused.

The first broader auth run passed 706 cases and failed 26, all in the older public NextAuth handler proof. Its runner supplied an empty `VERCEL` value, which NextAuth selects before the fixture's explicit trusted-host setting. The test launcher now omits that invented value for tests, after checking that source environment files cannot restore it. Application and test source remain unchanged. The corrected public-handler selection passed all 27 cases in 10.81 seconds, followed by a complete 732-case run across 30 files with zero failures or skips in 373.65 seconds. This broader selection includes the 43 new deletion cases; these counts overlap.

A new independent mobile caller run passed 20 cases across two files with zero skips in 6.40 seconds. It uses mocked host/network I/O, not a real device. Canonical whole checking passed with zero errors and 623 existing warnings across 9,251 linted files in 56.8 seconds. Completed launchers confirmed exit zero, child closure, drained process groups and unchanged source snapshots. Clean-head type checking and a new default-legacy preview remain pending. These local proofs do not establish the production gates above.
