# Provider Settings Google reauthentication

This request-local web seam obtains operation-bound reauthentication evidence
without creating or renewing a login. It is unmounted and its default public
readiness remains false. Environment and HTTP assertions cannot enable it.

The existing scoped NextAuth OAuth transport verifies actual state, PKCE and
nonce. The initiating server binds the generated state hash and authorization
nonce hash to the durable provider intent. The callback sends the actual signed
Google ID token to the private backend. The installed verifier checks signature,
issuer, audience and nonce; the durable command locks and rechecks that this
Google subject already belongs to the current actor and selected generation.
Only a supported signed `auth_time` within five minutes qualifies. Missing or old
authentication time, a foreign subject, callback completion time, token issue
time, `prompt` or `max_age` cannot supply freshness.

The signIn callback returns the exact configured localized Settings URL as a
string. Installed NextAuth exits before account mutation, JWT/session encoding
and signIn events. A read-only request-local adapter refuses every write. The
original requesting credential, source kind, SID, generation, authentication age,
expiry and browser selection remain unchanged; the evidence authorizes only its
bound future operation.

The outer request composition must surround scoped flow cleanup, selected-source
response admission and partner rewriting. It quarantines the delegated response,
requires the trusted response-identity admission acknowledgment, captures final
headers and status before asynchronous body work, buffers the complete response,
checks the final state/nonce or exact Settings destination, then re-admits actual
source cookies against primary. Protected credential/correlation/other-operation
cookie writes refuse publication. Only the encrypted operation cookie is emitted,
with its existing absolute deadline and conservative whole observed-header budget.
The old source and operation material are retained.

The required isolated auth-web proof uses actual installed NextAuth, owned HTTPS
Google discovery/token/JWKS transport, real provider signatures, actual private
HTTP handlers and disposable PostgreSQL. It covers both selected authorities and
both credential kinds; missing/old auth_time, unknown and foreign-owned subjects,
wrong state/nonce/PKCE, late header/destination/body failures, missing admission
acknowledgment and primary uncertainty. A retained-response mutation during held
body work cannot change the captured headers or redirect.

This does not qualify public Settings/card mounting, real Google console/security
bundle configuration, external TLS/proxy behavior, the full browser matrix,
restricted-LOGIN BFF composition or Apple freshness. Apple-only first-password
confirmation is separately purpose-bound; creating a password or confirming mail
does not itself supply provider freshness. The user must actually compare the
new password afterward. Rollout and remaining acceptance stay in #7430.
