# Renewed historical web login ancestry

This change supports BA-04 (#6978), epic #6975, and the renewed-child gate in
#7430. All activation switches remain blocked by their existing startup guards.

A historical NextAuth cookie can have a rolling `jti` without a stable
`authSessionId`. The JWT callback may expose that copy's `jti` as its public SID,
but now also signs `legacy_no_sid: true`. Further renewal retains this marker;
a completed fresh sign-in clears it. An existing-actor OAuth callback is a
renewal: its trusted backend proof retains `requiresAccountCutoff: true`, and
the JWT callback inherits that provenance. Signed transfer serialization also
preserves it through the actual transfer verifier. None invents authentication age.

The backend verifier treats marked descendants as requiring account-wide
generation revocation. Their canonical session's `legacyLineageId` retains the
`credential:` prefix, so deleting an optional lineage row cannot turn unknown
ancestry into a stable login. Malformed provenance claims fail verification.

The private web sign-out handler supplies its selected projection and epoch.
Unknown-ancestry logout locks that projection before the user, then invokes the
existing transactional no-SID cutoff core. A stale epoch refuses the command
without changing the cutoff. A delayed logout from an already older generation
acknowledges completion without revoking a later authenticated login. Stable
SID logout continues to deny only that login and requires no projection or
deleted-email configuration after writer rollback.

## Bounded execution evidence

The existing disposable-database web credential proof now exercises the actual
installed NextAuth encoder and decoder, actual web JWT callback, local HTTP
sign-out handler, and PostgreSQL. It generates two historical rolling cookies
with different JTIs, bridges both raw copies and renewed children, and logs out
through a renewed child while further renewal/bridge calls run concurrently.
Both original copies, every renewed child, canonical aliases, and subsequent
rebridge attempts must be denied. The same assertions run with optional lineage
rows removed. A subsequent real backend password login uses the unchanged exact
password bytes; repeated old logout requests leave its cookie admitted.

Run the joined proof against an owned local PostgreSQL instance only:

```sh
AUTH_PROTOTYPE_DATABASE_URL='<localhost disposable database admin URL ending in /postgres>' \
  vp test run --config packages/web/auth-prototype/credential-proof.vite.config.ts \
  --maxWorkers=1 --reporter=agent
```

On 2026-11-13, this proof passed 11 tests. The callback suite passed 100 tests and
the cryptographic verifier suite passed 73 tests. The affected web authentication
suites passed 844 tests; four authority suites passed 44 tests and the native
review suite passed six. The shared protocol suites passed 142 tests.
Scoped `vp exec tsc --noEmit`
checks passed for web, backend, and the explicit web proof TypeScript project.

This is synthetic local evidence. It does not identify every historical issuer,
recover ancestry already discarded by older callback versions, qualify deployed
instances or browsers, or authorize production rollout. Existing BA-04 writer,
fence, rollback-floor, full rehearsal, and BA-05 browser gates remain in #7430.
The no-SID cutoff's selected-authority writer adoption is reviewed separately.

The optional ancestry field preserves acceptance of earlier proof shapes, but
older strict version-1 readers reject a proof containing the new field. Deploy
compatible proof readers before the backend emits marked proofs. The staged
modes remain off and activation guards remain enforced during that ordering.


## Mounted native callback continuation

The native callback route reconstructs its trusted web proof from the exact
admitted signed cookie. It now carries `legacy_no_sid: true` into
`requiresAccountCutoff: true` before the existing transfer serializer runs.
A renewed historical cookie may already have a SID; that does not remove its
unknown ancestry. Generation and authentication age still come from the signed
source, rather than the displayed session.

The joined PostgreSQL proof now executes this actual route before the actual
signed transfer parser, `native-oauth` authorize callback, JWT callback, cookie
encoder and mounted backend logout. Its request-context adapter reads the
fixture's exact cookie through the actual first-party admission reader; the
serializer and route are not replaced. Logging out through the transferred web
cookie must deny every historical raw/renewed alias, while the subsequent real
password login remains usable. The callback route suite includes a separate
signed no-SID ancestry regression.

This continuation concerns the route that creates a transferred web session.
The separate backend native exchange and native refresh/canonical lineage
boundaries require their own composed proof; it does not infer that historical
ancestry already lost by an older issuer can be reconstructed.
