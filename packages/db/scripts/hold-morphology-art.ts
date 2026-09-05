import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import {
  IMAGE_FILENAMES,
  PRODUCT_SIZES,
  getHolePlacements,
  type HoldTuple,
} from '@boardsesh/board-constants/product-sizes';
import {
  MOONBOARD_CELL_SETS,
  MOONBOARD_LAYOUTS,
  MOONBOARD_SETS,
  getMoonBoardGeometry,
  getGridPosition,
  type MoonBoardLayoutKey,
} from '@boardsesh/board-config';
import {
  HOLD_MORPHOLOGY_VERSION,
  extractHoldMorphology,
  holdMorphologyRecordKey,
  locateHoldComponent,
  prepareMorphologyImage,
  type HoldMorphologyExtraction,
  type HoldMorphologyRecord,
  type HoldPixelLocation,
  type PreparedMorphologyImage,
  type RawRgbaImage,
} from '../src/queries/hold-morphology/index.js';

export const HOLD_MORPHOLOGY_BOARD_TYPES = ['kilter', 'tension', 'moonboard'] as const;
export type HoldMorphologyBoardType = (typeof HOLD_MORPHOLOGY_BOARD_TYPES)[number];

type AuroraBoardType = Exclude<HoldMorphologyBoardType, 'moonboard'>;

export type HoldMorphologyFailureReason =
  | 'missing-source'
  | 'empty-image'
  | 'missing-hold'
  | 'insufficient-cell-pixels'
  | 'shared-component'
  | 'duplicate-record-key';

export type HoldMorphologyFailure = {
  boardType: HoldMorphologyBoardType;
  layoutId: number;
  holdId: number;
  reason: HoldMorphologyFailureReason;
  sourceAsset: string | null;
  detail: string;
};

export type ExtractCommittedHoldMorphologyOptions = {
  repoRoot: string;
  boardTypes?: readonly HoldMorphologyBoardType[];
};

export type ExtractCommittedHoldMorphologyResult = {
  records: HoldMorphologyRecord[];
  failures: HoldMorphologyFailure[];
};

type LoadedArt = {
  prepared: PreparedMorphologyImage;
  sha256: string;
};

type AuroraCandidate = {
  boardType: AuroraBoardType;
  layoutId: number;
  sizeId: number;
  setId: number;
  sourceAsset: string;
  sourceAbsolutePath: string;
  edgeLeft: number;
  edgeRight: number;
  edgeBottom: number;
  edgeTop: number;
  coverageCount: number;
  physicalArea: number;
};

type AuroraPlacement = {
  placementId: number;
  x: number;
  y: number;
};

type AuroraAssignment = {
  candidate: AuroraCandidate;
  placements: AuroraPlacement[];
  gridStepX: number;
  gridStepY: number;
};

type LocatedHold<THold> = {
  hold: THold;
  location: HoldPixelLocation;
};

type LocatedExtraction<THold> = LocatedHold<THold> & {
  extraction: HoldMorphologyExtraction;
};

function sourceAssetPath(boardType: HoldMorphologyBoardType, imageFilename: string): string {
  return path.posix.join('packages/web/public/images', boardType, imageFilename);
}

async function loadArt(sourceAbsolutePath: string): Promise<LoadedArt> {
  const sourceBytes = await readFile(sourceAbsolutePath);
  const sha256 = createHash('sha256').update(sourceBytes).digest('hex');
  const { data, info } = await sharp(sourceBytes)
    .ensureAlpha()
    .toColourspace('srgb')
    .raw()
    .toBuffer({ resolveWithObject: true });
  if (info.channels !== 4) {
    throw new Error(`Expected sharp to decode ${sourceAbsolutePath} as RGBA, got ${info.channels} channels`);
  }
  const image: RawRgbaImage = {
    data,
    width: info.width,
    height: info.height,
    channels: 4,
  };
  return { prepared: prepareMorphologyImage(image), sha256 };
}

