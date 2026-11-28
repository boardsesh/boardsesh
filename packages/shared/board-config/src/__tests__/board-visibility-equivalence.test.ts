// The capability table took over the release gate (`launchFlag`,
// `isConfigReleased`) from rules that named Quantum directly. This file pins the
// new code to the old rules over every input shape the old code distinguished,
// so the move is provably behaviour-neutral. Once a second board gains a row
// field, its cases belong in board-visibility.test.ts; these stay as the
// Quantum regression net.
import { describe, expect, it } from 'vitest';
import { SUPPORTED_BOARDS, type BoardName } from '@boardsesh/shared-schema';
import {
  isReleasedQuantumConfig,
  QUANTUM_MODELS,
  QUANTUM_RELEASED_MODELS,
  QUANTUM_SET_ID,
} from '@boardsesh/board-constants/quantum';
import {
  getAllLayouts,
  getDefaultSizeForLayout,
  getSetsForLayoutAndSize,
  getSizesForLayoutId,
} from '@boardsesh/board-constants/product-sizes';
import {
  getBoardLayouts,
  getBoardSetsForLayoutAndSize,
  getBoardSizesForLayoutId,
  getDefaultBoardSizeForLayout,
} from '../board-catalogue-cascade';
import {
  getBoardLaunchFlags,
  isBoardConfigReleased,
  isBoardConfigVisible,
  isBoardLaunchFlag,
  isBoardTypeVisible,
  type BoardVisibilityConfig,
  type BoardVisibilityFlags,
} from '../board-visibility';

// ---------------------------------------------------------------------------
// Verbatim copy of board-visibility.ts as it stood before the table owned the
// rule (origin/main 11ae71c064), with `legacy` prefixed to each name. It is the
// expected value of every case below; do not "fix" it.
const LEGACY_QUANTUM_BOARD_FLAG = 'quantum-board';
const LEGACY_BOARD_LAUNCH_FLAGS: Partial<Record<BoardName, string>> = { quantum: LEGACY_QUANTUM_BOARD_FLAG };

function legacyIsBoardTypeVisible(boardType: unknown, flags: BoardVisibilityFlags = {}): boolean {
  if (typeof boardType !== 'string') return false;
  const normalized = boardType.trim().toLowerCase();
  if (!normalized) return false;
  const launchFlag = LEGACY_BOARD_LAUNCH_FLAGS[normalized as BoardName];
  return launchFlag === undefined || flags[launchFlag] === true;
}

function legacyIsBoardConfigVisible(config: BoardVisibilityConfig, flags?: BoardVisibilityFlags): boolean {
  const boardType = 'boardType' in config ? config.boardType : config.boardName;
  if (!legacyIsBoardTypeVisible(boardType, flags)) return false;
  if (boardType.trim().toLowerCase() !== 'quantum') return true;
  const { layoutId, sizeId, setIds } = config;
  if (layoutId == null || sizeId == null || !isReleasedQuantumConfig(layoutId, sizeId)) return false;
  if (setIds === undefined) return true;
  return typeof setIds === 'string'
    ? setIds === String(QUANTUM_SET_ID)
    : setIds?.length === 1 && setIds[0] === QUANTUM_SET_ID;
}

function legacyIsBoardLaunchFlag(key: string): boolean {
  return Object.values(LEGACY_BOARD_LAUNCH_FLAGS).includes(key);
}
// ---------------------------------------------------------------------------

const BOARD_TYPE_INPUTS: readonly unknown[] = [
  ...SUPPORTED_BOARDS,
  'unknown-board',
  'QUANTUM',
  ' Quantum ',
  '\tquantum\n',
  'Kilter',
  '  spray ',
  '',
  ' ',
  // Names on Object.prototype: the old plain-object lookup found a non-flag
  // value for these and hid them.
  'constructor',
  ' Constructor ',
  '__proto__',
  'toString',
  undefined,
  null,
  1,
  {},
];

const FLAG_INPUTS: readonly (BoardVisibilityFlags | undefined)[] = [
  undefined,
  {},
  { [LEGACY_QUANTUM_BOARD_FLAG]: true },
  { [LEGACY_QUANTUM_BOARD_FLAG]: 'variant' },
  { [LEGACY_QUANTUM_BOARD_FLAG]: false },
  { [LEGACY_QUANTUM_BOARD_FLAG]: 1 },
  { [LEGACY_QUANTUM_BOARD_FLAG]: 'true' },
  { 'gym-kiosk': true },
];

