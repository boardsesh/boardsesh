import { z } from 'zod';
import type { EwallsBootstrap, EwallsDelta, EwallsRecord } from '@boardsesh/quantum-sync';
import { BOULDER_GRADES } from '@boardsesh/board-constants/boulder-grade-mapping';
import {
  getQuantumBundledGeometry,
  getQuantumSourceDiodeBindings,
  QUANTUM_HARDWARE_FINGERPRINT,
  QUANTUM_LAYOUTS,
  QUANTUM_MODEL_BY_EWALLS_TYPE,
  QUANTUM_MODELS,
  QUANTUM_PRODUCT_SIZES,
  type QuantumModelName,
  type QuantumSourceDiodeBinding,
  type QuantumGeometryPlacement,
} from '@boardsesh/board-constants/quantum';
import { CLIMB_CHARACTERISTICS } from '@boardsesh/shared-schema';
import {
  fingerprintFromHolds,
  mapQuantumGrade,
  quantumCanonicalClimbUuid,
  QUANTUM_BOARD_TYPE,
  QUANTUM_DEFAULT_ROLE_ID,
  QUANTUM_MAX_DIODES_PER_ACTIVATION,
  QUANTUM_ROLE_ROWS,
  QUANTUM_SET_ID,
  type PreparedQuantumCatalog,
  type PreparedQuantumClimb,
  type PreparedQuantumHold,
  type PreparedQuantumStat,
} from './quantum-catalog-mapping';

type EwallsBoardType = keyof typeof QUANTUM_MODEL_BY_EWALLS_TYPE;
type Model = (typeof QUANTUM_MODELS)[QuantumModelName];
type BoundLight = Readonly<{ diode: QuantumSourceDiodeBinding; step: 1 | 2 | 3 }>;

// F18659 passes selected board first and route fit second to F8224. These are
// source compatibility rules, followed by exact immutable physical membership.
const FITS: Readonly<Record<EwallsBoardType, readonly EwallsBoardType[]>> = {
  big: ['big', 'medium', 'small'],
  medium: ['medium', 'small'],
  small: ['small'],
  xsmall: ['xsmall'],
  belay: ['belay'],
};
const SOURCE_FIELDS = [
  'id',
  'type',
  'minVariant',
  'grade',
  'angle',
  'rating',
  'ascents',
  'plays',
  'tags',
  'createdAt',
  'updatedAt',
  'publishedAt',
  'disabled',
  'edge',
  'kickplate',
  'standard',
  'matching',
  'campusing',
  'noEdge',
  'noKickplate',
  'noMatching',
] as const;
const ISO_TIMESTAMP = z.iso.datetime({ offset: true });
let fixedCatalog: Omit<PreparedQuantumCatalog, 'climbs' | 'aliases' | 'holds' | 'stats'> | null = null;
const physicalPositionsBySize = new Map<number, ReadonlyMap<number, QuantumGeometryPlacement>>();

function invalid(reason: string): never {
  throw new Error(`Invalid eWalls catalog: ${reason}`);
}

function record(input: unknown): EwallsRecord | null {
  return input !== null && typeof input === 'object' && !Array.isArray(input) ? (input as EwallsRecord) : null;
}