function tupleToPlacement(tuple: HoldTuple): AuroraPlacement {
  const [placementId, , x, y] = tuple;
  return { placementId, x, y };
}

function groupKey(layoutId: number, setId: number): string {
  return `${layoutId}:${setId}`;
}

function assignmentKey(candidate: AuroraCandidate): string {
  return `${candidate.layoutId}:${candidate.sizeId}:${candidate.setId}:${candidate.sourceAsset}`;
}

function containsPlacement(candidate: AuroraCandidate, placement: AuroraPlacement): boolean {
  return (
    placement.x > candidate.edgeLeft &&
    placement.x < candidate.edgeRight &&
    placement.y > candidate.edgeBottom &&
    placement.y < candidate.edgeTop
  );
}

function mostCommonGridStep(values: readonly number[]): number {
  const uniqueValues = [...new Set(values)].sort((left, right) => left - right);
  const counts = new Map<number, number>();
  for (let index = 1; index < uniqueValues.length; index++) {
    const difference = uniqueValues[index]! - uniqueValues[index - 1]!;
    if (difference <= 0) continue;
    counts.set(difference, (counts.get(difference) ?? 0) + 1);
  }
  const ranked = [...counts.entries()].sort(
    ([leftStep, leftCount], [rightStep, rightCount]) => rightCount - leftCount || leftStep - rightStep,
  );
  return ranked[0]?.[0] ?? 8;
}

function compareCandidates(left: AuroraCandidate, right: AuroraCandidate): number {
  return (
    right.coverageCount - left.coverageCount ||
    right.physicalArea - left.physicalArea ||
    left.sizeId - right.sizeId ||
    left.sourceAsset.localeCompare(right.sourceAsset)
  );
}

/**
 * Most art layers have one alpha component per hold. A few MoonBoard holds
 * physically touch their neighbour in the PNG; only those shared components
 * are re-extracted inside their individual grid cells.
 */
function extractLocatedHolds<THold>(
  prepared: PreparedMorphologyImage,
  locatedHolds: readonly LocatedHold<THold>[],
): LocatedExtraction<THold>[] {
  const initial = locatedHolds.map((entry) => ({
    ...entry,
    component: locateHoldComponent(prepared, entry.location),
  }));
  const componentUseCount = new Map<number, number>();
  for (const entry of initial) {
    if (!entry.component.ok) continue;
    componentUseCount.set(entry.component.componentId, (componentUseCount.get(entry.component.componentId) ?? 0) + 1);
  }
  return initial.map((entry) => {
    const clipToCell = entry.component.ok && (componentUseCount.get(entry.component.componentId) ?? 0) > 1;
    return {
      hold: entry.hold,
      location: entry.location,
      extraction: extractHoldMorphology(prepared, { ...entry.location, clipToCell }),
    };
  });
}

