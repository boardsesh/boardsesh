// The one place that knows how a pull-request number and an xprem OTA branch
// name map onto each other. `.github/workflows/mobile-ota-preview.yml` publishes
// each PR's JS bundle to a channel-scoped branch called `pr-<number>`, so every
// branch the update server offers is either one of those or something else
// entirely (a hand-published experiment, a release branch) that the QA flow
// must ignore rather than guess at.

// Anchored, and no leading zeros: `pr-04792` is not a branch our workflow ever
// publishes, and accepting it would file a verdict against a PR number the
// string didn't actually name.
const PR_BRANCH_PATTERN = /^pr-([1-9]\d*)$/;

/** The PR number in a `pr-<number>` branch name, or null for anything else. */
export function parsePrBranch(name: string | null | undefined): number | null {
  if (typeof name !== 'string') return null;
  const match = PR_BRANCH_PATTERN.exec(name);
  if (!match) return null;
  const prNumber = Number.parseInt(match[1], 10);
  return Number.isSafeInteger(prNumber) ? prNumber : null;
}

/** The branch name a build surfs to for a given pull request. */
export function prBranchName(prNumber: number): string {
  return `pr-${prNumber}`;
}

/**
 * The `prNumbers` route param — a comma-separated list the launch gate hands the
 * pick screen so it can render without repeating a round-trip already paid for.
 * Anything unparseable is dropped rather than throwing: a hand-typed deep link
 * should degrade to "list them yourself", not to a crash.
 */
export function parsePrNumberList(raw: string | string[] | undefined): number[] {
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== 'string' || value.length === 0) return [];
  const prNumbers: number[] = [];
  for (const part of value.split(',')) {
    const parsed = Number.parseInt(part.trim(), 10);
    if (Number.isSafeInteger(parsed) && parsed > 0 && !prNumbers.includes(parsed)) prNumbers.push(parsed);
  }
  return prNumbers;
}