function uuid(input: unknown, label: string): string {
  if (typeof input !== 'string') return invalid(`${label} must be a binary route/diode UUID`);
  const compact = input.replaceAll('-', '');
  if (
    !/^[a-f0-9]{32}$/i.test(compact) ||
    !/^(?:[a-f0-9]{32}|[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})$/i.test(input)
  )
    return invalid(`${label} must be a binary route/diode UUID`);
  const hex = compact.toLowerCase();
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** UUID text normalization follows the binary encoder's 16-byte identity,
 * without inventing an RFC UUID version constraint the source does not impose. */
export function normalizeEwallsRouteId(raw: string): string {
  return uuid(raw, 'route.id');
}

function boardType(input: unknown): EwallsBoardType {
  if (typeof input !== 'string' || !Object.hasOwn(QUANTUM_MODEL_BY_EWALLS_TYPE, input))
    return invalid('unknown board type');
  return input as EwallsBoardType;
}

function numeric(input: unknown): number | null {
  if (typeof input === 'number') return Number.isFinite(input) ? input : null;
  if (typeof input !== 'string' || !/^-?\d+(?:\.\d+)?$/.test(input)) return null;
  const parsed = Number(input);
  return Number.isFinite(parsed) ? parsed : null;
}

function angle(input: unknown): number | null {
  const parsed = numeric(input);
  return parsed !== null && Number.isInteger(parsed) && parsed >= -90 && parsed <= 90 ? parsed : null;
}

function count(input: unknown): number | null {
  const parsed = numeric(input);
  return parsed !== null && Number.isSafeInteger(parsed) && parsed >= 0 && parsed <= 2_147_483_647 ? parsed : null;
}

function timestamp(input: unknown): string | null {
  if (typeof input !== 'string' || !ISO_TIMESTAMP.safeParse(input).success) return null;
  const parsed = new Date(input);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
}

function flag(input: unknown): boolean | null {
  if (input === true || input === 1) return true;
  if (input === false || input === 0) return false;
  return null;
}

function text(input: unknown): string | null {
  return typeof input === 'string' && input.trim().length > 0 ? input : null;
}

function familyBindings(model: Model): readonly QuantumSourceDiodeBinding[] {
  const largestSize = model.layoutId === 9101 ? QUANTUM_MODELS.xl.sizeId : model.sizeId;
  return getQuantumSourceDiodeBindings(model.layoutId, largestSize) ?? invalid('missing fixed source bindings');
}

function physicalPositions(model: Model): ReadonlyMap<number, QuantumGeometryPlacement> {
  const cached = physicalPositionsBySize.get(model.sizeId);
  if (cached) return cached;
  const geometry = getQuantumBundledGeometry(model.layoutId, model.sizeId) ?? invalid('missing fixed geometry');
  const positions = new Map(geometry.placements.map((placement) => [placement.placementId, placement]));
  physicalPositionsBySize.set(model.sizeId, positions);
  return positions;
}

function verifyDiodes(
  rows: readonly EwallsRecord[],
  bindings: readonly QuantumSourceDiodeBinding[],
): ReadonlyMap<string, QuantumSourceDiodeBinding> {
  const known = new Map(bindings.map((binding) => [binding.diodeUuid, binding]));
  const accepted = new Map<string, QuantumSourceDiodeBinding>();
  for (const row of rows) {
    const id = uuid(row.id, 'diode.id');
    const binding = known.get(id);
    if (!binding) return invalid('diode UUID does not belong to the fixed physical family');
    if (accepted.has(id)) return invalid('duplicate diode UUID');
    if (numeric(row.autocadId) !== binding.autocadId) return invalid('diode UUID/wire address remap');
    for (const key of ['x', 'y', 'z'] as const) {
      if (row[key] !== undefined && numeric(row[key]) !== binding[key]) return invalid(`diode ${key} changed`);
    }
    if (row.idLedNode !== undefined && row.idLedNode !== binding.idLedNode) return invalid('diode LED node changed');
    if (row.type !== undefined && row.type !== binding.type) return invalid('diode type changed');
    accepted.set(id, binding);
  }
  return accepted;
}

function lights(route: EwallsRecord, diodes: ReadonlyMap<string, QuantumSourceDiodeBinding>): readonly BoundLight[] {
  if (!Array.isArray(route.lights) || route.lights.length === 0) return invalid('route has no lights');
  const used = new Set<string>();
  return route.lights.map((input: unknown) => {
    const light = record(input) ?? invalid('light must be an association record');
    const id = uuid(record(light.diode)?.id ?? light.diodeId ?? light.id, 'light diode identity');
    if (used.has(id)) return invalid('duplicate route diode association');
    used.add(id);
    const diode = diodes.get(id) ?? invalid('light diode has no verified source binding');
    if (light.step !== 1 && light.step !== 2 && light.step !== 3) return invalid('unknown or missing light step');
    return { diode, step: light.step };
  });
}

function characteristics(route: EwallsRecord): readonly string[] {
  const entries = [
    ['standard', CLIMB_CHARACTERISTICS.QUANTUM_STANDARD],
    ['campusing', CLIMB_CHARACTERISTICS.QUANTUM_CAMPUSING],
    ['edge', CLIMB_CHARACTERISTICS.QUANTUM_EDGE],
    ['kickplate', CLIMB_CHARACTERISTICS.QUANTUM_KICKPLATE],
    ['matching', CLIMB_CHARACTERISTICS.QUANTUM_MATCHING],
  ] as const;
  return entries.flatMap(([key, characteristic]) => (flag(route[key]) === true ? [characteristic] : []));
}

function sourceMetadata(route: EwallsRecord): Readonly<Record<string, unknown>> {
  // Never spread an enriched API/UI record: userAscents, logged, favourites,
  // projects, activatedBy and user/profile payloads belong to account scope.
  const fields = Object.fromEntries(
    SOURCE_FIELDS.filter((key) => {
      const sourceField = route[key];
      if (sourceField === undefined) return false;
      // These fields are scalar aggregates in the native cache mapper. An
      // enriched ascent/profile collection is not public aggregate metadata.
      return !['ascents', 'plays', 'rating'].includes(key) || sourceField === null || typeof sourceField !== 'object';
    }).map((key) => [key, route[key]]),
  );
  return Object.freeze(JSON.parse(JSON.stringify({ provider: 'ewalls', ...fields })) as Record<string, unknown>);
}

function referenceCatalog(): NonNullable<typeof fixedCatalog> {
  if (fixedCatalog) return fixedCatalog;
  const holes = new Map<number, PreparedQuantumCatalog['holes'][number]>();
  const placements = new Map<number, PreparedQuantumCatalog['placements'][number]>();
  const leds: PreparedQuantumCatalog['leds'][number][] = [];
  for (const model of Object.values(QUANTUM_MODELS)) {
    const geometry = getQuantumBundledGeometry(model.layoutId, model.sizeId) ?? invalid('missing fixed geometry');
    const productId = QUANTUM_LAYOUTS[model.layoutId]!.productId;
    const bindings = new Map(
      getQuantumSourceDiodeBindings(model.layoutId, model.sizeId)!.map((diode) => [diode.placementId, diode]),
    );
    for (const placement of geometry.placements) {
      holes.set(placement.placementId, {
        boardType: QUANTUM_BOARD_TYPE,
        id: placement.placementId,
        productId,
        name: bindings.get(placement.placementId)!.diodeUuid,
        x: placement.x,
        y: placement.y,
        mirroredHoleId: null,
        mirrorGroup: 0,
      });
      placements.set(placement.placementId, {
        boardType: QUANTUM_BOARD_TYPE,
        id: placement.placementId,
        layoutId: model.layoutId,
        holeId: placement.placementId,
        setId: QUANTUM_SET_ID,
        defaultPlacementRoleId: QUANTUM_DEFAULT_ROLE_ID,
      });
      leds.push({
        boardType: QUANTUM_BOARD_TYPE,
        id: (model.sizeId - 9200) * 1_000_000 + (placement.placementId % 1_000_000),
        productSizeId: model.sizeId,
        holeId: placement.placementId,
        position: placement.ledPosition,
      });
    }
  }
  fixedCatalog = Object.freeze({
    hardwareFingerprint: QUANTUM_HARDWARE_FINGERPRINT,
    grades: Object.freeze(
      BOULDER_GRADES.map((grade) => ({
        boardType: QUANTUM_BOARD_TYPE,
        difficulty: grade.difficulty_id,
        boulderName: grade.difficulty_name,
        routeName: null,
        isListed: true,
      })),
    ),
    products: Object.freeze(
      [91, 94, 95].map((id) => ({
        boardType: QUANTUM_BOARD_TYPE,
        id,
        name: id === 91 ? 'Quantum Board' : id === 94 ? 'Quantum S Fitness' : 'Quantum Belay Board',
        isListed: true,
        password: null,
        minCountInFrame: 1,
        maxCountInFrame: QUANTUM_MAX_DIODES_PER_ACTIVATION,
      })),
    ),
    sets: Object.freeze([{ boardType: QUANTUM_BOARD_TYPE, id: QUANTUM_SET_ID, name: 'Default', hsm: null }]),
    roles: QUANTUM_ROLE_ROWS,
    layouts: Object.freeze(
      Object.values(QUANTUM_LAYOUTS).map((layout) => ({
        boardType: QUANTUM_BOARD_TYPE,
        ...layout,
        instagramCaption: null,
        isMirrored: false,
        isListed: true,
        password: null,
        createdAt: null,
      })),
    ),
    productSizes: Object.freeze(
      Object.values(QUANTUM_PRODUCT_SIZES).map((size, position) => ({
        boardType: QUANTUM_BOARD_TYPE,
        ...size,
        imageFilename: null,
        position,
        isListed: true,
      })),
    ),
    productSizeLayoutSets: Object.freeze(
      Object.values(QUANTUM_MODELS).map((model) => ({
        boardType: QUANTUM_BOARD_TYPE,
        id: model.sizeId,
        productSizeId: model.sizeId,
        layoutId: model.layoutId,
        setId: QUANTUM_SET_ID,
        imageFilename: null,
        isListed: true,
      })),
    ),
    holes: Object.freeze([...holes.values()]),
    placements: Object.freeze([...placements.values()]),
    leds: Object.freeze(leds),
  });
  return fixedCatalog;
}

/** Pure preparation only. Authentication and permission to publish this scope
 * are caller obligations; account collections never enter the public catalog. */
export function prepareEwallsCatalog(
  batch: EwallsBootstrap | EwallsDelta,
  priorDiodes: readonly EwallsRecord[] = [],
  now: Date = new Date(),
): Readonly<{ catalog: PreparedQuantumCatalog; diodes: readonly EwallsRecord[]; upstreamRouteIds: readonly string[] }> {
  const selectedModel = QUANTUM_MODELS[QUANTUM_MODEL_BY_EWALLS_TYPE[boardType(batch.scope.forcedType)]];
  const diodes = batch.diodes?.length ? batch.diodes : priorDiodes;
  const verifiedDiodes = verifyDiodes(diodes, familyBindings(selectedModel));
  const climbs: PreparedQuantumClimb[] = [];
  const holds: PreparedQuantumHold[] = [];
  const stats: PreparedQuantumStat[] = [];
  const aliases = new Map<string, string>();
  const upstreamRouteIds: string[] = [];
  const seenRoutes = new Set<string>();
  const syncedAt = now.toISOString();
  for (const route of batch.routes.upsert) {
    const routeId = normalizeEwallsRouteId(route.id);
    if (seenRoutes.has(routeId)) return invalid('duplicate route UUID');
    seenRoutes.add(routeId);
    upstreamRouteIds.push(routeId);
    const fit = boardType(route.minVariant || route.type);
    const routeModel = QUANTUM_MODELS[QUANTUM_MODEL_BY_EWALLS_TYPE[fit]];
    if (routeModel.layoutId !== selectedModel.layoutId) return invalid('route belongs to another physical family');
    const boundLights = lights(route, verifiedDiodes);
    const compatibleSizeIds = Object.entries(QUANTUM_MODEL_BY_EWALLS_TYPE)
      .flatMap(([type, modelName]) => {
        if (!FITS[type as EwallsBoardType].includes(fit)) return [];
        const model = QUANTUM_MODELS[modelName];
        const members = physicalPositions(model);
        return boundLights.every((light) => members.has(light.diode.placementId)) ? [model.sizeId] : [];
      })
      .sort((first, second) => first - second);
    if (compatibleSizeIds.length === 0) return invalid('route does not fit any supported physical size');
    const climbUuid = quantumCanonicalClimbUuid(routeModel.layoutId, routeId);
    const preparedHolds = boundLights
      .map(({ diode, step }): PreparedQuantumHold => ({
        boardType: QUANTUM_BOARD_TYPE,
        climbUuid,
        holdId: diode.placementId,
        frameNumber: 0,
        holdState: step === 1 ? 'STARTING' : step === 2 ? 'HAND' : 'FINISH',
      }))
      .sort((first, second) => first.holdId - second.holdId);
    const positions = physicalPositions(
      Object.values(QUANTUM_MODELS).find((model) => model.sizeId === compatibleSizeIds[0])!,
    );
    const coordinates = preparedHolds.map((hold) => positions.get(hold.holdId)!);
    const routeAngle = angle(route.angle);
    const setter = record(route.routeSetter);
    const setterName = setter ? [text(setter.firstName), text(setter.lastName)].filter(Boolean).join(' ') : '';
    const name = text(route.name) ?? invalid('route.name is missing');
    climbs.push({
      uuid: climbUuid,
      boardType: QUANTUM_BOARD_TYPE,
      layoutId: routeModel.layoutId,
      setterId: null,
      setterUsername: setterName || null,
      name,
      description: text(route.tips) ?? '',
      hsm: null,
      edgeLeft: Math.min(...coordinates.map((position) => position.x)),
      edgeRight: Math.max(...coordinates.map((position) => position.x)),
      edgeBottom: Math.min(...coordinates.map((position) => position.y)),
      edgeTop: Math.max(...coordinates.map((position) => position.y)),
      angle: routeAngle,
      framesCount: 1,
      framesPace: 0,
      frames: preparedHolds
        .map((hold) => `p${hold.holdId}r${hold.holdState === 'STARTING' ? 12 : hold.holdState === 'HAND' ? 13 : 14}`)
        .join(''),
      controllerRouteUuid: routeId,
      isDraft: false,
      isListed: flag(route.disabled) === false,
      createdAt: timestamp(route.createdAt),
      publishedAt: timestamp(route.publishedAt),
      synced: true,
      syncError: null,
      userId: null,
      requiredSetIds: [QUANTUM_SET_ID],
      compatibleSizeIds,
      holdFingerprint: fingerprintFromHolds(preparedHolds),
      characteristics: characteristics(route),
      sourceMetadata: sourceMetadata(route),
    });
    holds.push(...preparedHolds);
    for (const aliasUuid of [climbUuid, routeId]) {
      const existingCanonical = aliases.get(aliasUuid);
      if (existingCanonical !== undefined && existingCanonical !== climbUuid)
        return invalid('route alias names multiple canonical climbs');
      aliases.set(aliasUuid, climbUuid);
    }
    if (routeAngle !== null) {
      const grade =
        typeof route.grade === 'string' ? route.grade : Array.isArray(route.grade) ? JSON.stringify(route.grade) : '';
      const difficulty = mapQuantumGrade(grade);
      const rating = numeric(route.rating);
      const quality = rating !== null && rating >= 0 && rating <= 5 ? rating : null;
      stats.push({
        boardType: QUANTUM_BOARD_TYPE,
        climbUuid,
        angle: routeAngle,
        displayDifficulty: difficulty,
        difficultyAverage: difficulty,
        upstreamAscensionistCount: count(route.ascents),
        ascensionistCount: count(route.ascents),
        upstreamQualityAverage: quality,
        qualityAverage: quality,
        qualityNormalized: true,
        upstreamSyncedAt: syncedAt,
      });
    }
  }
  return Object.freeze({
    catalog: Object.freeze({
      ...referenceCatalog(),
      climbs: Object.freeze(climbs),
      holds: Object.freeze(holds),
      stats: Object.freeze(stats),
      aliases: Object.freeze([...aliases].map(([aliasUuid, canonicalUuid]) => ({ aliasUuid, canonicalUuid }))),
    }),
    diodes: Object.freeze([...diodes]),
    upstreamRouteIds: Object.freeze(upstreamRouteIds),
  });
}