function buildAuroraAssignments(
  boardType: AuroraBoardType,
  repoRoot: string,
): { assignments: AuroraAssignment[]; failures: HoldMorphologyFailure[] } {
  const imageMappings = IMAGE_FILENAMES[boardType];
  const candidatesByGroup = new Map<string, AuroraCandidate[]>();
  const placementsByGroup = new Map<string, AuroraPlacement[]>();
  const placementsByLayout = new Map<number, Map<number, AuroraPlacement>>();
  const failures: HoldMorphologyFailure[] = [];

  for (const [mappingKey, imageFilename] of Object.entries(imageMappings)) {
    const match = /^(\d+)-(\d+)-(\d+)$/.exec(mappingKey);
    if (!match) continue;
    const layoutId = Number(match[1]);
    const sizeId = Number(match[2]);
    const setId = Number(match[3]);
    const size = PRODUCT_SIZES[boardType][sizeId];
    if (!size) continue;
    const key = groupKey(layoutId, setId);
    let placements = placementsByGroup.get(key);
    if (!placements) {
      placements = getHolePlacements(boardType, layoutId, setId).map(tupleToPlacement);
      placementsByGroup.set(key, placements);
      const layoutPlacements = placementsByLayout.get(layoutId) ?? new Map<number, AuroraPlacement>();
      for (const placement of placements) layoutPlacements.set(placement.placementId, placement);
      placementsByLayout.set(layoutId, layoutPlacements);
    }

    const sourceAsset = sourceAssetPath(boardType, imageFilename);
    const candidate: AuroraCandidate = {
      boardType,
      layoutId,
      sizeId,
      setId,
      sourceAsset,
      sourceAbsolutePath: path.join(repoRoot, sourceAsset),
      edgeLeft: size.edgeLeft,
      edgeRight: size.edgeRight,
      edgeBottom: size.edgeBottom,
      edgeTop: size.edgeTop,
      coverageCount: 0,
      physicalArea: (size.edgeRight - size.edgeLeft) * (size.edgeTop - size.edgeBottom),
    };
    candidate.coverageCount = placements.filter((placement) => containsPlacement(candidate, placement)).length;
    const candidates = candidatesByGroup.get(key) ?? [];
    candidates.push(candidate);
    candidatesByGroup.set(key, candidates);
  }

  const assignmentsByKey = new Map<string, AuroraAssignment>();
  for (const [key, placements] of placementsByGroup) {
    const candidates = [...(candidatesByGroup.get(key) ?? [])].sort(compareCandidates);
    const [layoutIdText] = key.split(':');
    const layoutId = Number(layoutIdText);
    const layoutPlacements = [...(placementsByLayout.get(layoutId)?.values() ?? [])];
    const gridStepX = mostCommonGridStep(layoutPlacements.map((placement) => placement.x));
    const gridStepY = mostCommonGridStep(layoutPlacements.map((placement) => placement.y));

    for (const placement of placements) {
      const candidate = candidates.find((entry) => containsPlacement(entry, placement));
      if (!candidate) {
        failures.push({
          boardType,
          layoutId,
          holdId: placement.placementId,
          reason: 'missing-source',
          sourceAsset: null,
          detail: `No committed ${boardType} art layer contains placement ${placement.placementId}`,
        });
        continue;
      }
      const keyForAssignment = assignmentKey(candidate);
      const assignment = assignmentsByKey.get(keyForAssignment) ?? {
        candidate,
        placements: [],
        gridStepX,
        gridStepY,
      };
      assignment.placements.push(placement);
      assignmentsByKey.set(keyForAssignment, assignment);
    }
  }

  const assignments = [...assignmentsByKey.values()].sort(
    (left, right) =>
      left.candidate.layoutId - right.candidate.layoutId ||
      left.candidate.setId - right.candidate.setId ||
      left.candidate.sizeId - right.candidate.sizeId ||
      left.candidate.sourceAsset.localeCompare(right.candidate.sourceAsset),
  );
  for (const assignment of assignments) {
    assignment.placements.sort((left, right) => left.placementId - right.placementId);
  }
  return { assignments, failures };
}

