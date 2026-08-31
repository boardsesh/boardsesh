import { createHash } from 'node:crypto';
import type {
  QuantumDiodeRow,
  QuantumModelCode,
  QuantumModelRow,
  QuantumRouteLightRow,
  QuantumRouteRow,
  ValidatedQuantumSnapshot,
} from '@boardsesh/quantum-sync';
import { BOULDER_GRADES } from '@boardsesh/board-constants/boulder-grade-mapping';
import type {
  NewBoardDifficultyGrade,
  NewBoardHole,
  NewBoardLayout,
  NewBoardLed,
  NewBoardPlacement,
  NewBoardProductSize,
  NewBoardProductSizeLayoutSet,
} from '@boardsesh/db/schema';
import { CLIMB_CHARACTERISTICS } from '@boardsesh/shared-schema';

export const QUANTUM_BOARD_TYPE = 'quantum' as const;
export const QUANTUM_PRODUCT_ID = 91;
export const QUANTUM_SET_ID = 1;
export const QUANTUM_DEFAULT_ROLE_ID = 13;
export const QUANTUM_MAX_DIODES_PER_ROUTE = 92;

const POSTGRES_INTEGER_MIN = -2_147_483_648;
const POSTGRES_INTEGER_MAX = 2_147_483_647;

const QUANTUM_ROLE_ROWS = [
  {
    boardType: QUANTUM_BOARD_TYPE,
    id: 12,
    productId: QUANTUM_PRODUCT_ID,
    position: 1,
    name: 'STARTING',
    fullName: 'Starting hold',
    ledColor: '#00FF00',
    screenColor: '#00FF00',
  },
  {
    boardType: QUANTUM_BOARD_TYPE,
    id: 13,
    productId: QUANTUM_PRODUCT_ID,
    position: 2,
    name: 'HAND',
    fullName: 'Hand hold',
    ledColor: '#00FFFF',
    screenColor: '#00FFFF',
  },
  {
    boardType: QUANTUM_BOARD_TYPE,
    id: 14,
    productId: QUANTUM_PRODUCT_ID,
    position: 3,
    name: 'FINISH',
    fullName: 'Finish hold',
    ledColor: '#FF00FF',
    screenColor: '#FF00FF',
  },
] as const;

type QuantumHoldState = 'STARTING' | 'HAND' | 'FINISH';

export type PreparedQuantumHold = Readonly<{
  boardType: typeof QUANTUM_BOARD_TYPE;
  climbUuid: string;
  holdId: number;
  frameNumber: 0;
  holdState: QuantumHoldState;
}>;

export type PreparedQuantumClimb = Readonly<{
  uuid: string;
  boardType: typeof QUANTUM_BOARD_TYPE;
  layoutId: number;
  setterId: null;
  setterUsername: string | null;
  name: string;
  description: string;
  hsm: null;
  edgeLeft: number;
  edgeRight: number;
  edgeBottom: number;
  edgeTop: number;
  angle: number;
  framesCount: 1;
  framesPace: 0;
  frames: string;
  controllerRouteUuid: string;
  isDraft: false;
  isListed: boolean;
  createdAt: string;
  publishedAt: string;
  synced: true;
  syncError: null;
  userId: null;
  requiredSetIds: readonly [typeof QUANTUM_SET_ID];
  compatibleSizeIds: readonly [number];
  holdFingerprint: string;
  characteristics: readonly string[] | null;
}>;

export type PreparedQuantumMetadata = Readonly<{
  climbUuid: string;
  sourceGrade: number | null;
  isStandard: boolean;
  isCampusing: boolean;
  isEdge: boolean;
  usesKickplate: boolean;
  allowsMatching: boolean;
  tags: readonly string[];
}>;

