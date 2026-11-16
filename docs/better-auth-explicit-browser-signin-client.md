# Explicit browser sign-in coordination

> **Superseded by #7596.** This describes the browser binding design, which is being removed. See [better-auth-browser-session.md](better-auth-browser-session.md). This file is deleted together with its code.

Ordinary Google and Apple sign-in uses the shared coordinator's dedicated
`signin` command. Read and renewal keep their existing binding checks. An
explicit sign-in can replace a confirmed expired binding through the canonical
server's prepare, commit and confirm endpoints; a metadata cursor never
authenticates the caller. The public readiness functions remain false.

The browser protocol sends only a hashed operation key and source/target
binding cursors. The target is a distinct binding at version zero. It carries no
credential, identity, preparation capability, authentication age or expiry.
Strict schemas reject additional fields. The canonical server retains actual
credentials and all authority checks.

The frame may connect through a proof-required or conflict read before this
explicit action. An unavailable read does not start recovery. One canonical
exclusive lock spans prepare, commit, confirm and final observation, including
the physical response bodies after abort or timeout. An uncertain commit is
never retried. A later explicit sign-in may prepare again; any recovery of an
earlier operation remains the server's read-only acknowledgement policy.

Every ready prepare, including recovered ready, still requires final primary
observation of the exact target. A mismatched commit, confirmation or observed
cursor refuses. Response metadata is bounded to 8192 UTF-8 bytes. Request
settlement order also fences delayed replies: an older ready response cannot
replace a later settled or cancelled command. Only explicit sign-in can adopt a
different binding; it cannot lower a version within the same binding.

WWW performs frame preflight before acquiring the same canonical lock itself.
It copies the returned cursor, reacquires that lock, and directly observes the
exact cursor before acknowledgement, intent creation, CSRF or provider start.
This closes the release/reacquire gap without a nested frame lock. The lock
remains held through the provider request's physical body settlement. Explicit
Settings link and reauthentication continue using read-only preflight.

Selected-mode password sign-in remains a separate writer gap. It refuses before
raw NextAuth credential dispatch when either selected readiness gate is active;
metadata preflight cannot authorize a legacy cookie writer. Legacy password
behavior remains available when both gates are inactive. This client slice does
not qualify password publication, Expo SDK sign-in, real-browser delivery or
public activation.

Tests use actual MessagePorts with injected Window, lock and fetch boundaries.
They cover phase-by-phase abort and timeout settlement, delayed reply ordering,
unknown-commit recovery, exact final observation and the WWW cursor pin across
lock reacquisition. These are transport and caller controls, not a mounted
supported-browser cookie-delivery acceptance result.
