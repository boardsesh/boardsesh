import { SCREENSHOT_BOARDS } from './screenshot-mode';
import { resolveScreenshotCppBoard, type ScreenshotCppBoardIdentity } from './screenshot-cpp-board-identity';
import { matchScreenshotBoardCandidates } from './screenshot-board-matching';

/**
 * Which of the account's boards a screenshot slot renders.
 *
 * Position alone can't answer that: `myBoards` orders by pin, then by when the
 * account last opened each board (#4884), so `boards[0]` shifts under the
 * capture whenever the account uses, pins, follows or adds a wall — which is how
 * a MoonBoard ended up as the wall in the App Store hero shots. (The recorder
 * that writes those timestamps is itself gated off in screenshot builds, but the
 * ordering still moves with pins and follows.) The capture asks for boards by
 * name instead (`SCREENSHOT_BOARDS`), and only falls back to a position when
 * nothing matches.
 *
 * Screenshot-only: every caller reaches this from an inlined
 * `EXPO_PUBLIC_SCREENSHOT_MODE === '1'` branch, so it dead-strips from normal
 * builds along with them.
 */

/** The `UserBoard` fields selection needs — kept structural so tests can pass literals. */
export type ScreenshotSelectableBoard = {
  uuid?: string;
  name: string;
  layoutName?: string | null;
  boardType: string;
  layoutId: number;
  sizeId: number;
  angle: number;
  setIds?: string | null;
  createdAt: string;
};

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
  return matchScreenshotBoardCandidates(boards, selector)[0] ?? null;
}

/**
 * The wall's identity in one fragment, so a capture run is debuggable from the
 * log the orchestrator tees. The config ids matter as much as the name: they are
 * what says whether "Marco's Board" is the 10x12 someone meant.
 *
 * The board type always comes last, after the angle. A wall's name and its
 * layout's name are free text (a spray wall's layout is whatever its owner
 * called it) and may hold any punctuation, so the showcase recorder reads the
 * type from the end of the line, where no free text can follow it
 * (`findBoardSlotProblem` in scripts/lib/showcase-video/record.ts).
 */
function describeBoard(board: ScreenshotSelectableBoard): string {
  const layout = board.layoutName ? `${board.layoutName} ` : '';
  return `(${layout}L${board.layoutId} S${board.sizeId} @${board.angle}°, ${board.boardType})`;
}

/**
 * The board for screenshot slot `index`, by `SCREENSHOT_BOARDS[index]`.
 *
 * Falls back to `createdAt`-ascending position — the same order the old
 * `?screenshotBoardIndex=` path used — when the slot has no selector or the
 * selector matches nothing, and logs a WARN in the latter case:
 * `findScreenshotRenderProblems` in `scripts/mobile-screenshots.ts` fails the
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

  if (process.env.EXPO_PUBLIC_SCREENSHOT_CPP_URL) {
    const commands = JSON.parse(process.env.EXPO_PUBLIC_SCREENSHOT_CPP_COMMANDS ?? '{}') as Record<
      string,
      { selector: string; identity: ScreenshotCppBoardIdentity }
    >;
    const scene = commands[`${index < 3 ? 'hero' : 'other'}-${(index % 3) + 1}`];
    const matched = scene ? resolveScreenshotCppBoard(boards, scene.selector, scene.identity) : null;
    if (!matched) {
      console.log(`[screenshot] WARN CPP board[${index}] verified identity missing or ambiguous`);
      return null;
    }
    console.log(`[screenshot] board[${index}] "${scene.selector}" -> "${matched.name}" ${describeBoard(matched)}`);
    return matched;
  }

  const selector = SCREENSHOT_BOARDS[index];
  if (selector) {
    const matched = matchScreenshotBoard(boards, selector);
    if (matched) {
      console.log(`[screenshot] board[${index}] "${selector}" -> "${matched.name}" ${describeBoard(matched)}`);
      return matched;
    }
    console.log(`[screenshot] WARN board[${index}] selector "${selector}" matched nothing; using position`);
    // Name what the account actually has. A selector only misses because the
    // board was renamed or never followed, and the fix is always "use one of
    // these" — so the failing run should hand over the list rather than send
    // someone to the app to read it off a phone.
    //
    // Its own line, not appended to the WARN above: this grows with the roster,
    // and `adb logcat` truncates a long message. Keeping the failure marker short
    // means the roster can be cut without taking the marker with it.
    console.log(
      `[screenshot] board roster: ${boards.map((board) => `"${board.name}" ${describeBoard(board)}`).join(', ')}`,
    );
  } else {
    // A slot the run never named. Reachable by retargeting with fewer selectors
    // than the flow has board shots (`--boards "My Wall"` against a flow that
    // shoots two walls), and it fails the same way a miss does: the shot lands
    // on whatever position happens to hold, which is the drift this module
    // exists to end.
    console.log(
      `[screenshot] WARN board[${index}] has no selector (${SCREENSHOT_BOARDS.length} configured); using position`,
    );
  }
  const byOldestFirst = [...boards].sort(
    (first, second) => new Date(first.createdAt).getTime() - new Date(second.createdAt).getTime(),
  );
  return byOldestFirst[index] ?? null;
}

/** Previous search results can survive a board switch; never open them for a new capture slot. */
export function screenshotClimbMatchesBoard(
  climb: { boardType?: string | null; layoutId?: number | null },
  board: { boardType: string; layoutId: number },
): boolean {
  return climb.boardType === board.boardType && climb.layoutId === board.layoutId;
}