async function extractAuroraBoard(
  boardType: AuroraBoardType,
  repoRoot: string,
): Promise<ExtractCommittedHoldMorphologyResult> {
  const { assignments, failures } = buildAuroraAssignments(boardType, repoRoot);
  const records: HoldMorphologyRecord[] = [];

  for (const assignment of assignments) {
    const { candidate } = assignment;
    let loaded: LoadedArt;
    try {
      loaded = await loadArt(candidate.sourceAbsolutePath);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      for (const placement of assignment.placements) {
        failures.push({
          boardType,
          layoutId: candidate.layoutId,
          holdId: placement.placementId,
          reason: 'missing-source',
          sourceAsset: candidate.sourceAsset,
          detail,
        });
      }
      continue;
    }

    const { prepared, sha256 } = loaded;
    const cellWidth = (prepared.image.width / (candidate.edgeRight - candidate.edgeLeft)) * assignment.gridStepX;
    const cellHeight = (prepared.image.height / (candidate.edgeTop - candidate.edgeBottom)) * assignment.gridStepY;
    const componentOwners = new Map<number, { holdId: number; clipped: boolean }>();

    const locatedPlacements = assignment.placements.map((placement) => ({
      hold: placement,
      location: {
        centerX:
          ((placement.x - candidate.edgeLeft) / (candidate.edgeRight - candidate.edgeLeft)) * prepared.image.width,
        centerY:
          prepared.image.height -
          ((placement.y - candidate.edgeBottom) / (candidate.edgeTop - candidate.edgeBottom)) * prepared.image.height,
        cellWidth,
        cellHeight,
      },
    }));
    for (const { hold: placement, extraction } of extractLocatedHolds(prepared, locatedPlacements)) {
      if (!extraction.ok) {
        failures.push({
          boardType,
          layoutId: candidate.layoutId,
          holdId: placement.placementId,
          reason: extraction.reason,
          sourceAsset: candidate.sourceAsset,
          detail: `Could not resolve placement ${placement.placementId} to a visible hold component`,
        });
        continue;
      }

      const existingOwner = componentOwners.get(extraction.componentId);
      if (existingOwner && (!existingOwner.clipped || !extraction.componentWasClipped)) {
        failures.push({
          boardType,
          layoutId: candidate.layoutId,
          holdId: placement.placementId,
          reason: 'shared-component',
          sourceAsset: candidate.sourceAsset,
          detail: `Placements ${existingOwner.holdId} and ${placement.placementId} resolved to component ${extraction.componentId}`,
        });
        continue;
      }
      componentOwners.set(extraction.componentId, {
        holdId: placement.placementId,
        clipped: extraction.componentWasClipped,
      });
      records.push({
        morphologyVersion: HOLD_MORPHOLOGY_VERSION,
        boardType,
        layoutId: candidate.layoutId,
        placementId: placement.placementId,
        setId: candidate.setId,
        sourceAsset: candidate.sourceAsset,
        sourceAssetSha256: sha256,
        normalizedCenterDistance: extraction.normalizedCenterDistance,
        vector: extraction.vector,
      });
    }
  }

  return { records, failures };
}

