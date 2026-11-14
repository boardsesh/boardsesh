# Anonymous provider transaction

This is the private backend transaction for a **positively observed anonymous browser binding**. It accepts Google and Apple. It does not accept a nullable signed-in actor, Facebook, a caller-selected user ID, or a fallback from a refused selected browser. The signed-in provider-security protocol remains unchanged.

The namespace is `/api/internal/auth/anonymous-provider/v1`. It uses the existing private provider service authentication, `private-provider-v1` qualified database pool, primary authority receipt, request freshness window, strict schemas, and byte limits. It returns JSON only, never cookies. Its public browser consumer is still a separate implementation task; adding this namespace does not enable public provider sign-in.

## Transaction stages

1. `intent` requires the exact unselected binding token and version. It creates a source-free browser login intent and a provider flow with all actor columns NULL. The flow digest binds the provider, credential kind, OAuth state/nonce digests, exact binding and absolute expiry, browser intent, and authority projection/normalizer/epoch.
2. `prepare` takes the provider-subject, target-user, and normalized-email locks before the binding. It plans identity resolution without writing users, provider rows, reservations, mirrors, or sessions. It then requires the binding still to be anonymous. A durable preparation digest binds the complete verified profile, identity plan, backend-generated SID and UID, generation, authentication age, credential expiry, and proposed canonical-token digest. The deadline includes the whole-second credential expiry, so a short binding cannot produce an already-expired credential.
3. `finalize` revalidates the current identity plan and exact durable preparation, validates the actual caller-held credential, applies the identity plan and optional mirror writes, inserts a canonical session when applicable, commits browser login, and consumes preparation in one physical SQL transaction. A final database-clock fence runs after all writes; any refusal rolls back identity, mirrors, credential, browser, and intent changes together.
4. A repeated `finalize` only acknowledges the exact committed browser version and caller-held credential. It requires the same current owner, SID, generation, preparation, and consumed login intent. It performs no credential recovery, session creation, or cookie publication. `abort` cancels a pending source-free login intent even when the prepare response was lost. A caller must never use abort or a new credential to resolve an uncertain finalizer outcome.

The flow and preparation tokens have separate hash domains from signed-in flows and from each other. The private boundary copies and validates complete inputs before awaiting I/O. Ordinary Google authentication does not become fresh from callback time, token issue time, or token refresh: only the owned Google assertion verifier can establish recent `auth_time`. Apple and Google assertions without qualifying evidence retain unknown age. Provider email never silently links another user's account.

## Lock ordering

The anonymous reader locks the binding and refuses any selected owner without discovering and locking that owner's user row. The acknowledgement reader locks only the already planned expected owner before the binding. This matters when another browser operation selected user C while provider planning already holds user B: a refusal must not try to acquire C after B and the binding. The tests park a real C user-row lock to check both paths.

The existing general selected-browser readers remain intact. The new helpers are limited to the source-free path.

## Evidence and remaining work

Author verification covers both identity authorities, Google and Apple, new and returning subjects, legacy JWE and canonical credentials, read-only prepare/acknowledgement, normalized-email races, changed selection, durable preparation forgery, unknown authentication age, actual late-write rollback, database-clock expiry after browser CAS, and held unexpected-user locks. Transport cases cover default-off behavior and refusals before database acquisition. The HTTP proof uses the real qualified `boardsesh_identity_writer` LOGIN against the restricted profile 3, 4, and 5 fixtures with identity mirroring enabled, including a real denied INSERT that rolls back the whole command. That HTTP proof supplies already web-verified provider profile input; it does not claim an end-to-end public OAuth exchange.

No migration, production grant, feature activation, email configuration, or live account mutation belongs to this change. Remaining implementation includes the private web command client, sealed anonymous browser flow, actual installed NextAuth issuer and outer route join, canonical browser bootstrap/session consumers, and public caller wiring. The existing rollout gates remain false until the joined paths pass their browser, device, restricted-role, freshness, and failure-ordering qualification. Track rollout and those outstanding gates in #7430.