export type PreparedQuantumStat = Readonly<{
  boardType: typeof QUANTUM_BOARD_TYPE;
  climbUuid: string;
  angle: number;
  displayDifficulty: number | null;
  difficultyAverage: number | null;
  upstreamAscensionistCount: number;
  ascensionistCount: number;
  upstreamQualityAverage: number | null;
  qualityAverage: number | null;
  qualityNormalized: true;
  upstreamSyncedAt: string;
}>;

export type PreparedQuantumCatalog = Readonly<{
  hardwareFingerprint: string;
  grades: readonly Readonly<NewBoardDifficultyGrade>[];
  products: readonly Readonly<{
    boardType: typeof QUANTUM_BOARD_TYPE;
    id: number;
    name: string;
    isListed: boolean;
    password: null;
    minCountInFrame: number;
    maxCountInFrame: number;
  }>[];
  sets: readonly Readonly<{
    boardType: typeof QUANTUM_BOARD_TYPE;
    id: number;
    name: string;
    hsm: null;
  }>[];
  roles: typeof QUANTUM_ROLE_ROWS;
  layouts: readonly Readonly<NewBoardLayout>[];
  productSizes: readonly Readonly<NewBoardProductSize>[];
  productSizeLayoutSets: readonly Readonly<NewBoardProductSizeLayoutSet>[];
  holes: readonly Readonly<NewBoardHole>[];
  placements: readonly Readonly<NewBoardPlacement>[];
  leds: readonly Readonly<NewBoardLed>[];
  climbs: readonly PreparedQuantumClimb[];
  holds: readonly PreparedQuantumHold[];
  metadata: readonly PreparedQuantumMetadata[];
  stats: readonly PreparedQuantumStat[];
}>;

/**
 * Translate the signed source's grade-id array to Boardsesh's canonical grade
 * ids. Unknown and malformed encodings stay null; the source's top id maps to
 * 34 and is deliberately clamped to Boardsesh's current maximum of 33.
 */
export function mapQuantumGrade(rawGrade: string): number | null {
  const gradeIds = parseGradeIds(rawGrade);
  if (!gradeIds) return null;

  const exactRangeGrades: Readonly<Record<string, number>> = {
    '[6]': 10,
    '[7]': 10,
    '[7,8]': 11,
    '[8]': 11,
    '[9]': 12,
    '[9,10]': 13,
    '[10]': 13,
    '[11]': 14,
    '[11,12]': 15,
    '[12]': 15,
    '[12,13]': 15,
    '[13]': 15,
    '[15,16]': 18,
    '[19,20]': 22,
    '[20,21]': 23,
    '[21,22]': 24,
    '[22,23]': 25,
  };
  const exactGrade = exactRangeGrades[JSON.stringify(gradeIds)];
  if (exactGrade !== undefined) return exactGrade;

  if (gradeIds.length === 1) {
    const sourceGrade = gradeIds[0];
    if (sourceGrade !== undefined && sourceGrade >= 14 && sourceGrade <= 32) {
      return Math.min(sourceGrade + 2, 33);
    }
  }
  return null;
}

