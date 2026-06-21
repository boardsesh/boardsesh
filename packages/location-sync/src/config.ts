import {
  getAllLayouts,
  getDefaultSizeForLayout,
  getProductSize,
  getSetsForLayoutAndSize,
  getSizesForLayoutId,
} from '@boardsesh/board-constants/product-sizes';
import {
  formatBoardDisplayName,
  MOONBOARD_ANGLES,
  MOONBOARD_LAYOUTS,
  MOONBOARD_SETS,
  MOONBOARD_SIZE,
  type MoonBoardLayoutKey,
} from '@boardsesh/board-config';
import type { AuroraBoardName, BoardName } from '@boardsesh/shared-schema';
import type { BoardInstallConfig } from './types';

const DEFAULT_ANGLE = 40;

export function setIdsToString(setIds: readonly number[]): string {
  return [...setIds].sort((left, right) => left - right).join(',');
}

export function formatLocationBoardName(boardType: string): string {
  const displayName = formatBoardDisplayName(boardType);
  return boardType === 'moonboard' ? displayName : `${displayName} Board`;
}

export function resolveSetIdsFromBitmask(
  boardType: BoardName,
  layoutId: number,
  sizeId: number,
  accumulatedValue: number | null | undefined,
): string | null {
  const availableSets = getSetsForLayoutAndSize(boardType, layoutId, sizeId);
  if (availableSets.length === 0) {
    return null;
  }

  if (!accumulatedValue || accumulatedValue === 0) {
    return setIdsToString(availableSets.map((set) => set.id));
  }

  const selectedIds: number[] = [];
  for (let index = 0; index < availableSets.length; index += 1) {
    const set = availableSets[index];
    if ((accumulatedValue & (1 << index)) !== 0) {
      selectedIds.push(set.id);
    }
  }

  return selectedIds.length > 0 ? setIdsToString(selectedIds) : setIdsToString(availableSets.map((set) => set.id));
}

export type SizeEdgesInput = {
  edgeLeft: number;
  edgeRight: number;
  edgeBottom: number;
  edgeTop: number;
};

function sameEdges(left: SizeEdgesInput, right: SizeEdgesInput): boolean {
  return (
    left.edgeLeft === right.edgeLeft &&
    left.edgeRight === right.edgeRight &&
    left.edgeBottom === right.edgeBottom &&
    left.edgeTop === right.edgeTop
  );
}

export function resolveKilterSizeId(args: {
  layoutId: number;
  productLayoutUuid: string | null;
  productLayoutEdges: SizeEdgesInput | null;
}): number | null {
  const sizes = getSizesForLayoutId('kilter', args.layoutId);

  const parsedSizeId = args.productLayoutUuid ? Number.parseInt(args.productLayoutUuid, 10) : Number.NaN;
  if (!Number.isNaN(parsedSizeId) && sizes.some((size) => size.id === parsedSizeId)) {
    return parsedSizeId;
  }

  const productLayoutEdges = args.productLayoutEdges;
  if (productLayoutEdges) {
    const matchingSize = sizes.find((size) => sameEdges(size, productLayoutEdges));
    if (matchingSize) {
      return matchingSize.id;
    }
  }

  return null;
}

export function resolveKilterInstallConfig(args: {
  layoutId: number;
  productLayoutUuid: string | null;
  productLayoutEdges: SizeEdgesInput | null;
  accumulatedHoldSetValue: number | null;
  angle: number | null;
  isAngleAdjustable: boolean;
}): BoardInstallConfig | null {
  const sizeId = resolveKilterSizeId({
    layoutId: args.layoutId,
    productLayoutUuid: args.productLayoutUuid,
    productLayoutEdges: args.productLayoutEdges,
  });
  if (sizeId == null) {
    return null;
  }

  const setIds = resolveSetIdsFromBitmask('kilter', args.layoutId, sizeId, args.accumulatedHoldSetValue);
  if (!setIds) {
    return null;
  }

  return {
    boardType: 'kilter',
    layoutId: args.layoutId,
    sizeId,
    setIds,
    angle: args.angle ?? DEFAULT_ANGLE,
    isAngleAdjustable: args.isAngleAdjustable,
  };
}

export function resolveDefaultAuroraLocationConfig(
  boardType: Exclude<AuroraBoardName, 'kilter'>,
): BoardInstallConfig | null {
  if (boardType === 'tension') {
    return {
      boardType,
      layoutId: 10,
      sizeId: 6,
      setIds: '12,13',
      angle: DEFAULT_ANGLE,
      isAngleAdjustable: true,
    };
  }

  const layouts = getAllLayouts(boardType);
  const firstLayout = layouts[0];
  if (!firstLayout) {
    return null;
  }

  const sizeId = getDefaultSizeForLayout(boardType, firstLayout.id);
  if (sizeId == null) {
    return null;
  }

  const productSize = getProductSize(boardType, sizeId);
  if (!productSize) {
    return null;
  }

  const sets = getSetsForLayoutAndSize(boardType, firstLayout.id, sizeId);
  if (sets.length === 0) {
    return null;
  }

  return {
    boardType,
    layoutId: firstLayout.id,
    sizeId,
    setIds: setIdsToString(sets.map((set) => set.id)),
    angle: DEFAULT_ANGLE,
    isAngleAdjustable: true,
  };
}

export type MoonBoardLocationConfig = BoardInstallConfig & {
  layoutName: string;
};

export function getMoonBoardLocationConfigs(): MoonBoardLocationConfig[] {
  const configs: MoonBoardLocationConfig[] = [];
  for (const [layoutKey, layout] of Object.entries(MOONBOARD_LAYOUTS) as Array<
    [MoonBoardLayoutKey, (typeof MOONBOARD_LAYOUTS)[MoonBoardLayoutKey]]
  >) {
    const sets = MOONBOARD_SETS[layoutKey] ?? [];
    if (sets.length === 0) {
      continue;
    }
    const setIds = setIdsToString(sets.map((set) => set.id));
    for (const angle of MOONBOARD_ANGLES) {
      configs.push({
        boardType: 'moonboard',
        layoutId: layout.id,
        layoutName: layout.name,
        sizeId: MOONBOARD_SIZE.id,
        setIds,
        angle,
        isAngleAdjustable: false,
      });
    }
  }
  return configs;
}