/** The real list exposes its capture identity only after its current query lands. */
export function screenshotCppClimbListTestId(state: {
  captureEnabled: boolean;
  scene?: string;
  activeBoard: { uuid: string; boardType: string; layoutId: number } | null | undefined;
  targetUuid?: string;
  searchReady: boolean;
  loading: boolean;
  resolving: boolean;
  placeholder: boolean;
  firstClimb: { boardType?: string | null; layoutId?: number | null } | undefined;
}): string {
  const { activeBoard, firstClimb } = state;
  if (
    !state.captureEnabled ||
    !state.scene ||
    !activeBoard ||
    activeBoard.uuid !== state.targetUuid ||
    !state.searchReady ||
    state.loading ||
    state.resolving ||
    state.placeholder ||
    !firstClimb ||
    !screenshotClimbMatchesBoard(firstClimb, activeBoard)
  )
    return 'climb-list';
  return `cpp-climb-list-${activeBoard.uuid}`;
}

/** Identify the real wall hero only when its published feed and panel geometry agree. */
export function screenshotCppWallHeroTestId(state: {
  captureEnabled: boolean;
  column: boolean;
  publishedBoardUuid: string | null;
  activeBoard:
    | { uuid: string; boardType: string; layoutId: number; sizeId: number; setIds: string | null; angle: number }
    | null
    | undefined;
  panelConfig: { boardName: string; layoutId: number; sizeId: number; setIds: string; angle: number } | null;
  climbUuid: string | null | undefined;
}): string | undefined {
  const { activeBoard, panelConfig } = state;
  if (!state.captureEnabled || !state.column || !activeBoard || !panelConfig || !state.climbUuid?.trim())
    return undefined;
  const sets = (setIds: string | null) =>
    (setIds ?? '')
      .split(',')
      .filter(Boolean)
      .map(Number)
      .sort((left, right) => left - right)
      .join(',');
  if (
    state.publishedBoardUuid !== activeBoard.uuid ||
    panelConfig.boardName !== activeBoard.boardType ||
    panelConfig.layoutId !== activeBoard.layoutId ||
    panelConfig.sizeId !== activeBoard.sizeId ||
    sets(panelConfig.setIds) !== sets(activeBoard.setIds) ||
    panelConfig.angle !== activeBoard.angle
  )
    return undefined;
  return `cpp-wall-hero-${activeBoard.uuid}-${state.climbUuid}`;
}