export function prepareQuantumCatalog(
  snapshot: Readonly<ValidatedQuantumSnapshot>,
  importedAt: Date = new Date(),
): PreparedQuantumCatalog {
  const importedAtIso = importedAt.toISOString();
  const modelsByCode = new Map(snapshot.rows.models.map((model) => [model.model, model]));
  const routesByUuid = new Map(snapshot.rows.routes.map((route) => [route.uuid, route]));
  const diodesByModelAndUuid = new Map(
    snapshot.rows.diodes.map((diode) => [modelUuidKey(diode.model, diode.diodeUuid), diode]),
  );
  const lightsByRouteModel = groupRouteLights(snapshot.rows.routeLights);

  const layouts = snapshot.rows.models.map((model) => ({
    boardType: QUANTUM_BOARD_TYPE,
    id: model.layoutId,
    productId: QUANTUM_PRODUCT_ID,
    name: model.name,
    instagramCaption: null,
    isMirrored: false,
    isListed: true,
    password: null,
    createdAt: null,
  }));
  const productSizes = snapshot.rows.models.map((model, position) => ({
    boardType: QUANTUM_BOARD_TYPE,
    id: model.productSizeId,
    productId: QUANTUM_PRODUCT_ID,
    edgeLeft: scaleQuantumGeometryCoordinate(model.edgeLeft, `${model.model}.edgeLeft`),
    edgeRight: scaleQuantumGeometryCoordinate(model.edgeRight, `${model.model}.edgeRight`),
    edgeBottom: scaleQuantumGeometryCoordinate(model.edgeBottom, `${model.model}.edgeBottom`),
    edgeTop: scaleQuantumGeometryCoordinate(model.edgeTop, `${model.model}.edgeTop`),
    name: model.name,
    description: null,
    imageFilename: null,
    position,
    isListed: true,
  }));
  const productSizeLayoutSets = snapshot.rows.models.map((model) => ({
    boardType: QUANTUM_BOARD_TYPE,
    id: model.layoutId,
    productSizeId: model.productSizeId,
    layoutId: model.layoutId,
    setId: QUANTUM_SET_ID,
    imageFilename: null,
    isListed: true,
  }));
  const holes = snapshot.rows.diodes.map((diode) => {
    const model = requireModel(modelsByCode, diode.model);
    return {
      boardType: QUANTUM_BOARD_TYPE,
      id: quantumCanonicalPlacementId(model.layoutId, diode.placementId),
      productId: QUANTUM_PRODUCT_ID,
      name: diode.diodeUuid,
      x: scaleQuantumGeometryCoordinate(diode.x, `${diode.model}.${diode.diodeUuid}.x`),
      y: scaleQuantumGeometryCoordinate(diode.y, `${diode.model}.${diode.diodeUuid}.y`),
      mirroredHoleId: null,
      mirrorGroup: 0,
    };
  });
  const placements = snapshot.rows.diodes.map((diode) => {
    const model = requireModel(modelsByCode, diode.model);
    return {
      boardType: QUANTUM_BOARD_TYPE,
      id: quantumCanonicalPlacementId(model.layoutId, diode.placementId),
      layoutId: model.layoutId,
      holeId: quantumCanonicalPlacementId(model.layoutId, diode.placementId),
      setId: QUANTUM_SET_ID,
      defaultPlacementRoleId: QUANTUM_DEFAULT_ROLE_ID,
    };
  });
  const leds = snapshot.rows.diodes.map((diode) => {
    const model = requireModel(modelsByCode, diode.model);
    return {
      boardType: QUANTUM_BOARD_TYPE,
      id: quantumCanonicalPlacementId(model.layoutId, diode.placementId),
      productSizeId: model.productSizeId,
      holeId: quantumCanonicalPlacementId(model.layoutId, diode.placementId),
      position: diode.autocadId,
    };
  });

  const climbs: PreparedQuantumClimb[] = [];
  const holds: PreparedQuantumHold[] = [];
  const metadata: PreparedQuantumMetadata[] = [];
  const stats: PreparedQuantumStat[] = [];

  const routeModels = [...snapshot.rows.routeModels].sort((left, right) => left.appUuid.localeCompare(right.appUuid));
  for (const routeModel of routeModels) {
    const model = requireModel(modelsByCode, routeModel.model);
    const route = requireRoute(routesByUuid, routeModel.routeUuid);
    const routeLights = lightsByRouteModel.get(routeModelKey(routeModel.routeUuid, routeModel.model));
    if (!routeLights || routeLights.length === 0) {
      throw new Error(`Quantum route ${routeModel.routeUuid} has no lights for model ${routeModel.model}.`);
    }
    if (routeLights.length > QUANTUM_MAX_DIODES_PER_ROUTE) {
      throw new Error(`Quantum route ${routeModel.routeUuid} exceeds ${QUANTUM_MAX_DIODES_PER_ROUTE} lights.`);
    }

    const preparedLights = routeLights.map((light) => {
      const diode = diodesByModelAndUuid.get(modelUuidKey(routeModel.model, light.diodeUuid));
      if (!diode) {
        throw new Error(`Quantum route ${routeModel.routeUuid} references missing diode ${light.diodeUuid}.`);
      }
      return { diode, roleId: roleIdForSourceStep(light.step) };
    });
    const preparedHolds = preparedLights
      .map(
        ({ diode, roleId }): PreparedQuantumHold => ({
          boardType: QUANTUM_BOARD_TYPE,
          climbUuid: routeModel.appUuid,
          holdId: quantumCanonicalPlacementId(model.layoutId, diode.placementId),
          frameNumber: 0,
          holdState: holdStateForRoleId(roleId),
        }),
      )
      .sort((left, right) => left.holdId - right.holdId || left.holdState.localeCompare(right.holdState));
    const frames = preparedHolds.map((hold) => `p${hold.holdId}r${roleIdForHoldState(hold.holdState)}`).join('');
    const holdFingerprint = fingerprintFromHolds(preparedHolds);
    const characteristics = quantumCharacteristics(route);
    const sourceGradeIds = parseGradeIds(route.grade);
    const mappedGrade = mapQuantumGrade(route.grade);
    const createdAt = unixSecondsToIso(route.createdAt, `${route.uuid}.createdAt`);
    const upstreamQualityAverage = route.rating >= 0 && route.rating <= 5 ? route.rating : null;
    const routeXCoordinates = preparedLights.map(({ diode }) =>
      scaleQuantumGeometryCoordinate(diode.x, `${diode.model}.${diode.diodeUuid}.x`),
    );
    const routeYCoordinates = preparedLights.map(({ diode }) =>
      scaleQuantumGeometryCoordinate(diode.y, `${diode.model}.${diode.diodeUuid}.y`),
    );

    climbs.push({
      uuid: routeModel.appUuid,
      boardType: QUANTUM_BOARD_TYPE,
      layoutId: model.layoutId,
      setterId: null,
      setterUsername: route.setter || null,
      name: route.name,
      description: route.tips,
      hsm: null,
      edgeLeft: Math.min(...routeXCoordinates),
      edgeRight: Math.max(...routeXCoordinates),
      edgeBottom: Math.min(...routeYCoordinates),
      edgeTop: Math.max(...routeYCoordinates),
      angle: route.angle,
      framesCount: 1,
      framesPace: 0,
      frames,
      controllerRouteUuid: routeModel.routeUuid,
      isDraft: false,
      isListed: !route.disabled,
      createdAt,
      publishedAt: createdAt,
      synced: true,
      syncError: null,
      userId: null,
      requiredSetIds: [QUANTUM_SET_ID],
      compatibleSizeIds: [model.productSizeId],
      holdFingerprint,
      characteristics: characteristics.length > 0 ? characteristics : null,
    });
    holds.push(...preparedHolds);
    metadata.push({
      climbUuid: routeModel.appUuid,
      sourceGrade: sourceGradeIds?.length === 1 ? (sourceGradeIds[0] ?? null) : null,
      isStandard: route.standard,
      isCampusing: route.campusing,
      isEdge: route.edge,
      usesKickplate: route.kickplate,
      allowsMatching: route.matching,
      tags: parseQuantumTags(route.tags),
    });
    stats.push({
      boardType: QUANTUM_BOARD_TYPE,
      climbUuid: routeModel.appUuid,
      angle: route.angle,
      displayDifficulty: mappedGrade,
      difficultyAverage: mappedGrade,
      upstreamAscensionistCount: route.ascents,
      ascensionistCount: route.ascents,
      upstreamQualityAverage,
      qualityAverage: upstreamQualityAverage,
      qualityNormalized: true,
      upstreamSyncedAt: importedAtIso,
    });
  }

  return Object.freeze({
    hardwareFingerprint: computeQuantumHardwareFingerprint(snapshot.rows.models, snapshot.rows.diodes),
    grades: Object.freeze(
      BOULDER_GRADES.map((grade) => ({
        boardType: QUANTUM_BOARD_TYPE,
        difficulty: grade.difficulty_id,
        boulderName: grade.difficulty_name,
        routeName: null,
        isListed: true,
      })),
    ),
    products: Object.freeze([
      {
        boardType: QUANTUM_BOARD_TYPE,
        id: QUANTUM_PRODUCT_ID,
        name: 'Quantum Board',
        isListed: true,
        password: null,
        minCountInFrame: 1,
        maxCountInFrame: QUANTUM_MAX_DIODES_PER_ROUTE,
      },
    ]),
    sets: Object.freeze([{ boardType: QUANTUM_BOARD_TYPE, id: QUANTUM_SET_ID, name: 'Default', hsm: null }]),
    roles: QUANTUM_ROLE_ROWS,
    layouts: Object.freeze(layouts),
    productSizes: Object.freeze(productSizes),
    productSizeLayoutSets: Object.freeze(productSizeLayoutSets),
    holes: Object.freeze(holes),
    placements: Object.freeze(placements),
    leds: Object.freeze(leds),
    climbs: Object.freeze(climbs),
    holds: Object.freeze(holds),
    metadata: Object.freeze(metadata),
    stats: Object.freeze(stats),
  });
}

