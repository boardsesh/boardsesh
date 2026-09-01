import type { QaPreview } from '@boardsesh/shared-schema';
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
  /** ISO 8601 — when the branch last received a publish. */
  lastUpdateAt: string;
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
 * The branch list is the spine, not the preview list — a branch with no matching
 * preview still gets a row, and a preview with no branch is dropped (it cannot
 * be loaded on this build, so offering it would be a dead end).
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
    };
  });

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

  return branchTimeMs(right.lastUpdateAt) - branchTimeMs(left.lastUpdateAt);
}

function branchTimeMs(lastUpdateAt: string): number {
  const parsed = Date.parse(lastUpdateAt);
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

/** The label a row shows when the backend could not name the PR. */
export function fallbackRowTitle(prNumber: number): string {
  return prBranchName(prNumber);
}
