# Recovery before authority enforcement

This backend family and its separate default reset consumer do not activate identity authority or adopt the default forgot-password issuer. Production adoption remains gated by the actual backend, profile, ingress, reader and historical-writer evidence. No deployment, role provisioning or production setting changes are part of this source change.

## Private backend boundary

The service-authenticated endpoints are `/api/internal/auth/current-store/recovery/v1/forgot-password` and `/api/internal/auth/current-store/recovery/v1/reset-password`. Both require protocol 2, matching path/operation, a fresh request ID and issuance clock, a present unknown payload, and strict envelopes. Browser Origin headers are refused. Only the authenticated web facade supplies a zone-vouched raw client address; payload fields and forwarded-prefix choices cannot supply that context.

These commands capture and revalidate an absent or prepared current-store context under the shared authority gate. Prepared reservations remain snapshots. An enforced or canonical transition refuses this family; it never manufactures a selected-authority receipt or performs an unreserved write. Existing explicitly staged recovery uses its separate qualified endpoint and selector.

The intended backend needs cutoff enforcement, SQL credential logging disabled, a distinct `CURRENT_STORE_AUTH_RPC_SECRET`, and the dedicated credential connection. Its exact `private-recovery-v1` profile extends the narrow `private-registration-evidence-v1` capability with SELECT and INSERT on `auth_pre_enforcement_password_reset_events`. It adds no UPDATE/DELETE on that ledger, direct partner revoker, or provider rights. The current users shape remains separately pinned; historical receipts do not silently accept this profile. Apply the canonical journal, including the generated `0352_auth_pre_enforcement_password_resets` migration and existing evidence prerequisites, before qualifying this profile.

The additive ledger records a committed reset's operation ID, UID, old/new generation, both revocation domains, captured context, and database clocks. It is distinct from the enforced-authority mutation ledger. The password write, receipt consumption, verification update under existing policy, current UID refresh-row revocation, cutoff advance, reset intent and command nonce commit together. Any transaction failure rolls them all back. Password-change evidence follows its explicit capture configuration; historical hash age is never inferred from imports or profile timestamps. This source transaction does not establish every deployed reader, old issuer or partner consumer has adopted revocation.

## Capabilities and legacy compatibility

The new UID-only path uses live JavaScript `trim().toLowerCase()` sole-holder eligibility checks, including stored space, NBSP and case variants, with normalized-key serialization and fresh known-lock rechecks. A stale prepared snapshot cannot make an ambiguous new UID group eligible. The legacy UUID path keeps its released SQL exact/LOWER candidate lookup and exact stored-address/creation-clock rule; the new UID cohort check is not historical UUID-owner evidence.

A `pr1_` receipt is bound to UID, purpose, generation, delivered address and its original deadline. The email hint in a submitted reset cannot choose the account. Revalidation after waits must use current database clocks and the immutable receipt; replay, supersession, deletion or binding drift cannot mint freshness or reassign a receipt.

Default public forgot still issues its existing UUID link and hashed email-keyed row. Its source is unchanged by the reset consumer revision. Legacy UUID consumption retains the web compatibility validation and exact stored-address/creation-clock rule. Today's UUID issuer uses a one-hour lifetime and the shared legacy helper allows 60 seconds of creation-clock tolerance; a recreated same-address account within that window is not proven to be the original owner. Those bounds do not inventory every historical issuer or its actual original deadline. That rule is not proof of immutable historical ownership: original-owner uncertainty, the existing creation-clock tolerance, outstanding original deadlines and historical formats remain rollout limits. A compatible legacy success is not cutover provenance. Do not replace the accepted retirement/provenance gates with a new operator attestation.

The private forgot endpoint can create UID receipts for authorized callers, but default public issuance is separate future work. New backend source does not make every public replica capable. Delivered UID issuance must wait for real evidence that all readers and their configured private backend are capable; an old reader returning unavailable is a retryable outage, not a successful delivery rollout.

## Bounded work and uncertainty

Forgot and reset have independent five-per-client minute policies and independent 180-attempt unattributed fallback windows. Only zone-vouched metadata selects the per-client path. Redis command capacity stays occupied through actual settlement after its bounded caller deadline; bounded local/process fallback is not a distributed-limit guarantee. Actual admission source chooses its separate operation/work gate.