export function computeQuantumHardwareFingerprint(
  models: readonly Readonly<QuantumModelRow>[],
  diodes: readonly Readonly<QuantumDiodeRow>[],
): string {
  const canonicalModels = [...models]
    .sort((left, right) => left.model.localeCompare(right.model))
    .map((model) => [
      model.model,
      model.layoutId,
      model.productSizeId,
      model.name,
      model.columns,
      model.rows,
      model.forcedType,
      model.edgeLeft,
      model.edgeRight,
      model.edgeBottom,
      model.edgeTop,
    ]);
  const canonicalDiodes = [...diodes]
    .sort(
      (left, right) =>
        left.model.localeCompare(right.model) ||
        left.placementId - right.placementId ||
        left.diodeUuid.localeCompare(right.diodeUuid),
    )
    .map((diode) => [
      diode.model,
      diode.diodeUuid,
      diode.placementId,
      diode.ledNode,
      diode.autocadId,
      diode.holdType,
      diode.x,
      diode.y,
      diode.z,
    ]);
  return createHash('sha256')
    .update(JSON.stringify([canonicalModels, canonicalDiodes]))
    .digest('hex');
}

function parseGradeIds(rawGrade: string): readonly number[] | null {
  try {
    const parsed: unknown = JSON.parse(rawGrade);
    if (
      !Array.isArray(parsed) ||
      (parsed.length !== 1 && parsed.length !== 2) ||
      parsed.some((gradeId) => !Number.isSafeInteger(gradeId))
    ) {
      return null;
    }
    return parsed as number[];
  } catch {
    return null;
  }
}

