# Qualified provider OAuth composition

The production NextAuth GET/POST route now joins the backend-owned Google and Apple flows. Its code-owned public readiness remains false. Environment variables, form fields, an old session cookie, or a missing/refused primary browser proof cannot activate this path or select a fallback identity writer. Facebook starts and callbacks remain blocked; stored identities and existing sessions are retained.

## Selection and ownership

The request-local outer composition distinguishes explicit Settings link/Google reauthentication, ordinary sign-in from an admitted owner A, and ordinary sign-in from a positively anonymous binding. It captures actual request headers and issuer hooks before asynchronous work. Provider state/PKCE/nonce and callback cookies stay scoped to the real installed NextAuth flow. The private intent is created only after NextAuth has accepted CSRF and emitted an actual authorization state.

Anonymous starts have a distinct sealed carrier and private protocol. They issue a backend-created canonical token by code-owned policy; no HTTP field or environment chooses the credential kind. The backend fixes new or returning UID, SID, generation, public metadata, age and expiry before any credential is prepared. The NextAuth adapter is readonly, so framework account/email heuristics cannot create or attach an identity. Ordinary owned-A sign-in preserves A's actual credential kind; a provider already owned by A returns a string before the encoder or sign-in event and preserves A's exact proof.

Explicit links use the existing account-bound reauthentication and atomic credential rotation. Google reauthentication exits NextAuth with a string, emits no credential, and depends on the backend's verified owned `auth_time`. Requesting a fresh Google challenge does not itself establish freshness. Apple, callback time, token issue time and token refresh never establish fresh age.

The fixed configured HTTPS origin and exact canonical Host authorize the route. An internal proxy URL is rebuilt from that fixed origin while retaining the captured path, query, method, body, headers and signal; forwarded headers never choose the authority. A partial rollback or retained selected/provider cookie refuses before legacy framework or identity work. A genuinely legacy request with no selected material retains its original path.

Raw Apple POST callbacks normalize to the existing signed, bounded WWW GET continuation before any selected-owner admission or provider-code exchange. The resumed GET must present actual Lax source/operation cookies. Transport normalization never supplies a missing account or authorizes anonymous fallback.

## Publication order

The publisher encloses the actual public framework hooks, scoped flow and Apple continuation clears, response admission, and partner/Expo decorators. Its pending session family cannot become the incoming authenticated actor. It quarantines all framework credential output, acknowledges the exact finished response, copies headers privately, buffers the complete body, builds the sealed preparation carrier and versioned proof-cookie plan, and checks whole-header capacity before the final backend transaction.

Capacity retains observed cookies whose original Path/Domain is unknown. An apparent clear at another scope cannot make a response fit. The private header copy also prevents a retaining decorator from injecting a proof cookie while the body is read. No issuer, response construction, automatic retry or abort runs after an uncertain finalizer. A known successful result returns only the prebuilt response whose exact candidate digest and resulting browser cursor the backend acknowledged.

## Actual next-request acknowledgement

The canonical observer and the strict WWW POST `/api/internal/auth/provider-signin/acknowledge` locate ordinary carriers on the server. The POST accepts only `{}`. No flow selector, UID, proof or bearer crosses a client/coordinator control message. At most four observed ordinary carriers are accepted; completed or unrelated retained carriers still count until a separately qualified cleanup planner exists.

An anonymous-flow ACK requires the exact actual currently selected B proof cookie, sealed preparation and primary B session. An owned-A flow also requires the actual retained old A proof. The private command must return `recovered`, followed by a fresh matching primary observation. A missing/different credential, ambiguous carrier, changed selection, expired receipt, unexpected `committed` response or uncertainty cannot be acknowledged. No credential is reconstructed, no backend session is created, and no cookie is written or cleared by ACK.

Canonical `observe` joins ACK only after an actual admitted B read, then repeats the full source frame before returning metadata. A positively anonymous observation never ACKs B. Refusal/unavailability remains conflict/unavailability; it does not become an anonymous result or an authenticated Session. The independent primary session response still supplies identity.

## Canonical start consumer

The native/Expo WWW start page receives its canonical origin from the server. Once both public source gates qualify, it completes canonical frame preflight **before** acquiring the parent WWW lock, avoiding nested-frame lock deadlock. It holds the canonical Web Lock through exact ACK, optional native attribution, CSRF and provider-start fetch/body settlement, and navigates to the validated Google/Apple authorization URL only after the lock releases. Abort does not release a pending fetch/body before its physical settlement. Missing locks, partial gates or transport refusal have no legacy fallback.

The shared WWW sign-in wrapper joins the same transport for the social buttons, partner sign-in, and explicit Settings OAuth. Its origin comes from the active SessionProvider's static server prop, with scoped registration and refusal on absent or conflicting authorities. It accepts only the fixed ordinary/explicit form fields and carries a captured Settings lifetime signal through pending network settlement. A selected provider start does not trigger a separate uncoordinated NextAuth session fetch afterward. Existing credential calls and the legacy fetch lock retain their contracts; password/rolling-writer coordination remains a separate qualification requirement. Social/native error surfaces reuse existing localized copy and never retry a failed operation automatically.

## Evidence and open gates

Installed NextAuth proofs exercise the actual production route, owned TLS provider transports, actual callback/encoder/event behavior, Apple POST normalization, original-owner admission, actual emitted versioned proof cookies, the public ACK client/endpoint, and canonical observer consumption. The private command boundary is mocked in those framework proofs. Its backend transaction and restricted LOGIN were qualified separately on both authorities and providers, both credential kinds, mirroring enabled, profiles 3/4/5, late rollback, durable preparation forgery, exact replay and lock-order controls. Neither layer claims a joined browser-plus-real-database qualification.

The public gates remain false. Remaining acceptance includes supported browsers and real devices, two authenticated bindings, full public/private HTTP composition, canonical producer/renewal coordination, bounded old-cookie cleanup, attribution where applicable, complete writer/issuer retirement, live role/pool qualification, and production rollout/rollback in #7430. Adding this source does not activate production OAuth or close epic #6975.
