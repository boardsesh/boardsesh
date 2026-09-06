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

// Rec. 601 luma bounds for "would this vanish into the surface". Which end
// matters depends on the theme, so both are named rather than one magic number.
const LABEL_TOO_PALE_FOR_LIGHT = 200;
const LABEL_TOO_DARK_FOR_DARK = 60;

/**
 * A readable foreground for GitHub's own label colour.
 *
 * Label colours are picked by whoever created the label, against GitHub's white
 * background, so a chip that just paints the raw hex is unreadable about half
 * the time. Using the colour as the chip's border and text instead keeps every
 * label legible while still being recognisably the label's colour.
 *
 * The unreadable end flips with the theme, so this needs the scheme: `a2eeef`
 * (GitHub's default `enhancement`) is washed out on a light surface and perfect
 * on a dark one, and a near-black label is the other way round. Judging both
 * against the light-mode threshold would have thrown away the colour of most
 * default GitHub labels in dark mode for no reason.
 *
 * Null means "no usable colour here — let the chip use the theme's own".
 */
export function labelChipColor(color: string, colorScheme: 'light' | 'dark'): string | null {
  if (!/^[0-9a-fA-F]{6}$/.test(color)) return null;
  const red = Number.parseInt(color.slice(0, 2), 16);
  const green = Number.parseInt(color.slice(2, 4), 16);
  const blue = Number.parseInt(color.slice(4, 6), 16);
  const luma = (red * 299 + green * 587 + blue * 114) / 1000;
  const vanishes = colorScheme === 'dark' ? luma < LABEL_TOO_DARK_FOR_DARK : luma > LABEL_TOO_PALE_FOR_LIGHT;
  return vanishes ? null : `#${color.toLowerCase()}`;
}

/** The label a row shows when the backend could not name the PR. */
export function fallbackRowTitle(prNumber: number): string {
  return prBranchName(prNumber);
}