function parseQuantumTags(rawTags: string): readonly string[] {
  if (!rawTags) return [];
  try {
    const parsed: unknown = JSON.parse(rawTags);
    if (!Array.isArray(parsed)) return [];
    const tags = parsed.filter((tag): tag is string => typeof tag === 'string' && tag.length > 0 && tag.length <= 256);
    return [...new Set(tags)].slice(0, 256);
  } catch {
    return [];
  }
}

function quantumCharacteristics(route: Readonly<QuantumRouteRow>): string[] {
  const characteristics: string[] = [];
  if (route.standard) characteristics.push(CLIMB_CHARACTERISTICS.QUANTUM_STANDARD);
  if (route.campusing) characteristics.push(CLIMB_CHARACTERISTICS.QUANTUM_CAMPUSING);
  if (route.edge) characteristics.push(CLIMB_CHARACTERISTICS.QUANTUM_EDGE);
  if (route.kickplate) characteristics.push(CLIMB_CHARACTERISTICS.QUANTUM_KICKPLATE);
  if (route.matching) characteristics.push(CLIMB_CHARACTERISTICS.QUANTUM_MATCHING);
  return characteristics;
}

function groupRouteLights(routeLights: readonly Readonly<QuantumRouteLightRow>[]): Map<string, QuantumRouteLightRow[]> {
  const grouped = new Map<string, QuantumRouteLightRow[]>();
  for (const routeLight of routeLights) {
    const key = routeModelKey(routeLight.routeUuid, routeLight.model);
    const existing = grouped.get(key);
    if (existing) existing.push(routeLight);
    else grouped.set(key, [routeLight]);
  }
  return grouped;
}