const QUANTUM_LAYOUT_IDS = [...new Set(Object.values(QUANTUM_MODELS).map((model) => model.layoutId))];
const QUANTUM_SIZE_IDS = Object.values(QUANTUM_MODELS).map((model) => model.sizeId);
// Every Quantum layout against every Quantum size (released pairs, the Belay
// Board, and the cross pairs no model has), an Aurora-shaped pair, and the
// missing values a half-built setup carries.
const LAYOUT_ID_INPUTS: readonly (number | null | undefined)[] = [...QUANTUM_LAYOUT_IDS, 1, 424242, null, undefined];
const SIZE_ID_INPUTS: readonly (number | null | undefined)[] = [...QUANTUM_SIZE_IDS, 10, null, undefined];

const SET_ID_INPUTS: readonly BoardVisibilityConfig['setIds'][] = [
  undefined,
  null,
  String(QUANTUM_SET_ID),
  [QUANTUM_SET_ID],
  [],
  [QUANTUM_SET_ID, QUANTUM_SET_ID + 1],
  [QUANTUM_SET_ID + 1],
  `${QUANTUM_SET_ID},${QUANTUM_SET_ID + 1}`,
  `${QUANTUM_SET_ID},${QUANTUM_SET_ID}`,
  String(QUANTUM_SET_ID + 1),
  '',
  ` ${QUANTUM_SET_ID}`,
  `0${QUANTUM_SET_ID}`,
  `${QUANTUM_SET_ID}.0`,
  'not-a-set',
];

function buildConfig(
  boardTypeKey: 'boardType' | 'boardName',
  boardType: unknown,
  layoutId: number | null | undefined,
  sizeId: number | null | undefined,
  setIds: BoardVisibilityConfig['setIds'],
): BoardVisibilityConfig {
  // Board types off a stale cache are not always strings; the old code declined those.
  const boardTypeValue = boardType as string;
  return boardTypeKey === 'boardType'
    ? { boardType: boardTypeValue, layoutId, sizeId, setIds }
    : { boardName: boardTypeValue, layoutId, sizeId, setIds };
}

function describeCase(caseInput: Record<string, unknown>): string {
  return JSON.stringify(caseInput, (_key, caseValue: unknown) => (caseValue === undefined ? '<undefined>' : caseValue));
}

describe('board visibility matches the rules before the capability table owned them', () => {
  it('isBoardTypeVisible answers every board type and flag bag as before', () => {
    const mismatches: string[] = [];
    for (const boardType of BOARD_TYPE_INPUTS) {
      for (const flags of FLAG_INPUTS) {
        const expected = legacyIsBoardTypeVisible(boardType, flags);
        if (isBoardTypeVisible(boardType, flags) !== expected) {
          mismatches.push(describeCase({ boardType, flags, expected }));
        }
      }
    }
    expect(mismatches).toEqual([]);
  });

  it('isBoardConfigVisible answers every board, layout, size, set list and flag bag as before', () => {
    const mismatches: string[] = [];
    let caseCount = 0;
    for (const boardTypeKey of ['boardType', 'boardName'] as const) {
      for (const boardType of BOARD_TYPE_INPUTS) {
        for (const layoutId of LAYOUT_ID_INPUTS) {
          for (const sizeId of SIZE_ID_INPUTS) {
            for (const setIds of SET_ID_INPUTS) {
              const config = buildConfig(boardTypeKey, boardType, layoutId, sizeId, setIds);
              for (const flags of FLAG_INPUTS) {
                caseCount += 1;
                const expected = legacyIsBoardConfigVisible(config, flags);
                if (isBoardConfigVisible(config, flags) !== expected) {
                  mismatches.push(describeCase({ boardTypeKey, boardType, layoutId, sizeId, setIds, flags, expected }));
                }
              }
            }
          }
        }
      }
    }
    expect(mismatches).toEqual([]);
    // Guards against a refactor of the loops above quietly testing nothing.
    expect(caseCount).toBeGreaterThan(100_000);
  });

  it('opens a released Quantum setup only with the flag on, as before', () => {
    // Spot checks that the table above includes the cases that matter.
    const flagOn = { [LEGACY_QUANTUM_BOARD_FLAG]: true };
    for (const model of QUANTUM_RELEASED_MODELS) {
      const { layoutId, sizeId } = QUANTUM_MODELS[model];
      const released = { boardType: 'quantum', layoutId, sizeId, setIds: String(QUANTUM_SET_ID) };
      expect(isBoardConfigVisible(released, flagOn)).toBe(true);
      expect(isBoardConfigVisible(released)).toBe(false);
    }
    const belayBoard = QUANTUM_MODELS.belay;
    expect(
      isBoardConfigVisible({ boardType: 'quantum', layoutId: belayBoard.layoutId, sizeId: belayBoard.sizeId }, flagOn),
    ).toBe(false);
  });

  it('isBoardLaunchFlag recognises the same keys as before', () => {
    const keys = [LEGACY_QUANTUM_BOARD_FLAG, 'Quantum-Board', ' quantum-board', 'quantum', '', 'gym-kiosk'];
    // A system flag that must stay boolean-only by its own rule, not by being a launch flag.
    keys.push('quantum-catalog-sync');
    for (const key of keys) {
      expect(isBoardLaunchFlag(key)).toBe(legacyIsBoardLaunchFlag(key));
    }
  });

  it('getBoardLaunchFlags lists the old launch flags, as one frozen array', () => {
    expect(getBoardLaunchFlags()).toEqual(Object.values(LEGACY_BOARD_LAUNCH_FLAGS));
    // The mobile visibility hooks and web's catalogues hold this array; it must not change identity.
    expect(getBoardLaunchFlags()).toBe(getBoardLaunchFlags());
    expect(Object.isFrozen(getBoardLaunchFlags())).toBe(true);
  });
});

