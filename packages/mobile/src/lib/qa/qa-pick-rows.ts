import type { QaLabel, QaOtaBuildState, QaPreview } from '@boardsesh/shared-schema';
import type { QaPrBranch } from './qa-surf';
import { prBranchName } from './pr-branch';

/**
 * One row of the pick list: everything the branch list knows (which is always
 * available) joined with whatever the backend could tell us about the PR (which
 * may be nothing at all).
 *
 * `title === null` is the load-bearing case: GitHub being down, or the backend
 * having no open PR for a branch, must still leave a tappable row. Testing can
 * never be blocked on metadata — the branch is loadable either way.
 */
export type QaPickRow = {
  prNumber: number;
  branch: string;
  /**
   * ISO 8601 — when the branch last received a publish. Null for a PR that is
   * building its first bundle: there is nothing published to date yet.
   */
  lastUpdateAt: string | null;
  /**
   * ISO 8601 — when the PR was last updated on GitHub. The sort falls back to
   * this for a row with no publish yet, and it is null when the backend could
   * not name the PR at all.
   */
  updatedAt: string | null;
  title: string | null;
  author: string | null;
  url: string | null;
  isDraft: boolean;
  risk: number | null;
  /** This tester's most recent verdict on the PR, if any. */
  myVerdict: 'approved' | 'declined' | null;
  /** The verdict was filed against an earlier head commit — worth another look. */
  verdictIsStale: boolean;
  /** The server refused to serve this branch here because its update crashed. */
  refused: boolean;
  /**
   * Whether this build can actually surf here. False only for a PR that is
   * publishing its first bundle — there is no branch to load yet, so the row is
   * informational.
   */
  loadable: boolean;
  /** What the PR's preview bundle is doing right now. */
  otaBuild: QaOtaBuildState;
  /** The PR's GitHub labels, mirrored as chips. */
  labels: QaLabel[];
};

type BuildQaPickRowsInput = {
  branches: QaPrBranch[];
  previews: QaPreview[];
  refusedPrNumber: number | null;
};

/**
 * Joins the loadable branches with their PR metadata and orders them the way a
 * tester works: what nobody has looked at yet, riskiest first, freshest first.
 *
 * The branch list is the spine: a branch with no matching preview still gets a
 * row, because the branch is loadable whatever the backend knows.
 *
 * The one preview without a branch that still earns a row is one whose bundle is
 * mid-publish. It is not loadable and says so — but a tester who just pushed
 * needs to see "building", not an empty list. Every other branch-less preview is
 * still dropped: offering a row that cannot load is a dead end.
 */
export function buildQaPickRows({ branches, previews, refusedPrNumber }: BuildQaPickRowsInput): QaPickRow[] {
  // Indexed once, read O(1) per row — the list is rendered virtualized, so a
  // per-row scan would be a per-frame cost as the tester scrolls.
  const previewsByPrNumber = new Map<number, QaPreview>();
  for (const preview of previews) {
    previewsByPrNumber.set(preview.prNumber, preview);
  }

  const rows = branches.map<QaPickRow>((branch) => {
    const preview = previewsByPrNumber.get(branch.prNumber);
    const latestVerdict = preview?.myLatestVerdict ?? null;
    return {
      prNumber: branch.prNumber,
      branch: branch.branch,
      lastUpdateAt: branch.lastUpdateAt,
      updatedAt: preview?.updatedAt ?? null,
      title: preview?.title ?? null,
      author: preview?.author ?? null,
      url: preview?.url ?? null,
      isDraft: preview?.isDraft ?? false,
      risk: preview?.risk ?? null,
      myVerdict: latestVerdict?.verdict ?? null,
      // Only meaningful when both shas are known; an unknown head is not
      // evidence that a verdict went stale.
      verdictIsStale:
        latestVerdict !== null &&
        preview !== undefined &&
        latestVerdict.headSha !== null &&
        latestVerdict.headSha !== preview.headSha,
      refused: refusedPrNumber === branch.prNumber,
      loadable: true,
      otaBuild: preview?.otaBuild ?? 'unknown',
      labels: preview?.labels ?? [],
    };
  });

  // Indexed so the building pass below is O(1) per preview rather than a scan
  // of the rows built above.
  const branchedPrNumbers = new Set(branches.map((branch) => branch.prNumber));
  for (const preview of previews) {
    if (preview.otaBuild !== 'building' || branchedPrNumbers.has(preview.prNumber)) continue;
    rows.push({
      prNumber: preview.prNumber,
      // Deterministic, and unique per PR — so it is still a safe list key even
      // though no branch by this name exists yet.
      branch: prBranchName(preview.prNumber),
      lastUpdateAt: null,
      updatedAt: preview.updatedAt,
      title: preview.title,
      author: preview.author,
      url: preview.url,
      isDraft: preview.isDraft,
      risk: preview.risk,
      myVerdict: preview.myLatestVerdict?.verdict ?? null,
      // Nothing to be stale against: this tester cannot have run a bundle that
      // has not been published.
      verdictIsStale: false,
      refused: false,
      loadable: false,
      otaBuild: 'building',
      labels: preview.labels,
    });
  }

  rows.sort(compareQaPickRows);
  return rows;
}