// Anchored on the WHOLE query, unlike `parsePrBranch`'s branch-name pattern: this
// parses what a tester types, so `5203`, `#5203`, `pr-5203` and `PR 5203` are all
// the same request. Leading zeros are accepted here and rejected there, and that
// asymmetry is deliberate — `pr-05203` is not a branch our workflow ever publishes,
// but `05203` typed into a search box plainly means 5203, and the branch name is
// regenerated by `prBranchName` either way.
const PR_QUERY_PATTERN = /^(?:#|pr[-#\s]?)?(\d+)$/i;

/**
 * The pull request a search query names, or null when it names none.
 *
 * The filter and the "try it anyway" affordance both read this, so they can never
 * disagree about whether a query is a PR number — a query that offered to surf to
 * #5203 while #5203 was in fact in the list would leave the safe path for nothing.
 */
export function parsePrQuery(query: string): number | null {
  const match = PR_QUERY_PATTERN.exec(query.trim());
  if (!match) return null;
  const prNumber = Number.parseInt(match[1], 10);
  return Number.isSafeInteger(prNumber) && prNumber > 0 ? prNumber : null;
}

// NFD then strip combining marks, so `cafe` finds `café`. An explicit range rather
// than `\p{Diacritic}`: it is exactly as correct for the Latin text PR titles are
// written in, and asks nothing of the engine's Unicode property tables.
const COMBINING_MARKS = /[\u0300-\u036f]/g;

function foldForSearch(text: string): string {
  return text.trim().toLowerCase().normalize('NFD').replace(COMBINING_MARKS, '');
}

/**
 * The rows a search query keeps, matched on the PR's title and its number.
 *
 * An empty query returns the SAME array rather than a copy. The screen feeds this
 * straight to a virtualized list, and handing it a fresh array on every render
 * would throw away its bail-out for the ordinary case where nobody has typed.
 *
 * Text matches as an AND of whitespace-separated tokens, so `fix queue` finds "Fix
 * the queue reducer" — which is how people type, and a strict superset of plain
 * substring for a single word.
 *
 * The number matches as a decimal PREFIX, not a substring. A PR number is typed
 * left-to-right, so a prefix is the only rule under which the list narrows as the
 * tester types — and it has to be able to narrow all the way to nothing, because
 * reaching zero matches is what offers the escape hatch. Under substring matching
 * `5` would keep #4795 and #1523 alongside #5203, and the hatch would be
 * unreachable for exactly the short queries that need it.
 */
export function filterQaPickRows(rows: QaPickRow[], query: string): QaPickRow[] {
  const folded = foldForSearch(query);
  if (folded.length === 0) return rows;

  const tokens = folded.split(/\s+/);
  const prNumber = parsePrQuery(query);
  const numberPrefix = prNumber === null ? null : String(prNumber);

  return rows.filter((row) => {
    // Only the title goes in the text haystack. A row the backend could not name
    // renders as its branch — `fallbackRowTitle` returns `pr-<n>` — but matching
    // that string as TEXT would quietly reintroduce tail-matching on the number:
    // `5` is a substring of `pr-1523`. Such a row stays findable through the
    // number rule below, which answers `1523`, `#1523` and `pr-1523` alike.
    const haystack = foldForSearch(row.title ?? '');
    if (haystack.length > 0 && tokens.every((token) => haystack.includes(token))) return true;
    return numberPrefix !== null && String(row.prNumber).startsWith(numberPrefix);
  });
}

/**
 * The PR a query names that this build has no row for, or null.
 *
 * Deliberately NOT "the filtered list came back empty". A numeric query also runs
 * the text pass, so searching `5203` matches a PR titled "Follow up #5203" — and
 * that unrelated row is enough to make the list non-empty while #5203 itself is
 * nowhere to be found. Gating the escape hatch on an empty list therefore hid it in
 * exactly the case it exists for.
 *
 * Asks `rows`, not the filtered rows: the question is whether this build has that PR
 * at all, which does not depend on what is currently typed.
 */
export function unlistedPrNumber(rows: QaPickRow[], query: string): number | null {
  const prNumber = parsePrQuery(query);
  if (prNumber === null) return null;
  return rows.some((row) => row.prNumber === prNumber) ? null : prNumber;
}

/**
 * What the pick screen shows below its header. Kept here, as a pure function over
 * facts, because the distinction that matters — "nothing matches what you typed"
 * versus "nothing is published for this build" — is a rule worth testing without a
 * renderer, and six sibling ternaries in the screen would bury it.
 */
export type QaPickListState =
  | { kind: 'loading' }
  | { kind: 'surfing-off' }
  | { kind: 'unreachable' }
  | { kind: 'no-match' }
  | { kind: 'empty' }
  | { kind: 'rows'; rows: QaPickRow[] };

type QaPickListStateInput = {
  isPending: boolean;
  isError: boolean;
  surfingOff: boolean;
  rows: QaPickRow[];
  visibleRows: QaPickRow[];
  hasQuery: boolean;
};

export function qaPickListState(input: QaPickListStateInput): QaPickListState {
  // First, and ahead of the loading check: the server has told us this channel
  // serves no previews at all, and xprem's own 404 path CLEARS any branch pin when
  // it does. Offering a search field or an escape hatch here would invite a device
  // to re-pin itself into exactly the state the server is switching off.
  if (input.surfingOff) return { kind: 'surfing-off' };
  if (input.isPending) return { kind: 'loading' };
  if (input.isError) return { kind: 'unreachable' };
  // Before the empty check, not after. When nothing at all is published AND the
  // tester has typed a number, the escape hatch is the single most useful thing on
  // the screen — an empty list is the signature of a fingerprint drift, which is
  // the case someone hands you a PR number for.
  if (input.hasQuery && input.visibleRows.length === 0) return { kind: 'no-match' };
  if (input.rows.length === 0) return { kind: 'empty' };
  return { kind: 'rows', rows: input.visibleRows };
}
