# Default set-password before authority enforcement

This transitional family moves the default first-password write from the web app into the private backend. It preserves the existing legacy-session policy. It does not complete BA-03, introduce email confirmation, advance first-party generation or activate identity authority. Actual backend/configuration qualification must precede web adoption.

## Deployment boundary

1. Deploy and qualify `/api/internal/auth/current-store/set-password/v1/compatibility` on the intended backend first. It requires authenticated private RPC, legacy browser and set-password modes, mirror off, enforced cutoffs, SQL credential logging disabled and an unchanged absent or prepared current-store context.
2. Qualify the dedicated credential LOGIN and existing exact `private-registration-v1` profile, or `private-registration-evidence-v1` when password-change evidence is enabled. Only already-reviewed compatible descendants are accepted. This family adds no migration, grant, profile, feature flag or authority receipt.
3. Adopt the dependent web revision only after the actual backend origin, distinct RPC secret, shared legacy signing key, credential profile and ingress are evidenced. Default legacy requests then require this service. An old backend or missing configuration returns unavailable; there is no local SQL/hash fallback or automatic retry.

Explicit staged and canonical dispatches retain their existing paths. This private family refuses enforced, preparing, canonical or changed current-store contexts. Prepared reservations remain snapshots. It captures configuration before work and rechecks it around state reads, evidence recording and transaction completion.

Rollback to an old web build restores an independent credential writer. Capable backend availability and actual historical deployment/rollback retirement remain separate requirements; mode flags do not establish a safe writer rollback. The owner has confirmed older Railway builds remain available. Keep the [historical issuer gate](https://github.com/boardsesh/boardsesh/issues/7430) open until its actual retirement evidence exists.

## Held browser source

The public route obtains the viewer and exact held legacy JWE from one admitted-session resolution. Cookie selection, chunk reconstruction and the selected NextAuth cookie-name override remain shared with existing readers. The sender never chooses another cookie. Public expected-viewer checks keep their existing precedence; optional body IDs cannot select the private actor.

The strict private command carries the held credential, unchanged password/confirmation and the server-resolved UID and top-level display SID. Deterministic signed SID/jti relationships are checked. Pending or random display IDs never become signed session lineage, authentication age or a proof.

Primary cutoff admission uses the original signed generation and SID claims. Missing/null generation retains its existing zero meaning. A stale generation, denied signed SID, deleted account, failed JWE/JOSE validation or malformed generation cannot authorize the write. An old authentication time alone retains the released default eligibility; it never becomes fresh.

The narrowly scoped codec preserves measured source compatibility for missing expiry, missing JWT issuance/authentication time, future numeric JWT issuance time, and the measured falsey or truthy-invalid signed SID cohorts. A truthy non-string signed SID retains its pending-viewer behavior rather than becoming a new stable SID. It does not weaken the staged verifier or fabricate missing claims. Its expiry tolerance is the public NextAuth 15 seconds. Fresh database clocks recheck expiry after waits, before insertion and before commit. Refusing a credential that expires during the operation tightens the old admission-to-write race; it is not exact completion parity with the old web transaction. Synthetic accepted claims do not inventory what historical production issuers minted.

## Atomic write and uncertainty

The precheck may skip bcrypt for an existing password, but cannot return a final conflict. The final transaction revalidates the context and source, locks the actual admitted user, checks primary state, claims the request nonce and rereads credential existence. Every later actor must match that locked UID. A committed request replay is unavailable, including after an already-set result.

The mutation savepoint performs one real credential INSERT, its existing partner-revocation trigger, the legacy NULL-only verification update and optional exact-hash password-change evidence. A losing credential-PK INSERT rolls back its trigger effects before a known conflict can commit its nonce. Unrelated trigger, evidence or nonce uniqueness failures cannot become already-set. Other mutation failures roll back the outer transaction, including its nonce.

The carried NULL-only verification update is a compatibility defect, not proof of mailbox ownership. Prior verification timestamps are preserved. The accepted email-confirmed first-password policy remains separate work.

First-party/native generations, cutoffs, refresh rows, source SID, original known or unknown authentication age and expiry remain unchanged. Success issues no session, cookie, continuation, canonical token or credential proof. Revoking other first-party sessions remains separate policy work. The real credential INSERT's existing partner trigger still runs.

| Correlated private reply | Public result |
| --- | --- |
| `set`, 200 | Existing 200 success body |
| `already_set`, 409 | Existing password-already-set 409 |
| `unauthenticated`, 401 | Unauthorized 401; no cookie clear |
| `identity_changed`, 409 | Existing viewer-changed 409 with private/no-store |
| `error/rate_limited`, 429 | 429 with bounded Retry-After |
| `error/rolled_back`, 500 | Existing generic 500, only after acknowledged outer rollback |
| Replay, unavailable, transport/configuration/schema/status/correlation uncertainty | Fixed 503 with Retry-After 1 |

Only the exact locally tagged mutation failure returned after acknowledged outer rollback can produce the finite 500. Timeout, uncertain COMMIT, replacement rollback error or lost acknowledgement remains unavailable. There is no automatic mutation retry or cached success. A later distinct user action may report already-set; that does not prove which submitted password committed.

## Bounded work

This change sets the compatibility family's sender and receiver to 65,536 UTF-8 request bytes. The shared 16 KiB default and every other family's existing explicit budget remain unchanged. The separate public optional-body SID limit is unchanged. Service viewer metadata supports already-admitted larger SIDs within the whole-body bound. Boundary proofs include three-byte BMP characters and JSON-escaped controls; JavaScript string length is not a UTF-8 body measurement.

The public IP and UID guards remain. Private admission allows five attempts per vouched client per minute and a separate 180-attempt unattributed fallback. Only authenticated facade metadata can supply the Cloudflare-vouched address. The shared limiter caps underlying Redis operations at four, with a 100 ms caller wait; timeout does not release an unsettled Redis command. Local fallback does not establish a distributed rate guarantee.

Actual admission source selects its isolated work gate: one active command and at most eight queued for 2500 ms. Qualification, pool acquisition, snapshots, bcrypt and SQL retain the slot through actual settlement. A seven-second response deadline does not release unfinished work. Transaction/statement limits use at most five seconds or the remaining budget. Disconnection and timeout never authorize retries or abandon work custody.

## Qualification and remaining gates

The backend and joined web proof tasks must run unfiltered in the required current-journal credential job, with nonempty JUnit artifacts. Each backend-only intermediate tree must contain only available tasks/configs/proofs. Frozen final-source receipts record actual case counts and independent replays.

The joined proof uses the installed NextAuth/JWT libraries, public route exports, strict private HTTP, the default qualified restricted credential factory, mounted production Yoga/token validation and primary PostgreSQL. Next ambient request I/O, adapter initialization, web content access and the physical admission connection have explicit fixture seams. Its injected local limiter fallback is not joined Redis evidence. A separate running synthetic Next server smoke is still distinct from real deployed ingress, browser/device execution or production coverage.

Historical issuer retirement, remaining forgot/adapter writers, role fences, collision cleanup, email-confirmed first-password behavior, partner authentication-clock provenance and accepted revoke-other-session policy remain open where not separately evidenced. This relocation cannot close those gates in [the migration](better-auth-migration.md) or [the rollout](better-auth-rollout.md).