describe('isBoardConfigReleased matches the guards it replaced', () => {
  const boardNames: readonly string[] = [...SUPPORTED_BOARDS, 'unknown-board'];
  const layoutIds = [...QUANTUM_LAYOUT_IDS, 1, 424242];
  const sizeIds = [...QUANTUM_SIZE_IDS, 10];

  it('with no sets: `boardName !== "quantum" || isReleasedQuantumConfig(layoutId, sizeId)`', () => {
    const mismatches: string[] = [];
    for (const boardName of boardNames) {
      for (const layoutId of layoutIds) {
        for (const sizeId of sizeIds) {
          const expected = boardName !== 'quantum' || isReleasedQuantumConfig(layoutId, sizeId);
          if (isBoardConfigReleased(boardName, { layoutId, sizeId }) !== expected) {
            mismatches.push(describeCase({ boardName, layoutId, sizeId, expected }));
          }
        }
      }
    }
    expect(mismatches).toEqual([]);
  });

  it('with sets: the old visibility rule with the flag on', () => {
    const flagOn = { [LEGACY_QUANTUM_BOARD_FLAG]: true };
    const setIdLists: readonly (readonly number[])[] = [
      [QUANTUM_SET_ID],
      [],
      [QUANTUM_SET_ID, QUANTUM_SET_ID + 1],
      [QUANTUM_SET_ID + 1],
    ];
    const mismatches: string[] = [];
    for (const boardName of boardNames) {
      for (const layoutId of layoutIds) {
        for (const sizeId of sizeIds) {
          for (const setIds of setIdLists) {
            const expected = legacyIsBoardConfigVisible({ boardName, layoutId, sizeId, setIds }, flagOn);
            if (isBoardConfigReleased(boardName, { layoutId, sizeId, setIds }) !== expected) {
              mismatches.push(describeCase({ boardName, layoutId, sizeId, setIds, expected }));
            }
          }
        }
      }
    }
    expect(mismatches).toEqual([]);
  });
});

describe('setup cascade matches the Quantum branches it replaced', () => {
  // MoonBoard, Woods and spray answer from their own branches before the
  // release rule is reached; every other board falls through to it.
  const cascadeBoards = SUPPORTED_BOARDS.filter(
    (boardName) => boardName !== 'moonboard' && boardName !== 'woods' && boardName !== 'spray',
  );

  function legacySizes(boardName: BoardName, layoutId: number) {
    const sizes = getSizesForLayoutId(boardName, layoutId);
    return boardName === 'quantum' ? sizes.filter((size) => isReleasedQuantumConfig(layoutId, size.id)) : sizes;
  }

  it.each(cascadeBoards)('%s: layouts, sizes, default size and sets are unchanged', (boardName) => {
    const allLayouts = getAllLayouts(boardName);
    const legacyLayouts =
      boardName !== 'quantum'
        ? allLayouts
        : allLayouts.filter((layout) =>
            QUANTUM_RELEASED_MODELS.some((model) => QUANTUM_MODELS[model].layoutId === layout.id),
          );
    expect(getBoardLayouts(boardName)).toEqual(legacyLayouts);

    for (const layoutId of [...allLayouts.map((layout) => layout.id), 424242]) {
      expect(getBoardSizesForLayoutId(boardName, layoutId)).toEqual(legacySizes(boardName, layoutId));
      const legacyDefault =
        boardName === 'quantum'
          ? (legacySizes(boardName, layoutId)[0]?.id ?? null)
          : getDefaultSizeForLayout(boardName, layoutId);
      expect(getDefaultBoardSizeForLayout(boardName, layoutId)).toBe(legacyDefault);
      for (const size of getSizesForLayoutId(boardName, layoutId)) {
        const legacySets =
          boardName === 'quantum' && !isReleasedQuantumConfig(layoutId, size.id)
            ? []
            : getSetsForLayoutAndSize(boardName, layoutId, size.id);
        expect(getBoardSetsForLayoutAndSize(boardName, layoutId, size.id)).toEqual(legacySets);
      }
    }
  });
});