The command retains its active work slot through real pool, SQL and bcrypt settlement, even if the response times out or the caller disappears. The command deadline is seven seconds; transaction/statement limits use at most five seconds or the remaining budget. Reset comparisons/hashing and final state checks remain inside the command's custody. An uncertain acknowledgement returns unavailable and never triggers automatic mutation retry or cached success.

## Deployment and rollback

1. Deploy and qualify the backend, canonical journal and intended `private-recovery-v1` LOGIN first. Preserve the separately qualified staged mode for enforced/canonical stores.
2. Adopt the dependent reset consumer only after its backend origin, distinct RPC secret, compatible keys/profile and actual ingress are evidenced. This revision requires the private service even with `CURRENT_STORE_WEB_AUTH_MODE=legacy`.
3. Keep default UUID forgot issuance unchanged until the later issuer adoption has its own all-reader, mail-origin and configuration evidence. Do not infer that coverage from source tests or deploy readers and issuers simultaneously as its substitute.

Keep capable consumers and the qualifying backend available through actual outstanding capability deadlines, including when issuance stops. Returning to a release that owns password SQL restores an unfenced writer. Mode flags alone are not a mutation-safe rollback protocol. Historical deployment/rollback issuer retirement, remaining forgot/set-password/adapter writers, role fences, collision cleanup, provenance and every required revocation reader remain separate gates in [the rollout](better-auth-rollout.md) and [#7430](https://github.com/boardsesh/boardsesh/issues/7430).

Existing recovery telemetry/referrer/cache controls and the measured framework/early-redirect counterexamples in [the staged recovery contract](better-auth-password-recovery.md) remain in force. Route-export tests cannot prove deployed ingress privacy or a full browser/device run.

## Backend qualification

`vp run test:recovery-backend` selects the complete restricted-LOGIN PostgreSQL/HTTP proof and operation-limit suite, serially and without task caching. CI runs it after the existing current-journal credential proofs and requires its nonempty JUnit artifact in the required credential-writer job. This describes required wiring, not an assertion that a particular commit passed. Case counts and independent replay receipts must come from the frozen final source.

## Dependent web boundary

The backend-only intermediate revision does not change default public reset/forgot adapters and does not contain a recovery-web proof task. The later consumer revision must delegate UUID and `pr1_` reset without web SQL/fallback, retain the public status/floor/privacy contracts, and leave UUID forgot issuance unchanged. Its actual public-to-private joined proof and mandatory CI artifact belong in that dependent tree. Issuer adoption remains a further separate rollout boundary.

## Qualification seams

The separate dependent joined web proof is specified to use actual public route exports, the real NextAuth/JWT library, strict private HTTP, the qualified restricted credential LOGIN and primary PostgreSQL. Next's ambient request I/O, the NextAuth adapter stand-in, web content-DB access and the physical admission-pool connection are bound to the owned fixture. The SMTP side effect is captured offline; it does not execute real email delivery. Credential/admission decisions and the mounted production Yoga/token validator remain real.

The joined proof explicitly injects bounded local limiter fallback (`redis: () => null`). It does not exercise joined Redis I/O. Existing shared limiter Redis/fault regressions are separate evidence. The dependent web commit must add its whole configured task and nonempty JUnit artifact against isolated PostgreSQL; this backend-only tree adds only the backend task, and an unused Redis service would establish no additional coverage. These seams do not prove a complete Next server, browser/device execution or deployed ingress.

## Source delivery plan

The explicit prerequisite integration ref is `codex/epic-6975-recovery-reset-integration`. Keep its prerequisite-only history reviewable and retain the ref. The implementation is delivered as two authored commits above that prerequisite base: backend/profile/migration and backend proof/CI first; dependent reset consumer and joined web proof/CI second. Each actual intermediate tree must include only its available task/config/proof files and pass its own required checks.

After the owner has merged #8160, #8166, #8167 and #8161, rebase only those authored feature commits onto current main and retarget the same pull request to main. Do not replay prerequisite integration commits as feature work, delete the integration ref, merge dependencies automatically or deploy anything as part of this source-only delivery. Record source/range equivalence for any prerequisite-only parent advance and retain the separate backend-first deployment gates above.