function routeModelKey(routeUuid: string, model: QuantumModelCode): string {
  return `${routeUuid}\0${model}`;
}

function modelUuidKey(model: QuantumModelCode, diodeUuid: string): string {
  return `${model}\0${diodeUuid}`;
}

function requireModel(
  modelsByCode: ReadonlyMap<QuantumModelCode, Readonly<QuantumModelRow>>,
  modelCode: QuantumModelCode,
): Readonly<QuantumModelRow> {
  const model = modelsByCode.get(modelCode);
  if (!model) throw new Error(`Quantum model ${modelCode} is missing.`);
  return model;
}

function requireRoute(
  routesByUuid: ReadonlyMap<string, Readonly<QuantumRouteRow>>,
  routeUuid: string,
): Readonly<QuantumRouteRow> {
  const route = routesByUuid.get(routeUuid);
  if (!route) throw new Error(`Quantum route ${routeUuid} is missing.`);
  return route;
}

function roleIdForHoldState(holdState: QuantumHoldState): 12 | 13 | 14 {
  if (holdState === 'STARTING') return 12;
  if (holdState === 'FINISH') return 14;
  return 13;
}

function roleIdForSourceStep(sourceStep: number): 12 | 13 | 14 {
  if (sourceStep === 1) return 12;
  if (sourceStep === 3) return 14;
  return 13;
}

function holdStateForRoleId(roleId: 12 | 13 | 14): QuantumHoldState {
  if (roleId === 12) return 'STARTING';
  if (roleId === 14) return 'FINISH';
  return 'HAND';
}

function fingerprintFromHolds(holds: readonly PreparedQuantumHold[]): string {
  const tuples = holds
    .map((hold) => `${hold.holdId}:${hold.holdState}:${hold.frameNumber}`)
    .sort()
    .join('|');
  return createHash('sha256').update(tuples).digest('hex');
}

export function scaleQuantumGeometryCoordinate(coordinate: number, label = 'coordinate'): number {
  return requirePostgresInteger(Math.trunc(coordinate * 1000), label);
}

export function quantumCanonicalPlacementId(layoutId: number, sourcePlacementId: number): number {
  if (!Number.isSafeInteger(layoutId) || layoutId < 9101 || layoutId > 9105) {
    throw new Error(`Quantum layout id ${layoutId} is outside the supported model range.`);
  }
  if (!Number.isSafeInteger(sourcePlacementId) || sourcePlacementId < 0 || sourcePlacementId >= 1_000_000) {
    throw new Error(`Quantum source placement id ${sourcePlacementId} must be between 0 and 999999.`);
  }
  return requirePostgresInteger((layoutId - 9100) * 1_000_000 + sourcePlacementId, 'placementId');
}

function requirePostgresInteger(integer: number, label: string): number {
  if (!Number.isSafeInteger(integer) || integer < POSTGRES_INTEGER_MIN || integer > POSTGRES_INTEGER_MAX) {
    throw new Error(`Quantum ${label} does not fit a PostgreSQL integer.`);
  }
  return integer;
}

function unixSecondsToIso(seconds: number, label: string): string {
  const date = new Date(seconds * 1000);
  if (!Number.isFinite(date.getTime())) throw new Error(`Quantum ${label} is outside the supported date range.`);
  return date.toISOString();
}
