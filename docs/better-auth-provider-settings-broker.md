# Provider Settings browser broker

The Settings broker is a server-only factory for reading selected sign-in
methods, recording an explicit Google/Apple link or unlink intent, and
submitting the account's actual password for an operation-bound reauthentication
receipt. Its public readiness function remains false. No public route, Settings
card, OAuth callback or credential publisher uses this factory yet.

Each request requires an exact Host matching the configured canonical HTTPS
origin. The standalone server's internal request URL supplies only the route
path; forwarded host and protocol claims supply no authority. Mutation requests also require
the exact Origin header, JSON content type, and a same-origin Fetch Metadata
value when supplied. Body reads have a fixed 64 KiB UTF-8 budget and a five-second
deadline. Neither HTTP input nor environment readiness claims select a larger
budget or enable the public flow. Actual external TLS and proxy behavior remain
a deployment and browser qualification gate.

Only `readPresentedBrowserSelection` supplies an actor. An unavailable primary
remains unavailable; missing, refused or stale possession cannot fall back to a
legacy cookie. The methods response contains usable methods and an opaque UI
actor key, with no UID, SID, source credential, private cursor or authentication
age. That key cancels stale UI work; it never authenticates a command.

The server checks the expected UI actor before creating an intent or comparing
a password. A per-operation `__Host-` cookie seals the intent capabilities,
original source hash and provenance, browser binding/version and deadlines.
Only its digest selector reaches public JSON. The cookie is HttpOnly, Secure,
SameSite=Lax and expires at the original intent deadline. A subsequent request
must present the actual current browser proof and match every sealed actor
binding before a private command runs. The server re-reads the primary after
private work and withholds the operation cookie if the actor changes, the source
expires, the primary becomes unavailable or the request aborts.

Intent creation and password comparison use the existing process-local limiter,
keyed only by the primary-admitted account. The limits are ten intents and five
password attempts per minute. This is best-effort protection per web process,
not a distributed quota. Proxy addresses cannot lock unrelated accounts out.
The browser may keep at most four operation cookies for this broker.

The broker stores only the returned encrypted reauthentication capability. It
does not retain a password, expose proof capabilities in JSON, change the
requesting session's original age or expiry, create a credential, or finalize a
provider mutation. Its injected-client tests qualify this HTTP and sealed-flow
boundary; they do not replace the existing real bcrypt/Postgres proofs.

Public route and card wiring, actual Google reauthentication, complete buffered
OAuth/unlink publication, ordinary owned-account sign-in, browser transport and
lost-reply recovery remain separate joined acceptance work. The
[provider-security adoption record](./better-auth-provider-security-adoption.md)
and rollout issue [#7430](https://github.com/boardsesh/boardsesh/issues/7430)
retain those activation gates. Apple-only first-password email setup is a
separate purpose-bound flow; its email confirmation is never provider freshness.
