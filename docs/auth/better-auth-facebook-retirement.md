# Facebook product sign-in boundary

The owner-approved provider policy for epic #6975 supports Google, Apple, and
password sign-in. Facebook is excluded from new sign-in and linking. This is a
product policy change; it does not authorize removing stored identities, deleting
accounts, enabling the migration, or changing the identity authority.

## Product behavior

The web provider configuration, login buttons, and native browser-start page
expose Google and Apple only. Public Facebook sign-in and callback requests
return an uncached 404 before the OAuth delegate or identity RPC runs, and emit
no cookie. The legacy callback and completed-login JWT paths also refuse a
Facebook sign-in. Private web OAuth intent/resolve commands reject Facebook as
an invalid request before a nonce, intent, user, or account can be written.
Direct selected-writer helpers refuse the same unsupported provider.

Existing signed cookies continue through their normal renewal and admission
checks without gaining a new authentication time. Historical Facebook provider
subjects and stable user IDs remain stored, imported, mirrored, and displayed by
account readers. This change does not reassign a subject, match a Facebook email
to another account, or merge account data. Historical Better Auth prototype
capability proofs remain evidence of those tested versions, not active product
provider policy.

## Account access and support gate

A climber can keep using a valid existing session, an existing password, or a
Google/Apple method already linked to that same user ID. Password recovery keeps
its existing password-bearing-account requirement; it cannot establish a new
password for a signed-out Facebook-only account. The interface does not promise
that resetting a password or signing in with a matching Google/Apple email will
recover that account.

**A signed-out Facebook-only account has no qualified self-service recovery path
in this slice.** Owner/support handling for those accounts remains a rollout
gate. It requires an explicit account-ownership recovery decision; neither an
implicit email remap nor a new recovery policy is implemented here. Existing
sessions and linked data must remain intact while that gate is resolved.

## Evidence and limits

The bounded regression suite checks public GET/POST refusal without cookies,
private command rejection before persistence, direct-helper refusal before
storage access, disabled provider configuration despite leftover environment
credentials, stale client configuration hiding Facebook buttons, Google/Apple
controls, and exact renewal claims for an existing Facebook-issued cookie.
Stored-provider import and selected identity storage tests remain unchanged.

These are local tests with owned synthetic accounts and provider transport.
No production user data, provider registration, credential selector, rollout
mode, or deployment changes are part of this slice. Public provider linking and
reauthentication remain separate Google/Apple work.