async function extractMoonBoard(repoRoot: string): Promise<ExtractCommittedHoldMorphologyResult> {
  const records: HoldMorphologyRecord[] = [];
  const failures: HoldMorphologyFailure[] = [];

  const layouts = Object.entries(MOONBOARD_LAYOUTS).sort(
    ([, leftLayout], [, rightLayout]) => leftLayout.id - rightLayout.id,
  );
  for (const [layoutKeyText, layout] of layouts) {
    const layoutKey = layoutKeyText as MoonBoardLayoutKey;
    const geometry = getMoonBoardGeometry(layoutKey);
    const cellWidth =
      (geometry.width * (1 - geometry.calibration.leftMargin - geometry.calibration.rightMargin)) / geometry.numColumns;
    const cellHeight =
      (geometry.height * (1 - geometry.calibration.topMargin - geometry.calibration.bottomMargin)) / geometry.numRows;
    const cells = MOONBOARD_CELL_SETS[layout.id] ?? {};
    const sets = [...MOONBOARD_SETS[layoutKey]].sort((left, right) => left.id - right.id);

    for (const set of sets) {
      const gridCellIds = Object.entries(cells)
        .filter(([, setId]) => setId === set.id)
        .map(([gridCellId]) => Number(gridCellId))
        .sort((left, right) => left - right);
      if (gridCellIds.length === 0) continue;

      const imageFilename = path.posix.join(layout.folder, set.imageFile);
      const sourceAsset = sourceAssetPath('moonboard', imageFilename);
      const sourceAbsolutePath = path.join(repoRoot, sourceAsset);
      let loaded: LoadedArt;
      try {
        loaded = await loadArt(sourceAbsolutePath);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        for (const gridCellId of gridCellIds) {
          failures.push({
            boardType: 'moonboard',
            layoutId: layout.id,
            holdId: gridCellId,
            reason: 'missing-source',
            sourceAsset,
            detail,
          });
        }
        continue;
      }

      const componentOwners = new Map<number, { holdId: number; clipped: boolean }>();
      const locatedGridCells = gridCellIds.map((gridCellId) => {
        const position = getGridPosition(gridCellId, geometry);
        return {
          hold: gridCellId,
          location: {
            centerX: position.x * geometry.width,
            centerY: position.y * geometry.height,
            cellWidth,
            cellHeight,
          },
        };
      });
      for (const { hold: gridCellId, extraction } of extractLocatedHolds(loaded.prepared, locatedGridCells)) {
        if (!extraction.ok) {
          failures.push({
            boardType: 'moonboard',
            layoutId: layout.id,
            holdId: gridCellId,
            reason: extraction.reason,
            sourceAsset,
            detail: `Could not resolve grid cell ${gridCellId} to a visible hold component`,
          });
          continue;
        }

        const existingOwner = componentOwners.get(extraction.componentId);
        if (existingOwner && (!existingOwner.clipped || !extraction.componentWasClipped)) {
          failures.push({
            boardType: 'moonboard',
            layoutId: layout.id,
            holdId: gridCellId,
            reason: 'shared-component',
            sourceAsset,
            detail: `Grid cells ${existingOwner.holdId} and ${gridCellId} resolved to component ${extraction.componentId}`,
          });
          continue;
        }
        componentOwners.set(extraction.componentId, {
          holdId: gridCellId,
          clipped: extraction.componentWasClipped,
        });
        records.push({
          morphologyVersion: HOLD_MORPHOLOGY_VERSION,
          boardType: 'moonboard',
          layoutId: layout.id,
          gridCellId,
          setId: set.id,
          sourceAsset,
          sourceAssetSha256: loaded.sha256,
          normalizedCenterDistance: extraction.normalizedCenterDistance,
          vector: extraction.vector,
        });
      }
    }
  }

  return { records, failures };
}

function findDuplicateRecordFailures(records: readonly HoldMorphologyRecord[]): HoldMorphologyFailure[] {
  const seen = new Set<string>();
  const failures: HoldMorphologyFailure[] = [];
  for (const record of records) {
    const key = holdMorphologyRecordKey(record);
    if (!seen.has(key)) {
      seen.add(key);
      continue;
    }
    failures.push({
      boardType: record.boardType,
      layoutId: record.layoutId,
      holdId: record.boardType === 'moonboard' ? record.gridCellId : record.placementId,
      reason: 'duplicate-record-key',
      sourceAsset: record.sourceAsset,
      detail: `Generated duplicate morphology key ${key}`,
    });
  }
  return failures;
}

export async function extractCommittedHoldMorphology({
  repoRoot,
  boardTypes = HOLD_MORPHOLOGY_BOARD_TYPES,
}: ExtractCommittedHoldMorphologyOptions): Promise<ExtractCommittedHoldMorphologyResult> {
  const selectedBoards = new Set(boardTypes);
  const results: ExtractCommittedHoldMorphologyResult[] = [];
  if (selectedBoards.has('kilter')) results.push(await extractAuroraBoard('kilter', repoRoot));
  if (selectedBoards.has('tension')) results.push(await extractAuroraBoard('tension', repoRoot));
  if (selectedBoards.has('moonboard')) results.push(await extractMoonBoard(repoRoot));

  const records = results.flatMap((result) => result.records);
  const failures = results.flatMap((result) => result.failures);
  failures.push(...findDuplicateRecordFailures(records));
  return { records, failures };
}
