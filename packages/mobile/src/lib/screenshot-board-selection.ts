import { SCREENSHOT_BOARDS } from './screenshot-mode';

/**
 * Which of the account's boards a screenshot slot renders.
 *
 * Position alone can't answer that: `myBoards` comes back ordered
 * `isOwned DESC, createdAt DESC`, so `boards[0]` is "the newest board I own" and
 * shifts under the capture every time the account follows or adds a wall — which
 * is how a MoonBoard ended up as the wall in the App Store hero shots. The
 * capture asks for boards by name instead (`SCREENSHOT_BOARDS`), and only falls
 * back to a position when nothing matches.
 *
 * Screenshot-only: every caller reaches this from an inlined
 * `EXPO_PUBLIC_SCREENSHOT_MODE === '1'` branch, so it dead-strips from normal
 * builds along with them.
 */

/** The `UserBoard` fields selection needs — kept structural so tests can pass literals. */
export type ScreenshotSelectableBoard = {
  name: string;
  layoutName?: string | null;
  boardType: string;
  layoutId: number;
  sizeId: number;
  angle: number;
  createdAt: string;
};

/**
 * Letters and digits only, lowercased.
 *
 * A selector is typed by a human into a workflow input or a constant, and the
 * name it has to hit was typed by a human into the app. "Marco's Board",
 * "Marcos Board" and a curly apostrophe all name the same wall, and a capture
 * that fails over the punctuation helps nobody.
 */
function looseKey(value: string | null | undefined): string {
  return (value ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

/**
 * Match one selector against the roster.
 *
 * Name first so a personal wall ("Marco's Board") wins over a stock layout that
 * happens to share a word, then layout name so a selector like "Tension Board 2"
 * finds the right wall whatever the account calls it. Whole
 * matches for both are tried before either substring pass, so a selector can
 * never be stolen by a longer name that merely contains it.
 */
export function matchScreenshotBoard<Board extends ScreenshotSelectableBoard>(
  boards: readonly Board[],
  selector: string,
): Board | null {
  const wanted = looseKey(selector);
  if (!wanted) return null;
  return (
    boards.find((board) => looseKey(board.name) === wanted) ??
    boards.find((board) => looseKey(board.layoutName) === wanted) ??
    boards.find((board) => looseKey(board.name).includes(wanted)) ??
    boards.find((board) => looseKey(board.layoutName).includes(wanted)) ??
    null
  );
}

/**
 * The wall's identity in one fragment, so a capture run is debuggable from the
 * log the orchestrator tees. The config ids matter as much as the name: they are
 * what says whether "Marco's Board" is the 10x12 someone meant.
 */
function describeBoard(board: ScreenshotSelectableBoard): string {
  const layout = board.layoutName ?? board.boardType;
  return `(${layout} L${board.layoutId} S${board.sizeId} @${board.angle}°)`;
}

/**
 * The board for screenshot slot `index`, by `SCREENSHOT_BOARDS[index]`.
 *
 * Falls back to `createdAt`-ascending position — the same order the old
 * `?screenshotBoardIndex=` path used — when the slot has no selector or the
 * selector matches nothing, and logs a WARN in the latter case:
 * `assertScreenshotRenderIntegrity` in `scripts/mobile-screenshots.ts` fails the
 * run on that line rather than let a wrong wall reach the store.
 */
export function resolveScreenshotBoard<Board extends ScreenshotSelectableBoard>(
  boards: readonly Board[],
  index: number,
): Board | null {
  // Nothing to match against yet — the roster query is still in flight. Both
  // callers re-run when it lands, and warning here would fail every capture on a
  // frame that was only ever going to be empty.
  if (boards.length === 0) return null;

  const selector = SCREENSHOT_BOARDS[index];
  if (selector) {
    const matched = matchScreenshotBoard(boards, selector);
    if (matched) {
      console.log(`[screenshot] board[${index}] "${selector}" -> "${matched.name}" ${describeBoard(matched)}`);
      return matched;
    }
    // Name what the account actually has. A selector only misses because the
    // board was renamed or never followed, and the fix is always "use one of
    // these" — so the failing run should hand over the list rather than send
    // someone to the app to read it off a phone.
    console.log(
      `[screenshot] WARN board[${index}] selector "${selector}" matched nothing; using position. ` +
        `Available: ${boards.map((board) => `"${board.name}" ${describeBoard(board)}`).join(', ')}`,
    );
  }
  const byOldestFirst = [...boards].sort(
    (first, second) => new Date(first.createdAt).getTime() - new Date(second.createdAt).getTime(),
  );
  return byOldestFirst[index] ?? null;
}
