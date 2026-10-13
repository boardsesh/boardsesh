import { describe, expect, it } from 'vitest';
import {
  selectScreenshotClimb,
  screenshotPaintedClimbTestId,
  screenshotLocalMirrorTestId,
  selectScreenshotGradeRange,
  screenshotWallKioskPaintedTestId,
} from '../screenshot-climb-selection';
import { buildCountPreviewInput } from '../climb-count-preview-input';
import { DEFAULT_FILTERS } from '../climb-filter-types';

const board = { uuid: 'owned-board', boardType: 'kilter', layoutId: 1, sizeId: 10, setIds: '1,20', angle: 40 };
const query = { boardName: board.boardType, layoutId: 1, sizeId: 10, setIds: '20,1', angle: 40 };
const first = {
  uuid: 'D0E5387D5B974D38B4E93FC4DFD61EF6',
  boardType: 'kilter',
  layoutId: 1,
  angle: 40,
  frames: 'p1r12',
};
const requested = { ...first, uuid: 'FC08DF05598B46BFB404BEDCA07685A2', compatibleSizeIds: [10] };

describe('real screenshot climb selection', () => {
  it('binds kiosk paint to the actual published board, presence climb and panel geometry', () => {
    const presence = { climbUuid: requested.uuid, frames: requested.frames, angle: 40 };
    const marker = screenshotWallKioskPaintedTestId(true, board.uuid, query, presence);
    expect(marker).toBe(`store-kiosk-painted-owned-board-${requested.uuid}-kilter-1-10-1-20-40`);
    expect(screenshotWallKioskPaintedTestId(false, board.uuid, query, presence)).toBeUndefined();
    expect(screenshotWallKioskPaintedTestId(true, null, query, presence)).toBeUndefined();
    expect(screenshotWallKioskPaintedTestId(true, board.uuid, query, null)).toBeUndefined();
    expect(screenshotWallKioskPaintedTestId(true, board.uuid, query, { ...presence, frames: '' })).toBeUndefined();
    expect(screenshotWallKioskPaintedTestId(true, board.uuid, query, { ...presence, angle: 25 })).toBeUndefined();
    expect(screenshotWallKioskPaintedTestId(true, board.uuid, { ...query, setIds: '' }, presence)).toBeUndefined();
    for (const changed of [{ boardName: 'tension' }, { layoutId: 2 }, { sizeId: 11 }, { setIds: '1' }])
      expect(screenshotWallKioskPaintedTestId(true, board.uuid, { ...query, ...changed }, presence)).not.toBe(marker);
    expect(screenshotWallKioskPaintedTestId(true, 'other-board', query, presence)).not.toBe(marker);
    expect(screenshotWallKioskPaintedTestId(true, board.uuid, query, { ...presence, climbUuid: 'other' })).not.toBe(
      marker,
    );
  });
  it('accepts only real grade-stop endpoints for the exact loaded board and uses the native count wire', () => {
    const grades = [{ difficultyId: 14 }, { difficultyId: 15 }, { difficultyId: 16 }];
    const stops = [
      { minGradeId: 14, maxGradeId: 15 },
      { minGradeId: 16, maxGradeId: 16 },
    ];
    const range = selectScreenshotGradeRange('14', '16', grades, board, board, query, true, stops)!;
    expect(range).toEqual({ minGrade: 14, maxGrade: 16 });
    expect(buildCountPreviewInput({ ...DEFAULT_FILTERS, ...range }, {}, query, '')).toEqual({
      ...query,
      page: 0,
      pageSize: 1,
      sortBy: 'ascents',
      sortOrder: 'desc',
      minGrade: 14,
      maxGrade: 16,
      boulders: true,
    });
    for (const [min, max] of [
      ['15', '16'],
      ['14', '999'],
      ['16', '14'],
      ['NaN', '16'],
      ['14.5', '16'],
      ['', '16'],
    ])
      expect(selectScreenshotGradeRange(min, max, grades, board, board, query, true, stops)).toBeNull();
    expect(selectScreenshotGradeRange('14', '16', grades, board, board, query, false, stops)).toBeNull();
    expect(
      selectScreenshotGradeRange('14', '16', grades, board, { ...board, uuid: 'stale-board' }, query, true, stops),
    ).toBeNull();
    expect(
      selectScreenshotGradeRange('14', '16', grades, board, { ...board, sizeId: 999 }, query, true, stops),
    ).toBeNull();
    expect(selectScreenshotGradeRange('14', '16', [], board, board, query, true, stops)).toBeNull();
  });
  it('opens the requested loaded row and retains old first-row behavior without a selection', () => {
    expect(selectScreenshotClimb([first, requested], requested.uuid, board, query, true)).toBe(requested);
    expect(selectScreenshotClimb([first, requested], undefined, board, query, true)).toBe(first);
    expect(selectScreenshotClimb([first], requested.uuid, board, query, true)).toBeNull();
    expect(selectScreenshotClimb([first], '', board, query, true)).toBeNull();
    expect(selectScreenshotClimb([requested], requested.uuid, board, query, false)).toBeNull();
  });
  it.each([{ boardName: 'moonboard' }, { layoutId: 2 }, { sizeId: 11 }, { setIds: '1' }, { angle: 25 }])(
    'rejects a query from another exact board configuration: %j',
    (change) => {
      expect(selectScreenshotClimb([requested], requested.uuid, board, { ...query, ...change }, true)).toBeNull();
    },
  );
  it.each([{ boardType: 'moonboard' }, { layoutId: 2 }, { angle: 25 }, { compatibleSizeIds: [11] }])(
    'rejects a requested row incompatible with the current board: %j',
    (change) => {
      expect(selectScreenshotClimb([{ ...requested, ...change }], requested.uuid, board, query, true)).toBeNull();
    },
  );
  it('binds the real painted marker to both UUIDs and current geometry without changing raw identifier casing', () => {
    expect(screenshotPaintedClimbTestId(true, board, query, requested)).toBe(
      `cpp-climb-painted-owned-board-${requested.uuid}`,
    );
    expect(screenshotPaintedClimbTestId(false, board, query, requested)).toBeUndefined();
    expect(screenshotPaintedClimbTestId(true, board, query, requested, true)).toBe(
      `cpp-climb-painted-owned-board-${requested.uuid}-mirrored`,
    );
    expect(screenshotPaintedClimbTestId(true, { ...board, sizeId: 11 }, query, requested)).toBeUndefined();
    expect(screenshotPaintedClimbTestId(true, board, query, { ...requested, frames: '' })).toBeUndefined();
  });
  it('exposes local mirror eligibility only for a genuine supported solo board or actual pinned preview', () => {
    const solo = { captureEnabled: true, supportsMirroring: true, sessionId: null, isPreview: false };
    expect(screenshotLocalMirrorTestId(solo, board, query, requested)).toBe(
      `cpp-climb-local-mirror-owned-board-${requested.uuid}`,
    );
    expect(screenshotLocalMirrorTestId({ ...solo, sessionId: 'shared' }, board, query, requested)).toBeUndefined();
    expect(screenshotLocalMirrorTestId({ ...solo, sessionId: undefined }, board, query, requested)).toBeUndefined();
    expect(
      screenshotLocalMirrorTestId({ ...solo, sessionId: 'shared', isPreview: true }, board, query, requested),
    ).toBeDefined();
    expect(screenshotLocalMirrorTestId({ ...solo, supportsMirroring: false }, board, query, requested)).toBeUndefined();
    expect(screenshotLocalMirrorTestId(solo, { ...board, sizeId: 11 }, query, requested)).toBeUndefined();
  });
});