function compareQaPickRows(left: QaPickRow, right: QaPickRow): number {
  // Untested first: a PR nobody has run is the one that needs a tester.
  const leftTested = left.myVerdict === null ? 0 : 1;
  const rightTested = right.myVerdict === null ? 0 : 1;
  if (leftTested !== rightTested) return leftTested - rightTested;

  // Then riskiest first. An unknown risk sorts below every stated one rather
  // than above it — a PR that never declared its risk is not thereby urgent.
  const leftRisk = left.risk ?? 0;
  const rightRisk = right.risk ?? 0;
  if (leftRisk !== rightRisk) return rightRisk - leftRisk;

  return rowTimeMs(right) - rowTimeMs(left);
}

/**
 * When this row last changed. The branch's publish time is the truth for
 * anything published; a row that is still building its first bundle has none,
 * so it sorts on the PR's own update time instead of falling to the bottom —
 * a PR someone just pushed is the one a tester most wants to see.
 */
function rowTimeMs(row: QaPickRow): number {
  return parseTimeMs(row.lastUpdateAt) || parseTimeMs(row.updatedAt);
}

function parseTimeMs(timestamp: string | null): number {
  if (timestamp === null) return 0;
  const parsed = Date.parse(timestamp);
  return Number.isFinite(parsed) ? parsed : 0;
}

export type QaRiskTone = 'unknown' | 'low' | 'medium' | 'high';

/**
 * The 1–5 risk a PR declares, bucketed for the chip's colour. Kept separate from
 * the palette so the mapping is testable and the same on both platforms.
 */
export function riskTone(risk: number | null): QaRiskTone {
  if (risk === null || !Number.isFinite(risk)) return 'unknown';
  if (risk <= 2) return 'low';
  if (risk <= 3) return 'medium';
  return 'high';
}

/**
 * How many mirrored GitHub label chips a row shows before it stops. A PR can
 * carry a dozen; the row already has risk, draft and verdict chips competing
 * for the same line.
 */
export const MAX_LABEL_CHIPS = 6;

/**
 * The labels worth showing, most actionable first.
 *
 * `backend` leads because it changes what a tester can conclude: the preview
 * bundle alone will not exercise a PR that also needs a server deploy. The rest
 * keep GitHub's own order. `qa-approved` / `qa-declined` are dropped — the row
 * already renders this tester's own verdict, and the PR-level label next to it
 * reads as a contradiction rather than extra information.
 */
export function visibleLabels(labels: readonly QaLabel[]): QaLabel[] {
  const shown = labels.filter((label) => label.name !== 'qa-approved' && label.name !== 'qa-declined');
  const backend = shown.filter((label) => label.name === 'backend');
  const rest = shown.filter((label) => label.name !== 'backend');
  return [...backend, ...rest].slice(0, MAX_LABEL_CHIPS);
}

/**
 * A readable foreground for GitHub's own label colour.
 *
 * Label colours are picked by whoever created the label, against GitHub's white
 * background, so a chip that just paints the raw hex is unreadable about half
 * the time in dark mode. Using the colour as the chip's border and text instead
 * keeps every label legible in both themes while still being recognisably the
 * label's colour.
 *
 * Null means "no usable colour — let the chip use the theme's own": either the
 * hex was malformed, or it is so close to white that it would vanish against
 * the light-mode surface.
 */
export function labelChipColor(color: string): string | null {
  if (!/^[0-9a-fA-F]{6}$/.test(color)) return null;
  const red = Number.parseInt(color.slice(0, 2), 16);
  const green = Number.parseInt(color.slice(2, 4), 16);
  const blue = Number.parseInt(color.slice(4, 6), 16);
  // Rec. 601 luma — close enough for "is this washed out", and cheap.
  const luma = (red * 299 + green * 587 + blue * 114) / 1000;
  return luma > 200 ? null : `#${color.toLowerCase()}`;
}

/** The label a row shows when the backend could not name the PR. */
export function fallbackRowTitle(prNumber: number): string {
  return prBranchName(prNumber);
}
