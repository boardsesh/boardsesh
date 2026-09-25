import { describe, it, expect } from 'vitest';
import { SUPPORTED_BOARDS as SCHEMA_BOARDS } from '@boardsesh/shared-schema';
import { HOLD_STATE_MAP, STATE_TO_PRIMARY_CODE } from '@boardsesh/board-constants/hold-states';
import { SUPPORTED_BOARDS as DISPLAYED_BOARDS, ANGLES, BOARD_IMAGE_DIMENSIONS } from '../board-data';
import { boardSupportsMirroring } from '../board-mirroring';
import { formatBoardDisplayName, toBoardName } from '../board-name';
import { getDefaultRenderBoard, resolveRenderBoard } from '../resolve-render-board';
import {
  MAX_HOLDS_PER_WALL,
  MAX_SPRAY_WALLS_PER_USER,
  MAX_VERSIONS_PER_WALL,
  SPRAY_ANGLES,
  SPRAY_DISPLAY_NAME,
  SPRAY_PRODUCT_ID,
  SPRAY_ROLE,
  SPRAY_SET,
  SPRAY_SET_IDS,
  spraySizeIdForLayout,
} from '../spray-config';

describe('spray is the ninth board name', () => {
  it('is a supported board type the whole app can narrow to', () => {
    expect(SCHEMA_BOARDS).toContain('spray');
    expect(toBoardName('spray')).toBe('spray');
  });

  it('is never offered by a generic board picker', () => {
    // The display-filter list, not the schema list. A spray wall is created
    // through the add-a-wall flow, never picked from a catalogue of board
    // models — so BoardForm, use-board-builder and the wall finder, which all
    // build their options from this list, cannot list it.
    expect(DISPLAYED_BOARDS).not.toContain('spray');
    expect(SCHEMA_BOARDS).toContain('spray');
  });

  it('is called "Spray wall", not "Spray"', () => {
    expect(formatBoardDisplayName('spray')).toBe(SPRAY_DISPLAY_NAME);
  });

  it('carries no bundled board art', () => {
    // The "board art" is the climber's own photo, per wall version.
    expect(BOARD_IMAGE_DIMENSIONS.spray).toEqual({});
  });

  it('offers the wall-building angle range', () => {
    expect(ANGLES.spray).toEqual(SPRAY_ANGLES);
    expect(ANGLES.spray).not.toHaveLength(0);
  });

  it('does not mirror', () => {
    // A wall is a photograph of one physical wall — there is no mirror geometry
    // to reflect holds through.
    expect(boardSupportsMirroring('spray', 1)).toBe(false);
  });
});

describe('spray hold roles', () => {
  it('uses the Tension-style 1/2/3/4 codes', () => {
    expect(STATE_TO_PRIMARY_CODE.spray).toEqual({ STARTING: 1, HAND: 2, FINISH: 3, FOOT: 4 });
  });

  it('names the same four roles in HOLD_STATE_MAP', () => {
    expect(Object.entries(HOLD_STATE_MAP.spray).map(([code, info]) => [Number(code), info.name])).toEqual([
      [1, 'STARTING'],
      [2, 'HAND'],
      [3, 'FINISH'],
      [4, 'FOOT'],
    ]);
  });

  it('agrees with SPRAY_ROLE, so the editor and the frames writer cannot drift', () => {
    expect(SPRAY_ROLE).toEqual(STATE_TO_PRIMARY_CODE.spray);
  });
});

describe('the spray identity mapping', () => {
  it('pins one global product and one global hold set', () => {
    expect(SPRAY_PRODUCT_ID).toBe(1);
    expect(SPRAY_SET).toEqual({ id: 1, name: 'Holds' });
    expect(SPRAY_SET_IDS).toEqual([1]);
  });

  it('gives a wall the same id for its size as for its layout', () => {
    // A wall has exactly one size: itself.
    expect(spraySizeIdForLayout(4_211)).toBe(4_211);
  });

  it('pins the per-wall caps', () => {
    expect(MAX_SPRAY_WALLS_PER_USER).toBe(10);
    expect(MAX_HOLDS_PER_WALL).toBe(1500);
    expect(MAX_VERSIONS_PER_WALL).toBe(50);
  });
});

describe('resolveRenderBoard for spray', () => {
  it('draws a climb on its own wall, with the one hold set', () => {
    expect(resolveRenderBoard({ boardType: 'spray', climbLayoutId: 900 })).toEqual({
      layoutId: 900,
      sizeId: 900,
      setIds: [1],
    });
  });

  it('never guesses a wall when the climb names none', () => {
    // Every other board can fall back to "the layout's biggest size". There is
    // no such thing as a default spray wall, and drawing a climb on someone
    // else's wall is worse than drawing nothing.
    expect(getDefaultRenderBoard('spray', null)).toBeNull();
    expect(resolveRenderBoard({ boardType: 'spray', climbLayoutId: null })).toBeNull();
  });

  it('ignores a tick board and the owner boards — the climb names its wall', () => {
    const otherWall = { boardType: 'spray', layoutId: 7, sizeId: 7, setIds: [1], isOwned: true };
    expect(
      resolveRenderBoard({
        boardType: 'spray',
        climbLayoutId: 900,
        tickBoard: otherWall,
        ownerBoards: [otherWall],
      }),
    ).toEqual({ layoutId: 900, sizeId: 900, setIds: [1] });
  });
});
