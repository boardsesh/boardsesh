import { getLayout, getProductSize, getSetsForLayoutAndSize } from '@boardsesh/board-constants/product-sizes';
import { getMoonBoardDetails } from '@boardsesh/board-config';
import { SUPPORTED_BOARDS, type BoardName } from '@boardsesh/shared-schema';

export type BuildReadableClimbViewPathArgs = {
  boardName: string;
  layoutId: number;
  sizeId: number;
  setIds: string;
  angle: number;
  climbUuid: string;
  climbName?: string | null;
};

const supportedBoardNames = new Set<string>(SUPPORTED_BOARDS);
const boardNamePrefixRegex = new RegExp(`^(?:${SUPPORTED_BOARDS.join('|')})\\s*(?:board)?\\s*`, 'i');

function toBoardName(boardName: string): BoardName | null {
  return supportedBoardNames.has(boardName) ? (boardName as BoardName) : null;
}

function parseSetIds(setIds: string): number[] | null {
  const setIdSegments = setIds.split(',').map((setId) => setId.trim());
  if (setIdSegments.length === 0) return null;

  const setIdValues = setIdSegments.map((setId) => Number(setId));
  if (setIdSegments.some((setId) => setId.length === 0)) return null;
  if (setIdValues.some((setId) => !Number.isInteger(setId) || setId <= 0)) return null;

  return setIdValues;
}

function generateSlugFromText(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

function generateDescriptionSlug(description: string): string {
  return description
    .toLowerCase()
    .replace(/led\s*kit/gi, '')
    .trim()
    .replace(/[^\w\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

function generateLayoutSlug(layoutName: string): string {
  const baseSlug = layoutName
    .toLowerCase()
    .trim()
    .replace(boardNamePrefixRegex, '')
    .replace(/[^\w\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');

  if (baseSlug === 'original-layout') {
    return 'original';
  }

  if (baseSlug.startsWith('2-')) {
    return baseSlug.replace('2-', 'two-');
  }

  return baseSlug;
}

function generateSizeSlug(sizeName: string, description?: string): string {
  const sizeMatch = sizeName.match(/(\d+)\s*x\s*(\d+)/i);
  const baseSlug = sizeMatch ? `${sizeMatch[1]}x${sizeMatch[2]}` : generateSlugFromText(sizeName);

  if (description?.trim()) {
    const descriptionSlug = generateDescriptionSlug(description);
    if (descriptionSlug) {
      return `${baseSlug}-${descriptionSlug}`;
    }
  }

  return baseSlug;
}

function generateSetSlug(setNames: string[]): string {
  return setNames
    .map((name) => {
      const lowercaseName = name.toLowerCase().trim();

      const hasAux = lowercaseName.includes('auxiliary') || lowercaseName.includes('aux');
      const hasMain = lowercaseName.includes('mainline') || lowercaseName.includes('main');
      const hasKickerVariant = lowercaseName.includes('kickboard') || lowercaseName.includes('kicker');

      if (hasAux && hasKickerVariant) {
        return 'aux-kicker';
      }
      if (hasMain && hasKickerVariant) {
        return 'main-kicker';
      }
      if (hasAux) {
        return 'aux';
      }
      if (hasMain) {
        return 'main';
      }

      let result = lowercaseName.replace(/\s+ons?$/i, '').replace(/\s+/g, '-');

      if (result.startsWith('bolt')) {
        result = 'bolt';
      } else if (result.startsWith('screw')) {
        result = 'screw';
      }

      return result;
    })
    .sort((leftSetSlug, rightSetSlug) => rightSetSlug.localeCompare(leftSetSlug))
    .join('_');
}

function buildClimbSegment(climbUuid: string, climbName?: string | null): string {
  if (climbName?.trim()) {
    const climbSlug = generateSlugFromText(climbName.trim());
    if (climbSlug) {
      return `${climbSlug}-${climbUuid}`;
    }
  }

  return climbUuid;
}

function buildNumericClimbViewPath({
  boardName,
  layoutId,
  sizeId,
  setIds,
  angle,
  climbUuid,
  climbName,
}: BuildReadableClimbViewPathArgs): string {
  return `/${boardName}/${layoutId}/${sizeId}/${setIds}/${angle}/view/${buildClimbSegment(climbUuid, climbName)}`;
}

function resolveReadableBoardSegments({
  boardName,
  layoutId,
  sizeId,
  setIds,
}: Pick<BuildReadableClimbViewPathArgs, 'boardName' | 'layoutId' | 'sizeId' | 'setIds'>): {
  boardName: BoardName;
  layoutSlug: string;
  sizeSlug: string;
  setSlug: string;
} | null {
  const boardType = toBoardName(boardName);
  if (!boardType) return null;

  const setIdValues = parseSetIds(setIds);
  if (!setIdValues) return null;

  if (boardType === 'moonboard') {
    try {
      const moonBoardDetails = getMoonBoardDetails({ layout_id: layoutId, set_ids: setIdValues });
      if (moonBoardDetails.size_id !== sizeId || moonBoardDetails.set_names.length !== setIdValues.length) return null;

      return {
        boardName: boardType,
        layoutSlug: generateLayoutSlug(moonBoardDetails.layout_name),
        sizeSlug: generateSizeSlug(moonBoardDetails.size_name, moonBoardDetails.size_description),
        setSlug: generateSetSlug(moonBoardDetails.set_names),
      };
    } catch {
      return null;
    }
  }

  const layout = getLayout(boardType, layoutId);
  const size = getProductSize(boardType, sizeId);
  const availableSets = getSetsForLayoutAndSize(boardType, layoutId, sizeId);
  const selectedSetNames = availableSets.filter((set) => setIdValues.includes(set.id)).map((set) => set.name);

  if (!layout || !size || selectedSetNames.length !== setIdValues.length) {
    return null;
  }

  return {
    boardName: boardType,
    layoutSlug: generateLayoutSlug(layout.name),
    sizeSlug: generateSizeSlug(size.name, size.description),
    setSlug: generateSetSlug(selectedSetNames),
  };
}

export function buildReadableClimbViewPath(args: BuildReadableClimbViewPathArgs): string {
  const readableSegments = resolveReadableBoardSegments(args);
  if (!readableSegments) {
    return buildNumericClimbViewPath(args);
  }

  return `/${readableSegments.boardName}/${readableSegments.layoutSlug}/${readableSegments.sizeSlug}/${readableSegments.setSlug}/${args.angle}/view/${buildClimbSegment(args.climbUuid, args.climbName)}`;
}
