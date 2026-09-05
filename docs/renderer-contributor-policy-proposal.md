# Proposal: contributor policy for the AGPL renderer packages

**Status: proposal for review. Not in force.** Nothing in this document grants,
assigns or asserts any right. It lists the decisions the maintainer needs to
make, with the trade-offs, so that a policy can be adopted deliberately rather
than assumed.

## Why a decision is needed now

`docs/licensing.md` moved the Aura renderer packages to AGPL-3.0-or-later. The
audit behind that change found that every line in those packages was written
by one author, which is what made the change possible without asking anyone.
The first outside pull request to a covered directory changes that:

- **Relicensing again becomes impossible without consent.** Today the maintainer can move the renderer between licences at will. Once a second author's code is in, each later change of licence needs that author's agreement, or their code removed.
- **Commercial licensing becomes impossible for the contributed parts.** `docs/licensing.md` says separate commercial licensing may be available. The maintainer can only offer that for code they hold the rights to. Contributed code arrives under the AGPL only, unless the contributor grants more.
- **App Store distribution starts depending on outside rights.** A copyright holder can distribute their own AGPL code through the App Store on whatever terms they like. Code contributed under the AGPL alone comes with the AGPL's conditions, and the Free Software Foundation's position is that Apple's terms cannot satisfy them. Boardsesh's own store release would then rest on each renderer contributor's tolerance rather than on a licence.

The repository currently has **no CLA, no DCO, and no licensing clause in
`CONTRIBUTING.md`**. Inbound rights rest on GitHub's default terms
(contributions are licensed under the repository licence). That is enough to
keep shipping under the AGPL. It is not enough for any of the three points
above.

## Options

### Option A: DCO sign-off, inbound = outbound

Every commit carries `Signed-off-by:` and the repository adopts the Developer
Certificate of Origin. Contributions to a covered directory are licensed
AGPL-3.0-or-later, the same as the files they change.

- Cheapest to adopt: one line in `CONTRIBUTING.md`, a CI check on the trailer, no signing ceremony.
- Documents that the contributor had the right to contribute.
- Does **not** let the maintainer relicense or commercially license contributed code, and does not address the App Store point.

### Option B: DCO for the repository, plus a contributor licence grant for the renderer packages only

Same as A everywhere, but a pull request that touches a covered directory also
requires the contributor to have agreed, once, to a written licence grant that
lets the project distribute their contribution under additional licences
(the pattern used by projects that dual-license a component).

- Keeps the friction out of the ordinary Apache-2.0 packages.
- Preserves the ability to offer commercial terms and to distribute through app stores without depending on every contributor.
- Needs a real legal instrument. Do not draft it in-house; existing templates exist (for example the Apache Individual and Corporate CLAs, or a copyright licence agreement rather than an assignment) and counsel should pick and adapt one.
- Needs a place to record agreement (a bot such as the CLA Assistant GitHub app, or a signed-agreements file in the repository).

### Option C: copyright assignment for the renderer

Contributors assign copyright to the maintainer (or to a legal entity that
does not yet exist). Strongest control; also the option most contributors
decline, and it requires an entity to assign to.

## Recommendation for review

Adopt **Option A now** for the whole repository (it is low cost and improves
provenance everywhere), and decide on **Option B** for the covered directories
before merging the first outside renderer contribution. Until that decision is
made, renderer pull requests from outside authors should be held rather than
merged, so that the single-author state that makes the current licence choice
clean is not lost by accident.

## Decisions the maintainer has to make

1. Whether Boardsesh will ever offer the renderer under terms other than the AGPL. If not, Option A is sufficient and this document can be closed.
2. Whether a legal entity should hold the renderer copyright. A grant to an individual is workable; a grant to an entity is easier to transfer.
3. Which instrument, chosen with counsel, and how agreement is recorded.
4. Whether the DCO applies to AI-assisted commits in the same way (the DCO's clauses are about the contributor's right to submit, which the contributor can certify regardless of tooling).

## What this document does not do

It does not change `CONTRIBUTING.md`, does not add a CI check, and does not
claim that any contributor has agreed to anything. Those follow once a decision
is made.
