# BA-03 current-store password service

This is the first implementation slice of [BA-03 #6977](https://github.com/boardsesh/boardsesh/issues/6977), within [epic #6975](https://github.com/boardsesh/boardsesh/issues/6975). It follows the [accepted migration design](./better-auth-migration.md). The capability gate permits implementation; production activation, identity migration and partner launch remain separate decisions. This slice does not complete BA-03.

## Adopted paths and retained behavior

`packages/backend/src/auth/current-store/password-identity.ts` owns the existing native password verification, registration validation, duplicate precheck, bcrypt preparation and user/credential/profile inserts. The existing `handleNativeAuthCredentials` and `handleNativeAuthRegister` delegate those operations to it. Their HTTP adapters still own CORS, request parsing and limits, rate limits, status/error responses, logging and native token delivery.

There is no new endpoint, schema, dependency, database grant or Better Auth import. The store remains `users`, `user_credentials`, `user_profiles` and `mobile_refresh_tokens`. Web, OAuth, refresh/revoke and watch paths keep their existing implementations.

| Behavior | Preserved contract |
| --- | --- |
| Submitted email | Shared pure `normalizeAccountEmail` applies the existing native `trim().toLowerCase()` rule; dots and plus suffixes remain intact. |
| Stored legacy lookup | Credentials still use literal `LOWER(users.email) = submittedKey`; they do not newly trim or rewrite stored rows or use SQL wildcard matching. |
| Duplicate credential candidates | Read at most nine candidates; permit at most eight comparisons. Check every admitted hash and authenticate only exactly one password match. Oversized or ambiguous matches return the same generic failure. |
| Missing password identity | Unknown email and OAuth-only accounts run one bcrypt comparison against `ABSENT_PASSWORD_HASH`, at the stored cost, and get the same generic credential error. |
| Password policy | Registration keeps 8–128 characters and bcrypt cost 12 (`PASSWORD_HASH_COST` in `@boardsesh/auth-protocol/password-hash`). Existing login gains no registration-length restriction; password whitespace, Unicode and existing bcrypt behavior are retained. Stored hashes are never rehashed. |
| Verification flag | Native registration stores null verification when enabled and a timestamp otherwise; native password login still does not enforce the web verification gate. |
| Issuance | Existing signing key, JWT claims/lifetime, refresh-secret storage, response fields and account-creation receipts remain owned by the existing native issuer. |

The precheck and bcrypt work stay before registration's transaction. Once prepared, `insertCurrentStorePasswordIdentity` receives the caller's transaction and generates the same new user ID and creation timestamp at insertion time. The native adapter calls the unchanged `generateTokenPair(userId, tx)` in that same transaction. User, credential, profile and refresh persistence therefore roll back together on failure. No generic callback framework or second native token issuer is introduced. Values needed after awaits are captured locally; the service does not retain caller-owned input objects through its reads/writes.

Password authentication retains its existing read/compare/issuance boundaries. This extraction does not claim to fix password-reset/issuance races or provide canonical revocation checks. Those changes require the later mutation contract and adoption by every validator.

## Known limits deliberately retained

`users.email` has no final normalized unique constraint. Registration's existing precheck compares the normalized submitted address with the exact stored email outside the transaction. It can miss legacy mixed-case rows and concurrent requests can both pass. The new module makes that policy explicit; it does not call this a normalized reservation, solve collisions, choose an account owner, or authorize a reassignment. A regression characterizes the retained gap without creating a second identity.

Other credential/account writers remain independent, including web registration, recovery and set-password, NextAuth adapter mutations and verification callbacks, native social linking, account deletion, system-principal jobs and fixture scripts. These two adopted native paths do not establish a sole database writer or fence stale deployments.

## Next BA-03 slices

1. **Build an unmounted reservation and mutation foundation.** Add generated Drizzle tables for unique normalized-email reservation keys, explicit blocked collision state, and durable mutation generation/cutoff/outbox records. Keep ambiguous existing groups occupied without selecting an owner. Mutation and revocation intent must commit together; deletion must not cascade away their security evidence. Do not activate these tables as a new identity authority.
2. **Establish the complete normalized projection and writer boundary.** Use the exact shared JavaScript normalizer for every existing identity key; do not assume SQL `LOWER(BTRIM(...))` has identical Unicode/whitespace semantics. Reconcile a final rescan under the reviewed database writer fence. An unfenced snapshot misses delayed old writes. Account for `PUBLIC`, memberships, ownership, grant options, alternate routines, new objects, deletion cascades, jobs and system principals. Retained read permission also leaves an old stateless token issuer capable of issuing credentials; table DML revocation alone is not the full issuer fence.
3. **Adopt web password operations over backend HTTP.** Preserve existing URLs as adapters with bounded server-to-server requests. Use the existing backend URL resolver; do not import backend source into the slim web image or copy credential policy into a shared client package. Move registration and login lookup together: web currently stores and queries exact email, so changing only registration normalization can break login. Keep mail configuration, verification behavior, generic recovery responses and current error contracts explicit. Availability failure must not fall back to direct web writes.
4. **Adopt social and security mutations as compound operations.** NextAuth separately awaits user creation, its profile event and provider linking; one HTTP RPC per adapter method does not make them atomic. Use a reviewed compound backend resolution/link operation or whole-callback transaction boundary. Preserve established provider-subject owners without implicit email takeover. Then adopt user-ID/purpose-bound recovery, verification, password set/change/reset and account deletion with atomic single use and revocation intent, preserving issued legacy links only with proven original ownership.
5. **Prove adoption and rollback before activation.** Test cross-surface registration/linking reservations, legacy recovery, account deletion, delayed jobs and real stale writer roles. Rehearse failures after actual credential mutations on a disposable restored database. Rollback must retain current authoritative credentials and cannot resume stale writers. Final identity collision resolution and uniqueness belong to BA-02; Better Auth identity import belongs to BA-04.

## Validation

The primary agent's full repository `vp run typecheck` passed all **58 tasks**.
Repository `vp check` passed with **0 errors and 623 existing warnings**.
The prepared QA notes cover native sign-in, case variants, wrong passwords,
registration and password-byte compatibility for manual review.

Run the existing native suites and the new current-store integration suite against local test infrastructure:

```sh
vp test run --project backend native-auth-register.test.ts \
  native-auth-credentials.test.ts native-auth-credentials-integration.test.ts \
  native-auth-oauth.test.ts native-auth.test.ts password-identity.test.ts \
  --reporter=agent
vp exec tsc --noEmit --project packages/backend/tsconfig.json
```

Author verification on 2026-11-04: the five existing native suites passed **105 tests**, including provider regressions and real-Postgres credential lookup. The new real-Postgres suite passed **7 tests** covering exact password bytes and bcrypt cost, short legacy passwords, literal email matching, ambiguous owners, verification behavior, current precheck limits, post-refresh rollback and the actual adapter's missing-signing-key rollback. Scoped lint/format and backend TypeScript checks passed. These checks use isolated local worker databases, not production accounts.

Independent review passed all **112 cases in 18.05 seconds**, with no actionable source, security or compatibility finding. All four TypeScript files passed selected lint/format checks without warnings. The literal-email fixture was then strengthened with a same-password neighbor that would make an `ILIKE` query ambiguous; equality still selects the exact owner. The reviewer rechecked that fixture-only change and independently reran the final **7 cases in 12.61 seconds**, with clean teardown. Runtime source was unchanged after the combined review run. These results approve this extraction's scope, not the remaining BA-03 writer-fence or migration gates.
