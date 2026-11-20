# Mobile authentication screens

`packages/mobile/app/auth/` contains separate login, registration, password recovery,
password reset, and session-unavailable routes. `auth-provider.tsx` owns credential
state and post-login navigation; the login screen does not race it with a second
redirect.

Login offers enabled OAuth providers and an email/password form. Email is trimmed
and validated before submission. OAuth errors have their own region below the
provider buttons; form failures remain beside the form. Disable repeated submits
while a request is pending. Registration preserves a validated browser `next=`
return so signing up instead of signing in still returns to the intended climb.

Native and browser credential storage and OAuth transport differ. Read
[mobile auth flow](../../auth/mobile-auth-flow.md) before changing those paths and
[the browser session contract](../../auth/better-auth-browser-session.md) before changing
browser cookies, refresh behavior, or account switching. Migration notes do not
imply a production authority switch has been activated.

The Next.js website keeps its own authentication entry points. The retired web
login overlay is not the native screen specification.
