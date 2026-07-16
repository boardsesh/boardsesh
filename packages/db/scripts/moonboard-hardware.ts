import { MOONBOARD_CELL_SETS, MOONBOARD_LAYOUTS, MOONBOARD_SETS } from '@boardsesh/board-config';

export const MOONBOARD_PRODUCT_ID = 1;
export const MOONBOARD_HOLE_COUNT = 198;

export type MoonBoardProductRow = {
  boardType: 'moonboard';
  id: number;
  name: string;
  isListed: boolean;
  password: null;
  minCountInFrame: null;
  maxCountInFrame: null;
};

export type MoonBoardLayoutRow = {
  boardType: 'moonboard';
  id: number;
  productId: number;
  name: string;
  instagramCaption: null;
  isMirrored: boolean;
  isListed: boolean;
  password: null;
  createdAt: null;
};

export type MoonBoardSetRow = {
  boardType: 'moonboard';
  id: number;
  name: string;
  hsm: null;
};

export type MoonBoardHoleRow = {
  boardType: 'moonboard';
  id: number;
  productId: number;
  name: string;
  x: number;
  y: number;
  mirroredHoleId: null;
  mirrorGroup: number;
};

export type MoonBoardPlacementRow = {
  boardType: 'moonboard';
  id: number;
  layoutId: number;
  holeId: number;
  setId: number;
  defaultPlacementRoleId: null;
};

export type MoonBoardHardware = {
  products: MoonBoardProductRow[];
  layouts: MoonBoardLayoutRow[];
  sets: MoonBoardSetRow[];
  holes: MoonBoardHoleRow[];
  placements: MoonBoardPlacementRow[];
};

export type MoonBoardHardwareState = {
  products: ReadonlyArray<Record<string, unknown>>;
  layouts: ReadonlyArray<Record<string, unknown>>;
  sets: ReadonlyArray<Record<string, unknown>>;
  holes: ReadonlyArray<Record<string, unknown>>;
  placements: ReadonlyArray<Record<string, unknown>>;
};

export type MoonBoardHardwareUse = {
  layoutId: number;
  holeId: number;
  importedRowCount: number;
  userRowCount: number;
};

export function moonBoardPlacementId(layoutId: number, cellId: number): number {
  return layoutId * 1000 + cellId;
}

export function buildMoonBoardHardware(): MoonBoardHardware {
  const products: MoonBoardProductRow[] = [
    {
      boardType: 'moonboard',
      id: MOONBOARD_PRODUCT_ID,
      name: 'MoonBoard',
      isListed: true,
      password: null,
      minCountInFrame: null,
      maxCountInFrame: null,
    },
  ];

  const layouts: MoonBoardLayoutRow[] = Object.values(MOONBOARD_LAYOUTS)
    .map((layout) => ({
      boardType: 'moonboard' as const,
      id: layout.id,
      productId: MOONBOARD_PRODUCT_ID,
      name: layout.name,
      instagramCaption: null,
      isMirrored: false,
      isListed: true,
      password: null,
      createdAt: null,
    }))
    .sort((left, right) => left.id - right.id);

  const sets: MoonBoardSetRow[] = Object.values(MOONBOARD_SETS)
    .flat()
    .map((set) => ({ boardType: 'moonboard' as const, id: set.id, name: set.name, hsm: null }))
    .sort((left, right) => left.id - right.id);

  const holes: MoonBoardHoleRow[] = Array.from({ length: MOONBOARD_HOLE_COUNT }, (_, index) => {
    const id = index + 1;
    const columnIndex = index % 11;
    const row = Math.floor(index / 11) + 1;
    return {
      boardType: 'moonboard',
      id,
      productId: MOONBOARD_PRODUCT_ID,
      name: `${String.fromCharCode(65 + columnIndex)}${row}`,
      x: columnIndex + 1,
      y: row,
      mirroredHoleId: null,
      mirrorGroup: 0,
    };
  });

  const placements: MoonBoardPlacementRow[] = Object.entries(MOONBOARD_CELL_SETS)
    .flatMap(([layoutIdText, cells]) => {
      const layoutId = Number(layoutIdText);
      return Object.entries(cells).map(([cellIdText, setId]) => {
        const cellId = Number(cellIdText);
        return {
          boardType: 'moonboard' as const,
          id: moonBoardPlacementId(layoutId, cellId),
          layoutId,
          holeId: cellId,
          setId,
          defaultPlacementRoleId: null,
        };
      });
    })
    .sort((left, right) => left.id - right.id);

  return { products, layouts, sets, holes, placements };
}

