# Staged Expo browser consumers

This child of the WWW browser consumers adopts the same process-memory lease
factory in the Expo browser target. `publicExpoBrowserConsumersReady()` remains
literal `false`. An environment flag cannot activate it. Native credential
storage, native WebSocket recovery and Bluetooth are outside this change.

## Central session and local identity

The browser calls canonical WWW with credentials included. A successful central
session response establishes its public UID, SID, generation and binding/version
tuple. The host-only credential proof stays at WWW; Expo receives only a short
backend lease. Neither bearer nor browser cursor is sent through the existing
cross-tab channel or persisted in browser storage.

A changed UID, SID, generation, binding or version retires the old local network
generation before another result is published. Same-selection lease renewal
preserves that generation. Local `retire()` aborts pending lease work and removes
usable network credentials without asserting sign-out. Confirmed offline identity
is separate: an outage need not erase the account's local climbing data.

Once selected session metadata is observed, malformed metadata, a later legacy
response, missing proof or the readiness gate cannot restore legacy dispatch.
Only a successful actual anonymous central response permits an anonymous network
request. Unknown startup and a retired selected view refuse that request.

## HTTP completion

Each selected request retains its original opaque consumer scope and original
lease receipt. It checks them immediately before send, after headers and after
body decoding. Clones, explicit stream readers and split body streams retain the
same original receipt. A newer lease cannot make an expired older response usable.
Unqualified stream piping refuses until its destination has an ownership barrier.

A 401 for a still-live selected lease retires only that scope. The request is sent
once; this path never replays a mutation. A delayed older 401 cannot retire a newer
same-owner lease. Confirmed anonymous requests discard a supplied stale
Authorization header. The existing legacy revalidation path remains separate.

Callers still need a synchronous current-response check after their own awaits and
immediately before state or cache publication. A transport body check does not
qualify a React view, offline outbox, GraphQL client retained across account
changes, or a private prefetched page.

## WebSocket operations

The actual Expo browser facade uses the shared socket controller with a fixed
accepted owner, manager revision and local network generation. Each actual
socket retains its original issued lease; a newer same-owner handshake cannot
extend an older socket's sends, results or completion. An uncertain close leaves
the account intact. Confirmed refusal of an unexpired lease retires only its
original scope.

Operations default to a single send. Only an AST-verified selected subscription
may replay after a transport renewal. Mutation and ambiguous-document attempts
stop before a new socket can send them. The selected `iterate()` API refuses
before opening a socket because its separate buffered-result path remains
unqualified; applications currently use guarded `subscribe()` instead.

A confirmed rate-limit rejection may retry an intent on a replacement transport
for the exact same accepted view. The registered `getWsClient` captures that
intent once before its first attempt. A UID, SID, generation, binding/version,
manager revision, first selected observation or local-store generation change
refuses it before choosing another client. Registry replacement or cleanup cannot
rebind an in-flight intent. Unregistered native getters retain their existing
retry behavior. This metadata guard does not replace the original delivery
receipt or a caller's checks after its own awaits.

## Evidence and remaining gates

The initial store slice passed 50 tests, including 13 new selected cases, and an
independent replay of the same 50. The HTTP/body slice passed 66 tests: 18 selected
store/HTTP cases, 11 actual Response/stream cases and the existing 37 legacy cases.
The shared retirement API separately passed 81 tests in independent review.

The shared socket controller independently passed 42 installed-client cases and
15 pure controls. The extracted Expo factory passed 6 cases, and the actual
facade initially passed 23 cases in independent review. Additional rate-limit
intent controls cover the reproduced A-to-B retry and same-view replacement.
The final intent slice independently passed all 78 shared GraphQL tests and 28
actual facade, factory and legacy cases.

Author validation ran all 64 package typechecks without cache hits. The full
mobile run completed with 29,030 passing tests, two skipped tests and one
unchanged Metro-worker test blocked by sandbox child-process permissions. Its
exact three-case suite then passed outside the sandbox without a source change.

Local iOS and Android bundle checks both stopped because Metro could not see the
existing `expo-router/entry.js` through dependency symlinks outside this temporary
worktree's canonical watch folder. The browser bundle guard, run with the
existing nested runtime and its install dependency explicitly omitted, stopped
at the same boundary. No bundler configuration or watch folder was changed.
These attempts do not establish bundle acceptance: real CI native and browser
bundle checks under the normal workspace install remain required before readiness.

The first-read selected-503 legacy-cache gate remains open. An owned expected-red
store/HTTP composition sent a cached legacy A credential after an unseen server B
selection returned 503. A trusted selected-dispatch observation or a separately
qualified required-selected mode is needed before activation; a 503 must not be
treated as confirmed anonymous.

Per-client HTTP GraphQL scope, actual provider and cache publication, offline
ownership, real browser transport and the supported engine matrix remain
unqualified. This evidence does not open public bootstrap,
rolling proof-cookie publication or the consumer readiness gate. WWW private
SSR/RSC/prefetch and native credential handoff retain their separate gates.
