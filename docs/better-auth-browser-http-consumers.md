# Staged browser GraphQL HTTP clients

The HTTP continuation composes the reviewed Expo consumer parent #7504 with
the CNC and private-view parent #7503. Both commit histories are retained; all
69 ending feature blobs matched their respective parents before extraction.
Public browser and Expo readiness remain code-owned false.

## Original delivery authority

`@boardsesh/auth-protocol/browser-backend-http` owns HTTP delivery admission
without depending on a GraphQL SDK. WWW keeps its existing `graphql-request`
error and parsed-header adapter. An exact actual response-header object refers
to its original issued lease and request abort signal. Successful decoding
registers only the original result object and at most 64 direct object-valued
fields. A copied result or copied headers cannot create a receipt.

Callers must check the original result synchronously after their own awaits
and immediately before state, cache or effect publication. A newer same-owner
lease cannot extend an older delivery. Local transport disposal refuses its
results while retaining the account's offline identity.

Cold clients capture the accepted account, manager revision and platform
generation at construction. Their first actual lease is acquired lazily through
the reviewed request authority. A different login, account switch or A-to-B-to-A
transition cannot initialize an old client with a newer account's credential.

## Confirmed refusal

The cold-view creator preserves Expo's selected 401 policy: only a confirmed
401 for the exact original, still-live lease and uncancelled request retires
that scope. It throws without retrying the operation. Expired, aborted, disposed,
superseded and changed-generation responses cannot invalidate a current scope.
The existing fixed-scope WWW creator retains its released error behavior.

Reachability reporting is separate from admission. Local view refusals and private
source-issuer errors supply no GraphQL reachability sample. A trusted diagnostic
observer runs only after an actual 401 passes the original lease and cancellation
checks; it records one reachable sample. Observer failure cannot change denial or
prevent scope retirement. The default/native reporting path leaves the optional
classification seam unset.

## Unmounted Expo SDK factory

The selected Expo HTTP factory uses the shared transport with the installed
`graphql-request` client. The existing native connectivity gate, malformed-body
classification, outcome reporting and 20-second interactive and 30-second
offline deadlines are extracted into one injected host helper. Native leaves
the new signal-composition option unset and keeps its existing client factories
and singleton behavior.

The browser factory composes the actual caller, local disposal and deadline
signals. Cancellation remains effective during real SDK decoding and after the
temporary inspection listener has been removed. Connectivity fails before a
cold credential request; the request deadline includes that acquisition.

This factory is not yet the public Expo HTTP facade or authentication hook.
It does not qualify existing callers, query persistence, offline outboxes or
their effects. The next host layer must expose an opaque view scope instead
of placing a backend bearer in a query key and must bind retained clients to
that original scope.

## Bounded evidence

Independent extraction review passed 12 shared cases and the unchanged 24
actual WWW SDK cases. The separate cold-view 401 change passed independent
20 HTTP plus 11 request-authority cases and the same 24 WWW cases. Scoped
shared and web typechecks and canonical formatting/lint passed.

The initial composed CNC baseline passed all 349 cases. An extraction replay
passed 348 of 349: an unchanged placement-editor drawing-drag assertion received
600 instead of 800. Its exact focused replay, together with the 24 actual WWW
cases, passed all 37 without source changes. These are distinct receipts; the
failed broad attempt is retained.

The initial unmounted Expo factory passed 14 actual SDK cases plus 192 existing
native transport, interceptor and offline cases. Those assertions omitted the
reachability outcome. An independent copied-SDK probe then failed four decisive
controls: local B/ABA/generation refusals incorrectly reported backend failure,
and a real live 401 incorrectly reported failure instead of reachability. The
original 206 passing cases and the four failing controls are retained as distinct
evidence. The corrected host slice passed independent 210 actual SDK/native
cases, 32 shared HTTP/authority cases and the unchanged 24 WWW cases. The original
external 14-case fixture now passes all four prior failures too. The mobile
TypeScript task and canonical check pass. Native function/helper equivalence is
recorded with both optional host seams unset. The type task runs without install,
build or schema-generation dependencies. This approves the unmounted producer;
host facade, authentication-scope hook and consumer adoption remain next.

The first unseen-selected-503 legacy-cache interval remains open. Actual
application/browser history, UI and cache publication, supported engine behavior,
private SSR/Flight/prefetch, native handoff and complete public bootstrap and
rolling-cookie publication retain their separate qualification gates.