export function findMoonBoardHardwareDefinitionProblems(expected: MoonBoardHardware): string[] {
  const problems: string[] = [];
  const expectedPlacementCounts = new Map([
    [1, 40],
    [2, 140],
    [3, 198],
    [4, 198],
    [5, 198],
    [6, 120],
    [7, 128],
  ]);
  const layoutIds = new Set(expected.layouts.map((layout) => layout.id));
  const setIds = new Set(expected.sets.map((set) => set.id));
  const holeIds = new Set(expected.holes.map((hole) => hole.id));
  const placementIds = new Set<number>();
  const placementPairs = new Set<string>();

  if (expected.products.length !== 1) problems.push(`products: expected 1 row, got ${expected.products.length}`);
  if (expected.layouts.length !== 7) problems.push(`layouts: expected 7 rows, got ${expected.layouts.length}`);
  if (expected.sets.length !== 31) problems.push(`sets: expected 31 rows, got ${expected.sets.length}`);
  if (expected.holes.length !== 198) problems.push(`holes: expected 198 rows, got ${expected.holes.length}`);
  if (expected.placements.length !== 1022) {
    problems.push(`placements: expected 1022 rows, got ${expected.placements.length}`);
  }

  for (const [layoutId, expectedCount] of expectedPlacementCounts) {
    const actualCount = expected.placements.filter((placement) => placement.layoutId === layoutId).length;
    if (actualCount !== expectedCount) {
      problems.push(`placements: layout ${layoutId} expected ${expectedCount} rows, got ${actualCount}`);
    }
  }

  for (const placement of expected.placements) {
    const pair = `${placement.layoutId}:${placement.holeId}`;
    if (placementIds.has(placement.id)) problems.push(`placements: duplicate id ${placement.id}`);
    if (placementPairs.has(pair)) problems.push(`placements: duplicate layout/hole ${pair}`);
    if (!layoutIds.has(placement.layoutId)) problems.push(`placements: unknown layout ${placement.layoutId}`);
    if (!holeIds.has(placement.holeId)) problems.push(`placements: unknown hole ${placement.holeId}`);
    if (!setIds.has(placement.setId)) problems.push(`placements: unknown set ${placement.setId}`);
    placementIds.add(placement.id);
    placementPairs.add(pair);
  }

  return problems;
}

function rowKey(row: Record<string, unknown>): number | null {
  return typeof row.id === 'number' ? row.id : null;
}

function findTableProblems(
  tableName: keyof MoonBoardHardware,
  expectedRows: ReadonlyArray<Record<string, unknown>>,
  actualRows: ReadonlyArray<Record<string, unknown>>,
  requireComplete: boolean,
): string[] {
  const problems: string[] = [];
  const expectedById = new Map(expectedRows.map((row) => [rowKey(row), row]));
  const actualById = new Map<number, Record<string, unknown>>();

  for (const actualRow of actualRows) {
    const id = rowKey(actualRow);
    if (id === null || !expectedById.has(id)) {
      problems.push(`${tableName}: unexpected row id ${String(actualRow.id)}`);
      continue;
    }
    if (actualById.has(id)) {
      problems.push(`${tableName}: duplicate row id ${id}`);
      continue;
    }
    actualById.set(id, actualRow);

    const expectedRow = expectedById.get(id);
    if (!expectedRow) continue;
    for (const [field, expectedValue] of Object.entries(expectedRow)) {
      if (!Object.is(actualRow[field], expectedValue)) {
        problems.push(
          `${tableName}: row ${id} field ${field} expected ${String(expectedValue)}, got ${String(actualRow[field])}`,
        );
      }
    }
  }

  if (requireComplete) {
    for (const expectedRow of expectedRows) {
      const id = rowKey(expectedRow);
      if (id !== null && !actualById.has(id)) problems.push(`${tableName}: missing row id ${id}`);
    }
  }

  return problems;
}

export function findMoonBoardHardwareProblems(
  expected: MoonBoardHardware,
  actual: MoonBoardHardwareState,
  requireComplete: boolean,
): string[] {
  return (Object.keys(expected) as Array<keyof MoonBoardHardware>).flatMap((tableName) =>
    findTableProblems(
      tableName,
      expected[tableName] as unknown as ReadonlyArray<Record<string, unknown>>,
      actual[tableName],
      requireComplete,
    ),
  );
}

export function countMissingMoonBoardHardware(expected: MoonBoardHardware, actual: MoonBoardHardwareState) {
  return Object.fromEntries(
    (Object.keys(expected) as Array<keyof MoonBoardHardware>).map((tableName) => {
      const actualIds = new Set(actual[tableName].map(rowKey));
      return [tableName, expected[tableName].filter((row) => !actualIds.has(row.id)).length];
    }),
  ) as Record<keyof MoonBoardHardware, number>;
}

export function findUnmappedMoonBoardHardwareUses(
  expected: MoonBoardHardware,
  uses: ReadonlyArray<MoonBoardHardwareUse>,
): MoonBoardHardwareUse[] {
  const mappedPairs = new Set(expected.placements.map((placement) => `${placement.layoutId}:${placement.holeId}`));
  return uses
    .filter((usage) => !mappedPairs.has(`${usage.layoutId}:${usage.holeId}`))
    .sort((left, right) => left.layoutId - right.layoutId || left.holeId - right.holeId);
}
