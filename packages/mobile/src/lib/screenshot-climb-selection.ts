/** Default-search rows used by the screenshot-only kiosk feed and its fixture verifier. */
export const SCREENSHOT_WALL_SEED_COUNT = 6;

type CaptureBoardConfig = { boardType: string; layoutId: number; sizeId: number; setIds: string; angle: number };
type CaptureQueryConfig = { boardName: string; layoutId: number; sizeId: number; setIds: string; angle: number };
function currentBoardQuery(board: CaptureBoardConfig, query: CaptureQueryConfig): boolean {
  const sets = (setIds: string) =>
    setIds
      .split(',')
      .map(Number)
      .sort((left, right) => left - right)
      .join(',');
  return (
    query.boardName === board.boardType &&
    query.layoutId === board.layoutId &&
    query.sizeId === board.sizeId &&
    query.angle === board.angle &&
    sets(query.setIds) === sets(board.setIds)
  );
}

/** Screenshot deep links must activate a genuine row from the current board query. */
export function selectScreenshotClimb<
  Climb extends {
    uuid: string;
    boardType?: string | null;
    layoutId?: number | null;
    angle?: number | null;
    compatibleSizeIds?: readonly number[] | null;
  },
>(
  climbs: readonly Climb[],
  requestedId: string | undefined,
  board: { boardType: string; layoutId: number; sizeId: number; setIds: string; angle: number },
  query: { boardName: string; layoutId: number; sizeId: number; setIds: string; angle: number },
  ready: boolean,
): Climb | null {
  if (!ready || !currentBoardQuery(board, query)) return null;
  const candidate = requestedId === undefined ? climbs[0] : climbs.find((climb) => climb.uuid === requestedId);
  if (
    !candidate ||
    candidate.boardType !== board.boardType ||
    candidate.layoutId !== board.layoutId ||
    (requestedId !== undefined &&
      (!requestedId.trim() ||
        (candidate.angle != null && candidate.angle !== board.angle) ||
        (candidate.compatibleSizeIds != null && !candidate.compatibleSizeIds.includes(board.sizeId))))
  )
    return null;
  return candidate;
}

/** Apply only real loaded grade IDs to the exact requested owned board. */
export function selectScreenshotGradeRange(
  minGrade: string | undefined,
  maxGrade: string | undefined,
  grades: readonly { difficultyId: number }[],
  board: (CaptureBoardConfig & { uuid: string }) | null | undefined,
  target: (CaptureBoardConfig & { uuid?: string }) | null | undefined,
  query: CaptureQueryConfig,
  ready: boolean,
  stops: readonly { minGradeId: number; maxGradeId: number }[],
): { minGrade: number; maxGrade: number } | null {
  if (
    !ready ||
    !board?.uuid ||
    board.uuid !== target?.uuid ||
    !currentBoardQuery(board, query) ||
    !target ||
    !currentBoardQuery(target, query) ||
    !/^\d+$/.test(minGrade ?? '') ||
    !/^\d+$/.test(maxGrade ?? '')
  )
    return null;
  const minimum = Number(minGrade);
  const maximum = Number(maxGrade);
  if (
    !Number.isSafeInteger(minimum) ||
    !Number.isSafeInteger(maximum) ||
    minimum > maximum ||
    !grades.some((grade) => grade.difficultyId === minimum) ||
    !grades.some((grade) => grade.difficultyId === maximum) ||
    !stops.some((stop) => stop.minGradeId === minimum) ||
    !stops.some((stop) => stop.maxGradeId === maximum)
  )
    return null;
  return { minGrade: minimum, maxGrade: maximum };
}

export function screenshotPaintedClimbTestId(
  enabled: boolean,
  board:
    | { uuid: string; boardType: string; layoutId: number; sizeId: number; setIds: string; angle: number }
    | null
    | undefined,
  query: { boardName: string; layoutId: number; sizeId: number; setIds: string; angle: number },
  climb:
    | { uuid: string; frames: string; boardType?: string | null; layoutId?: number | null; angle?: number | null }
    | undefined,
  mirrored = false,
): string | undefined {
  if (
    !enabled ||
    !board?.uuid ||
    !climb?.uuid ||
    !climb.frames ||
    !selectScreenshotClimb([climb], climb.uuid, board, query, true)
  )
    return undefined;
  return `cpp-climb-painted-${board.uuid}-${climb.uuid}${mirrored ? '-mirrored' : ''}`;
}

/** The kiosk marker binds displayed artwork to the published real board and climb. */
export function screenshotWallKioskPaintedTestId(
  enabled: boolean,
  publishedBoardUuid: string | null,
  panel: CaptureQueryConfig,
  climb: { climbUuid: string; frames?: string | null; angle?: number | null } | null,
): string | undefined {
  if (
    !enabled ||
    !publishedBoardUuid?.trim() ||
    !climb?.climbUuid.trim() ||
    !climb.frames?.trim() ||
    climb.angle !== panel.angle ||
    !panel.boardName.trim() ||
    !Number.isSafeInteger(panel.layoutId) ||
    panel.layoutId <= 0 ||
    !Number.isSafeInteger(panel.sizeId) ||
    panel.sizeId <= 0 ||
    !Number.isFinite(panel.angle) ||
    !/^\d+(,\d+)*$/.test(panel.setIds)
  )
    return undefined;
  const sets = panel.setIds
    .split(',')
    .map(Number)
    .sort((left, right) => left - right)
    .join('-');
  return `store-kiosk-painted-${publishedBoardUuid}-${climb.climbUuid}-${panel.boardName}-${panel.layoutId}-${panel.sizeId}-${sets}-${panel.angle}`;
}

/** An actual shared-session wall must never be mirrored by marketing automation. */
export function screenshotLocalMirrorTestId(
  state: {
    captureEnabled: boolean;
    supportsMirroring: boolean;
    sessionId: string | null | undefined;
    isPreview: boolean;
  },
  board: Parameters<typeof screenshotPaintedClimbTestId>[1],
  query: Parameters<typeof screenshotPaintedClimbTestId>[2],
  climb: Parameters<typeof screenshotPaintedClimbTestId>[3],
): string | undefined {
  return screenshotPaintedClimbTestId(
    state.captureEnabled && state.supportsMirroring && (state.sessionId === null || state.isPreview),
    board,
    query,
    climb,
  )?.replace('cpp-climb-painted-', 'cpp-climb-local-mirror-');
}
