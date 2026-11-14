# Provider identity planning

Selected anonymous provider login needs the backend to fix its target identity
before the web issuer buffers a credential and response. The immediate provider
resolver now shares its existing subject, user and normalized-email checks with
a read-only planner and an explicit transaction apply method. Existing native
and legacy web callers retain their immediate-write API.

Planning returns either the actual existing owner's generation and stored public
profile, a conflict, or a backend-generated new UID and fixed public metadata.
New-account creation time comes from the database clock. Provider email never
matches another account implicitly; returning provider profile claims never
rewrite the stored owner. Planning writes no user, provider, reservation,
membership, profile, session or identity mirror, even when mirroring is enabled.

Apply takes the same locks again and compares the complete planned public
identity against the current selected authority. A new account must still have
an unowned provider subject and unused normalized email. A returning owner must
retain the planned UID, generation and public metadata. Creation, reservation,
profile and both configured identity mirrors belong to the caller's physical
transaction, so a later credential or browser-selection failure rolls back all
of them. Verified inputs and nested plan metadata are copied before any await.

This is an internal identity seam. It does not authenticate an anonymous browser,
sign a claimed UID, issue a credential or expose a public endpoint. A future
anonymous command must bind the entire backend-issued plan, verified provider
input, exact positive anonymous binding/version/revision, authority and candidate
kind into its durable preparation. It must then compose apply with the exact
credential and browser-login CAS in one transaction. Existing signed-in actor
APIs remain strict. Public provider readiness and the remaining flow, restricted
LOGIN and browser/device gates stay open in
[#7430](https://github.com/boardsesh/boardsesh/issues/7430).
