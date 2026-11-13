# Selected-authority provider sign-in writers

This staged BA-04 change supports epic #6975. Rollout, remaining writers and
owner prerequisites stay in #7430. It does not activate a mode or switch the
production identity authority.

Web OAuth intent/resolve commands and staged native provider sign-in capture
the selected authority from the enforced projection for each command. Native
captures it before remote provider verification. The write transaction checks
the same receipt, including its epoch, rather than pinning the process to an
old configured epoch. Web command fields are copied before receipt acquisition
can yield, so caller reuse cannot replace an actor, subject or request binding.

The shared provider resolver uses the bound primary identity implementation
for provider ownership, user creation and provider insertion. A returning
subject retains its owner even when Apple omits email. It locks the user and
cutoff, then locks and rereads the selected provider row before accepting the
original owner and generation. The second read waits for uncommitted unfenced
ownership changes; a nonlocking MVCC read cannot provide this guarantee.
Deleted-account ownership remains visible for denial, never as permission to
create a replacement account.

Existing reservation and negative-actor policies remain: an unknown subject
with a browser actor needs the separate sensitive-link implementation; a taken
address conflicts; returning names, addresses and verification timestamps are
preserved. New web users keep provider images and remain unverified; native
creation retains its existing name and provider-verification rules.

Canonical selection writes through the Better Auth adapter and reverse mirrors
within that same transaction, including with forward mirroring disabled.
Current-store selection retains its gated forward mirror. Mirror failures and
conflicting rollback-store provider owners abort the command. Native token
issuance remains inside the identity transaction. The legacy native OAuth
writer also takes the authority gate and refuses canonical selection before
looking up a user or issuing credentials.

The disposable PostgreSQL/HTTP suite covers both authorities and both callers,
RS256 provider verification with only JWKS transport replaced, no-email returns,
owner and generation races, actual provider-row lock waits, mirror rollback,
legacy-route refusal and command-input capture. The existing native/web OAuth
suites retain their ownership, reservation and deadline controls. These are
synthetic source proofs; real providers, devices, deployed roles and complete
switch/rollback rehearsals remain separate gates. Explicit fresh-authenticated
provider link/unlink and other unadopted writers remain incomplete.
