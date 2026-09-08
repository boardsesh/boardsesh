# iOS keychain namespaces (v2 + legacy)

**If you are here at 2am about to roll an OTA back, read [Rolling back, and rolling forward again](#rolling-back-and-rolling-forward-again) first.** Short version: a rollback is safe, a roll-forward is safe *since #5345*, and if the build you are rolling forward *to* predates #5345 you will sign out roughly a seventh of the users who spent a day on the rolled-back bundle.

Scope: iOS only. `USES_V2_NAMESPACE` is `process.env.EXPO_OS === 'ios'`, so on Android and expo-web every helper here is byte-for-byte the single-namespace code that shipped before #4127. On Android `keychainService` selects the KeyStore alias *and* the SharedPreferences storage key, so a second namespace there would strand every existing value behind a name nothing reads.

## Why there are two namespaces

`keychainAccessible` is applied when a keychain item is **created**. expo-secure-store's iOS `setItemAsync` reaches `SecItemAdd` only for an item that does not exist yet; an existing item takes the `errSecDuplicateItem` branch into `update()`, whose update dictionary is `kSecValueData` alone (`SecureStoreModule.swift:127-144`). Accessibility is never re-sent, and JS cannot read `kSecAttrAccessible` back to notice.

So every credential written before #3602 (2026-07-15) is still `kSecAttrAccessibleWhenUnlocked` and *cannot be upgraded in place*. On a locked phone its background read fails with "User interaction is not allowed", which means the refresh that would have rewritten it never runs, which means it stays broken forever. That was #4103, and it was growing: 183 users at #3602, 283 by the time #4127 shipped.

The fix (#4127) copies values into a keychain **service** we had never used, `boardsesh.v2`, where every write is a guaranteed-fresh `SecItemAdd` and therefore actually applies `AFTER_FIRST_UNLOCK`.

| | service | accessibility | who reads it |
| --- | --- | --- | --- |
| **v2** | `boardsesh.v2` | `AFTER_FIRST_UNLOCK` | #4127 and later |
| **legacy** | default (`app`) | whatever each item was born with | every build, including pre-#4127 |

19 keys are carried: 3 auth (`boardsesh_jwt`, `boardsesh_refresh_token`, `boardsesh_token_expires_at`) and the 16 in `PREFERENCE_SECURE_KEYS`. Two are deliberately excluded, both documented at the source in `preference-secure-keys.ts`.

## Phase 1: both namespaces at once

Everything goes through `packages/mobile/src/lib/secure-store-io.ts`.

- **read** — v2 first; legacy only if v2 misses. A v2 *throw* propagates instead of falling through, because a throw means the item exists and could not be read; handing back a stale legacy copy would be worse, and `auth-session.ts` turns a throw into `unavailable` while a null is a real sign-out (#4001).
- **write** (`writeSecureValue`) — v2 authoritative, then mirror into legacy best-effort. The mirror is the rollback path; it must never fail the v2 write that just succeeded.
- **write to either** (`writeSecureValueToEitherNamespace`) — v2 and legacy independently, failing only when both reject. Used for the tombstone, where landing in *either* namespace beats landing in neither.
- **delete** — both namespaces, then a read-back (see [Deletes cannot be trusted](#deletes-cannot-be-trusted)).

The migration itself is `keychain-namespace-migration.ts`: per key, read v2 → read legacy → write v2 → **read it back** before calling it migrated. Nothing is ever destroyed, so every interruption leaves a key either legacy-only (retry next launch) or in both namespaces — never neither.

Auth keys migrate from `auth-store`'s own first read, inside its credential mutation queue so the pass cannot interleave with a sign-in or sign-out. The 16 preference keys migrate from a root component and stand down on any key this process has already written or deleted (`wasSecureKeyTouchedThisProcess`).

## The freshness stamp

**The problem it solves.** "v2 first" is only correct while v2 holds the newer value, and a rollback breaks that. Pre-#4127 JS reads and writes the legacy namespace alone. `ensureFreshToken` fires whenever the JWT is inside its last day (`JWT_EXPIRY = '7d'`, one-day threshold in `auth-store.ts`), so a day on a rolled-back bundle lands a new JWT and a **rotated refresh token** in legacy while v2 keeps the pre-rollback pair. Roll forward: the read returns the stale v2 pair, whose refresh token the backend revoked the moment the rollback build rotated it (`native-auth.ts`, atomic `revokedAt`) — 401, `forceSignOut`. And `migrateKey` reported `already-v2` and never repaired it, because the presence of a v2 item was its only "done" signal.

**Why a counter alone cannot fix it.** This is the crux. The rolled-back build knows nothing about generations, so it never bumps one. Its write is invisible to any marker it does not itself maintain — the counters on both sides still agree while the *values* have diverged.

**What we store instead.** Per key, in the v2 namespace, under `<key>.nsgen`:

```json
{ "g": 7, "v2": "1042.k3f9x1", "l": "1042.k3f9x1" }
```

`g` is a monotonic per-key count of writes by stamp-aware builds — diagnostic only, and what you compare between two devices. `v2` and `l` are short FNV-1a fingerprints (length-prefixed, not cryptographic — the only thing riding on them is "did somebody else write this", and a collision costs a repair we could have made, never one we should not have). Each side is one of three things:

| value | meaning |
| --- | --- |
| a fingerprint | we left this content there |
| `null` | we left it empty |
| field absent | we do not know — our write or delete could not be confirmed |

**The rule.** A namespace whose current content disagrees with the stamp was last written by a build that maintains no stamps, i.e. one running *after* our stamp — so its content is the newer one. Concretely, in `resolveNamespaceVerdict`, for a key present in both namespaces with different content:

1. no stamp, or an unreadable one → **v2 wins** (indistinguishable from the pre-#5345 world)
2. `v2` fingerprint does not match what v2 holds → **v2 wins** (only a v2-aware build writes v2, and it writes v2 first, so the divergence means *its* legacy mirror was rejected)
3. `l` field absent → **v2 wins** (see the tombstone contract below)
4. `l` matches what legacy holds → **v2 wins** (legacy is exactly as we left it)
5. otherwise → **legacy is newer**, and `migrateKey` copies it into v2 and reports `repaired`

Every uncertainty resolves to "v2 wins", so the only path to a repair is the rolled-back build's exact signature: legacy moved, v2 did not.

**Why it is not stored in the value.** Wrapping a value in an envelope would hand a rolled-back build JSON where it expects a JWT — including a rollback to #4127 itself, which reads v2. Bare values in both namespaces is what keeps every older bundle able to read what we write. **Why v2 only.** Legacy items are `WHEN_UNLOCKED` and reject on exactly the locked devices this whole thing exists for; a stamp you cannot read when you need it is worse than no stamp. It also leaves phase 2 nothing extra to clean up.

**Cost.** One extra lock-safe v2 read per key per process (the generation is then cached), one extra v2 write per mutation, and — only for keys that already have a stamp — one legacy read per key per migration pass. An unstamped key never touches the legacy namespace, so the zero-legacy-contact path for locked devices is preserved.

## The tombstone contract

**A tombstone always beats a live credential, whatever the generations say.**

`SECURE_STORE_TOMBSTONE` (`__boardsesh_auth_credential_cleared__`) is written over a key whose item refuses deletion but still accepts an overwrite. `readSecureValue` maps it to `null` in either namespace, so the key reads as absent.

The string is load-bearing: tombstones written by earlier builds are sitting in real keychains today, and renaming the constant turns every one of them back into a readable credential.

The dangerous case, and the reason "just prefer legacy" is wrong: sign-out lands the tombstone in v2 while the legacy write is rejected on a locked device, so legacy still holds the live credential. Rule 3 above is what covers it — the rejected legacy write records `l` as *absent*, and an unknown never out-ranks v2. Preferring legacy on any divergence would sign that climber back in on their next launch.

## Deletes cannot be trusted

expo-secure-store's `deleteValueWithKeyAsync` discards all three `SecItemDelete` statuses and never throws (`SecureStoreModule.swift:43-51`). A delete that did nothing is indistinguishable from one that worked.

With two namespaces that stopped being survivable: a landed v2 delete beside a silently failed legacy one leaves the old value reachable through the read fallback, and the next launch's `migrateKey` copies it back into v2 and makes it durable. So `deleteSecureValue` deletes both, **reads back**, and on a survivor writes the tombstone over it. If both deletes land, the stamp is deleted too rather than accumulating a keychain item per cleared key.

Sign-out does the same thing one level up and *fails loudly*: `clearStoredCredential` re-reads through the getters' own path and raises `AuthCredentialCleanupError` unless the key reads absent. Nothing in JS can remove an item that refuses both deletion and overwrite, so failing loudly is the whole remedy.

## Rolling back, and rolling forward again

**Rolling back is safe.** Every write is mirrored into legacy, so pre-#4127 JS finds a current token. Nothing is deleted from legacy until phase 2.

**Rolling forward is safe from #5345 onward.** The stamp detects the rolled-back build's legacy writes and `migrateKey` repairs v2 from them. Watch the `Keychain Namespace Migration` PostHog event: a non-zero `repaired` count is devices coming back from a rolled-back bundle that would previously have been signed out.

**Rolling forward to a build between #4127 and #5345 is not safe.** That build reads v2 first and has no way to notice the newer legacy copy, so anyone whose token refreshed during the rollback gets a revoked refresh token, a 401 and a forced sign-out — roughly **1/7 of active users per day spent on the rolled-back build**, since the refresh fires inside the JWT's last day of a 7-day expiry.

If you must land on such a build, the exposure is proportional to time spent rolled back, so roll forward fast; there is no in-app remedy short of the affected climbers signing in again.

**Rolling back past #5345 but not past #4127** costs nothing extra: that build maintains no stamps, but it writes both namespaces, and the stale stamp it leaves behind resolves to "v2 wins" (rules 2 and 4) rather than to a wrong repair.

## Where phase 2 lands

Phase 2 is **#4128**, gated on the `Keychain Namespace Migration` event showing the fleet has migrated — a residual population still reporting `legacy-read-failed` means phase 2 would strand them. It:

- drops the legacy mirror in `writeSecureValue`
- collapses `readSecureValue` to a single v2 read
- deletes the legacy copies (verified by reading, not by trusting the delete)
- stops `deleteSecureValue` double-deleting
- revisits whether `boardsesh_party_profile` should join the migration

With no second namespace there is nothing left to disagree with, so the stamp goes too — `secure-store-stamp.ts` is deleted in the same pass, along with the reconcile branch in `migrateKey`. The tombstone stays: single-namespace deletes are still unverifiable.

The better endgame, if a native train allows it: patch expo-secure-store's `update()` to carry `kSecAttrAccessible` (exactly what `modules/live-activity/ios/SharedKeychain.swift` already does). That fixes every item through a plain `setItemAsync` and retires the whole v2 layer rather than half of it. It needs a `patches/**` entry, which moves the OTA fingerprint.

## Files

| file | what it owns |
| --- | --- |
| `packages/mobile/src/lib/secure-store-options.ts` | the two options constants, `USES_V2_NAMESPACE` |
| `packages/mobile/src/lib/secure-store-io.ts` | read / write / write-to-either / delete, the tombstone |
| `packages/mobile/src/lib/secure-store-stamp.ts` | the stamp: fingerprint, wire format, freshness rule |
| `packages/mobile/src/lib/keychain-namespace-migration.ts` | the per-key pass, the repair, the once-runner |
| `packages/mobile/src/lib/preference-secure-keys.ts` | the 16 non-auth keys, and the two exclusions |
| `packages/mobile/src/lib/auth-store.ts` | the 3 auth keys, the credential mutation queue, sign-out verification |

Tests live in `packages/mobile/src/lib/__tests__/`: `secure-store-namespace.test.ts` (phase-1 behaviour + sign-out), `secure-store-rollforward.test.ts` (#5345 roll-forward, the resurrection guard, delete read-back), `secure-store-stamp.test.ts` (the pure rule), `keychain-namespace-migration.test.ts` (the pass), `secure-store-non-ios.test.ts` (Android/web stay single-namespace), `secure-store-writers.test.ts` (every writer routes through the helpers).
