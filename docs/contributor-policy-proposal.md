# Proposal: contributor policy for the AGPL core

**Status: proposal for review. Not in force.** Nothing in this document grants,
assigns or asserts any right. It lists the decisions the maintainer needs to
make, with the trade-offs, so that a policy can be adopted deliberately rather
than assumed.

## Why a decision is needed now

`LICENSING.md` moved the product core to AGPL-3.0-or-later and kept the
interoperability tier Apache-2.0. The audit behind that change found two
different situations inside the core:

- The Aura renderer packages were written entirely by one author, which is
  what made moving them possible without asking anyone.
- The applications, backend, database and several shared packages contain
  contributions from about twenty other people, received under Apache-2.0.
  Those contributions stay Apache-2.0 inside the AGPL combined work
  (`LICENSING.md`, "Contributions received under Apache-2.0"); the project
  cannot relicense them, offer them under commercial terms, or attach an
  additional permission to them without each author's agreement.

Every further outside pull request to the core extends the second situation:

- **Relicensing again needs consent.** The maintainer can move solely-authored code between licences at will. Each later change of licence for code with a second author needs that author's agreement, or their code removed.
- **Commercial licensing is limited to the parts the maintainer owns.** `LICENSING.md` says separate commercial licensing could be available. The maintainer can only offer that for code they hold the rights to. Contributed code arrives under the AGPL only, unless the contributor grants more.
- **App Store distribution starts depending on outside rights.** A copyright holder can distribute their own AGPL code through the App Store on whatever terms they like. Code contributed under the AGPL alone comes with the AGPL's conditions, and the Free Software Foundation's position is that Apple's terms cannot satisfy them. The preferred long-term fix is a public, lawyer-reviewed additional permission under AGPL section 7 that lets everyone, forks included, distribute through app stores while keeping the source obligation. Until such a permission exists and covers contributed code, Boardsesh's own store release rests on each core contributor's tolerance rather than on a licence.

The repository currently has **no CLA and no DCO**; `CONTRIBUTING.md` states
only that a contribution is accepted under the licence of the directory it
changes. Inbound rights rest on GitHub's default terms (contributions are
licensed under the repository licence). That is enough to keep shipping under
the AGPL. It is not enough for any of the three points above, and the
contributions already received under Apache-2.0 are not covered by any
instrument at all.

## Options

### Option A: DCO sign-off, inbound = outbound

Every commit carries `Signed-off-by:` and the repository adopts the Developer
Certificate of Origin. Contributions to a covered directory are licensed
AGPL-3.0-or-later, the same as the files they change.

- Cheapest to adopt: one line in `CONTRIBUTING.md`, a CI check on the trailer, no signing ceremony.
- Documents that the contributor had the right to contribute.
- Does **not** let the maintainer relicense or commercially license contributed code, and does not address the App Store point.

### Option B: DCO for the repository, plus a contributor licence grant for the AGPL core

Same as A everywhere, but a pull request that touches the AGPL core also
requires the contributor to have agreed, once, to a written licence grant that
lets the project distribute their contribution under additional licences
(the pattern used by projects that dual-license a component).

- Keeps the friction out of the Apache-2.0 interoperability packages, where permissive inbound = outbound is all that is needed.
- Preserves the ability to offer commercial terms, to adopt an app-store additional permission, and to distribute through app stores without depending on every contributor.
- Needs a real legal instrument. Do not draft it in-house; existing templates exist (for example the Apache Individual and Corporate CLAs, or a copyright licence agreement rather than an assignment) and counsel should pick and adapt one.
- Needs a place to record agreement (a bot such as the CLA Assistant GitHub app, or a signed-agreements file in the repository).

### Option C: copyright assignment for the core

Contributors assign copyright to the maintainer (or to a legal entity that
does not yet exist). Strongest control; also the option most contributors
decline, and it requires an entity to assign to.

## Recommendation for review

Adopt **Option A now** for the whole repository (it is low cost and improves
provenance everywhere), and decide on **Option B** for the AGPL core before
merging further outside contributions to it. Until that decision is made,
core pull requests from outside authors should be held rather than merged, so
that the questions above do not get harder to answer. The Aura renderer
packages are still single-author; keeping them that way until Option B is
decided keeps the licence choice for the flagship component clean.

Separately, and regardless of the option chosen: the contributions already in
the tree under Apache-2.0 stay Apache-2.0. Reaching out to those contributors
for a grant is a courtesy request, not something the project can require.

## Decisions the maintainer has to make

1. Whether Boardsesh will ever offer the core, or the renderer, under terms other than the AGPL, including an app-store additional permission. If not, Option A is sufficient and this document can be closed.
2. Whether a legal entity should hold the core copyright. Boardsesh is currently a sole-trader trading name, which is not a separate legal person; a grant to the individual trading as Boardsesh is workable, and a grant to a company would be easier to transfer if one is formed later.
3. Which instrument, chosen with counsel, and how agreement is recorded.
4. Whether the DCO applies to AI-assisted commits in the same way (the DCO's clauses are about the contributor's right to submit, which the contributor can certify regardless of tooling).

## What this document does not do

It does not change `CONTRIBUTING.md`, does not add a CI check, and does not
claim that any contributor has agreed to anything. Those follow once a decision
is made.
