# Browser password publication

Ordinary WWW password sign-in joins the existing backend-owned browser selection. The public password readiness function remains false. This implementation does not enable a rollout, alter native/watch compatibility endpoints, or introduce Facebook sign-in.

## Physical response sequence

1. The canonical browser client acquires the existing origin-wide network lock and first attempts read-only recovery from observed encrypted password custody cookies. This precedes coordinator preflight: a completed selection whose response was lost may have a live binding but no delivered current proof. Recovery cannot prepare, compare, encode, finalize, refresh deadlines, or invent a candidate.
2. After releasing that lock, metadata-only frame preflight establishes a public cursor. The client reacquires the same lock, directly observes the pinned cursor, fetches NextAuth CSRF, and submits the password form only to canonical WWW. Passwords and credentials never enter coordinator messages.
3. The prepare endpoint reserves the existing per-client password budget before framework/password work. The actual installed NextAuth CredentialsProvider invokes private prepare once; its real JWT callback, encoder, awaited event, response decorators, bounded body settlement and repeated source admission finish before the first response. Actual accepted comparison returns the limiter budget, including a correct but unverified password. Wrong and unverified outcomes preserve the framework destination contract.
4. That first response contains only operation-bound, origin-bound encrypted custody cookies. They carry the exact unpublished credential bytes, original actual source, fixed preparation/capabilities and finished framework destination. No password is retained. Pending NextAuth session cookies never reach the browser, and no credential is finalized yet.
5. Commit requires that observed custody and the original live physical source proof. It builds and budgets the complete target response before exactly one private finalizer. After durable completion it performs an actual primary read with the exact projected target credential, awaits that read, then performs a separate final read-only completion ACK. Failure or uncertainty returns no auth cookies and never retries the finalizer.
6. Confirm requires the actual delivered current proof and exact durable ACK. Its prebuilt response clears only the complete observed custody family and returns the finished destination. The client releases the physical network lock before navigating.

## Recovery and clocks

A lost commit response leaves the candidate in the first response's encrypted custody. The next explicit password action scans a bounded number of operation families, using ACK before any ordinary source observation. Pending or denied operations do not block scanning a separate completed operation. Only an exact durable completion whose candidate is still the actual current selection can publish. The target primary read settles before a final independent ACK. An authenticated expired envelope permits only clearing that observed family.

Preparation is bounded by the backend's fixed deadline (at most 60 seconds). Recovery has the original prepared-at plus five-minute deadline. Normal credential expiry is 30 days from the actual password comparison's epoch-second policy; encoding and recovery never reset `auth_time`, expiry or binding expiry. Old-source expiry does not defeat an exact completed ACK within that fixed window. Live selected bindings with missing source proof remain refused for new preparation; custody and metadata are not anonymous admission.

## Boundaries and capacity

All four utility endpoints require canonical HTTPS Host and same-origin POST, strict bounded UTF-8 bodies, no content encoding, and bounded cookie names/count/bytes. They return private `no-store` and `noindex, follow`. The complete incoming cookie header, retained old proof families, unrelated operations and all response writes count toward existing cookie/header limits. A capacity refusal precedes finalization. Custody and unpublished cookie families are redacted by the shared text-redaction package.

The generic selected NextAuth credentials route cannot fall back to a naked legacy writer. The wholly legacy path still uses its existing handler when public gates are false and browser binding mode is legacy. Provider sign-in retains its separate existing response-loss policy. Public metadata never selects credential kind, UID, generation or authority; the service chooses kind from actual source possession, or its trusted anonymous policy.

## Evidence limits

Protocol/unit tests, actual installed NextAuth Request adapters, cookie-jar composition and held-body/event tests establish the source and HTTP sequencing contracts. They do not establish supported-browser behavior, production configuration, or a production rollout. Private transaction/qualification proofs are owned by the backend change. Actual browser acceptance and rollout tracking remain in issue 7430.
