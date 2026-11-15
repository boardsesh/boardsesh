# Explicit recovery from an expired browser binding

This private prerequisite is disabled by default. It does not enable public
recovery, admit an expired credential, sign out an account, or turn an uncertain
session read into anonymous state.

The dedicated `expired-browser-binding-v1` protocol has prepare, finalize and
read-only acknowledge commands. The internal adapter must start it only for an
explicit sign-in action. Ordinary coordinator polling and renewal never call it.
Settings and provider operations do not borrow this capability.

Prepare requires the actual old correlation token and database-confirmed expiry.
A supplied expected version must match. A fresh page may omit that version,
because generic readers deliberately refuse expired bindings. The backend still
freezes the actual full row, version, intent revision and authority epoch under
locks. The full-row digest uses PostgreSQL JSON in UTC, retaining timestamp
microseconds that JavaScript `Date` would discard. No selected user or session
metadata is returned as authentication evidence.

The backend generates a separate target token and operation token. The prepared
plan binds both actual token hashes, the full old state, nonce, authority tuple,
target cursor and all deadlines. Only hashes are stored in `verificationTokens`.
The namespace `ba03-expired-browser-binding-v1:` is distinct from email addresses,
`password-reset:`, ordinary `ba03-web-auth:` replay claims, and
`ba03-native-handoff-v1:` claims. Existing email/reset readers match exact
validated identifiers; neither existing prefix cleanup consumes this namespace.
The new bounded cleanup uses database UTC expiry and only its own prefix.

The preparation lasts at most 60 seconds. Its acknowledgement deadline is fixed
at preparation plus five minutes, and the target binding expires 30 days after
preparation. None of these deadlines extends on retries. Prepare writes only one
hash receipt. It does not insert the target or modify the old row.

Finalize takes the authority gate, observed old user lock when present, old
binding lock, and receipt lock, in that order. It rechecks exact old state and
actual old/new token possession. In one physical transaction it inserts an
anonymous target with version and intent revision zero, then changes the receipt
to its completed hash. Final database-clock and authority checks throw inside
that transaction on failure. The expired binding, users, credentials, cutoffs,
native sessions and partner sessions remain unchanged.

A repeated finalize refuses. After an uncertain physical response the adapter
may only acknowledge the original operation. ACK requires actual old and target
token possession, the exact completed receipt, unchanged old state/authority and
the exact still-anonymous target at version/revision zero. A login intent alone,
a later selected account, expired ACK deadline or changed target refuses without
writing. Missing durable completion cannot be replaced by a target that happens
to be independently anonymous.

The private handler authenticates its service caller, validates a fixed path,
strict body and command freshness, and rate limits before opening the qualified
credential pool. The canonical handler requests existing `private-provider-v1`
as its minimum compatible pool contract; actual LOGIN proofs cover profile three
and compatible profile six. Profile two's historical relation-shape contract
refuses the current canonical schema and is not weakened or claimed as qualified.
The existing capabilities suffice without schema, grant or production
configuration changes. Maintenance uses the same qualified credential connection
and can drain expired hashes while the feature mode is legacy. Retain a qualified
current-schema pool while draining; do not downgrade its contract on the
assumption that disabling this feature relaxes catalog qualification.

The staged public join uses three canonical POST routes under
`/api/internal/auth/browser-coordinator/signin`: prepare, commit and confirm.
They require an explicit sign-in action, the canonical coordinator lock and exact
Host/Origin/CSRF boundaries. Ordinary coordinator reads and renewal never invoke
this retirement or its recovery. Settings, linking and reauthentication continue
to use their existing read-only preflight.

Prepare validates the actually presented correlation cookie. An admitted live
selection is retained after a second exact primary observation. Otherwise only
the dedicated backend's database-confirmed expiry may prepare retirement. A
unique `__Host-boardsesh.expired-binding.<operation-key>` HttpOnly carrier uses
AES-GCM with a separate HKDF purpose and origin/operation associated data. It
holds the actual old and target tokens, private operation token and full frozen
preparation; browser-visible replies contain only strict control metadata. The
old correlation lease is refreshed to the same token before any finalizer. No
future target correlation or proof is published during preparation.

Commit requires the physical old correlation token to equal the sealed old
token. It buffers the complete target-cookie response, including all unrelated
observed cookies in capacity calculations, before one finalizer. The response
is published only after exact completion and read-only acknowledgement of the
still-anonymous version-zero target. A final acknowledgement after the target
read fences authority, old-row or target changes during that await. An unknown
physical outcome returns no cookie writes and retains actual recovery custody.
The next explicit prepare may acknowledge an existing operation and publish its
exact target; it never replays that operation's finalizer. An uncompleted old
operation is never reused: a later explicit action requires a fresh preparation.

Confirm requires the actual physical target correlation cookie, exact durable
completion and the unchanged anonymous version-zero target. It clears only that
operation's observed carrier names. Every unrelated operation and old proof is
retained. The canonical transport must settle each body, confirm installation
and perform a final exact primary observation before returning ready metadata.
The four-operation, whole-request pair/byte and response-header limits fail
closed; no capacity exception drops unrelated custody. Telemetry scrubs the
new carrier family in string, map, tuple and named-cookie representations.

Public readiness remains code-owned false. Full writer coordination, supported
browser response-order and device acceptance remain in #7430. A stale response
must never replace an unrelated current binding. A live selected binding with
missing proof still requires a distinct real-auth recovery policy; this
expired-only operation cannot authorize it. Generic expired admission,
automatic anonymous/legacy fallback and broad account revocation remain
unavailable.
