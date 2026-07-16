import {
  GRADE_BANDS,
  type BehaviorModelCoefficient,
  type BehaviorOutcomeBucket,
  type GradeBandKey,
  type GradeCoefficients,
  type MoonBridgeReadiness,
  type RaterModelCoefficient,
} from '../grade-model';
import { createRecordValidator, type RecordValidator } from './runtime-validation';

export interface FrozenCoefficientRow {
  coeff_version: string;
  kind: string;
  key: string;
  payload: unknown;
}

function coefficientError(row: FrozenCoefficientRow, message: string): Error {
  return new Error(`Invalid frozen coefficient ${row.kind}/${JSON.stringify(row.key)}: ${message}.`);
}

function coefficientValidator(row: FrozenCoefficientRow): RecordValidator {
  return createRecordValidator((message) => coefficientError(row, message));
}

function validateBoardIdentity(
  row: FrozenCoefficientRow,
  payload: Record<string, unknown>,
  validation: RecordValidator,
): string {
  const boardType = validation.nonEmptyString(payload, 'boardType');
  if (boardType !== row.key) {
    throw coefficientError(row, `payload boardType ${JSON.stringify(boardType)} does not match its key`);
  }
  return boardType;
}

function validateBandMap(row: FrozenCoefficientRow): Record<GradeBandKey, number> {
  const validation = coefficientValidator(row);
  const payload = validation.record(row.payload, 'payload must be a JSON object');
  const knownBands = new Set<string>(GRADE_BANDS.map((band) => band.key));
  const unknownBands = Object.keys(payload).filter((key) => !knownBands.has(key));
  if (unknownBands.length > 0) {
    throw coefficientError(row, `payload contains unknown grade bands: ${unknownBands.join(', ')}`);
  }
  return {
    'v0-2': validation.finiteNumber(payload, 'v0-2'),
    'v3-5': validation.finiteNumber(payload, 'v3-5'),
    'v6-8': validation.finiteNumber(payload, 'v6-8'),
    'v9+': validation.finiteNumber(payload, 'v9+'),
  };
}

function parseAngleBand(row: FrozenCoefficientRow, value: string): GradeBandKey | 'all' {
  if (value === 'all') return value;
  const band = GRADE_BANDS.find((candidate) => candidate.key === value);
  if (!band) throw coefficientError(row, `payload contains unknown angle band ${JSON.stringify(value)}`);
  return band.key;
}

function validateAngleOffset(row: FrozenCoefficientRow): GradeCoefficients['angleOffset'][string] {
  const validation = coefficientValidator(row);
  const payload = validation.record(row.payload, 'payload must be a JSON object');
  const result: GradeCoefficients['angleOffset'][string] = {};
  for (const [bandText, anglesValue] of Object.entries(payload)) {
    const band = parseAngleBand(row, bandText);
    const angles = validation.record(anglesValue, `${bandText} must be a JSON object`);
    const parsedAngles: Record<number, number> = {};
    for (const angleText of Object.keys(angles)) {
      const angle = Number(angleText);
      if (!Number.isInteger(angle)) {
        throw coefficientError(row, `${bandText}.${angleText} is not an integer angle`);
      }
      parsedAngles[angle] = validation.finiteNumber(angles, angleText);
    }
    result[band] = parsedAngles;
  }
  return result;
}

function validateBoardOffset(row: FrozenCoefficientRow): GradeCoefficients['boardOffset'][string] {
  const validation = coefficientValidator(row);
  const payload = validation.record(row.payload, 'payload must be a JSON object');
  return {
    offset: validation.finiteNumber(payload, 'offset'),
    sd: validation.finiteNumber(payload, 'sd'),
    users: validation.integer(payload, 'users'),
    looMaxDelta: validation.finiteNumber(payload, 'looMaxDelta'),
  };
}

function validateRaterModel(row: FrozenCoefficientRow): RaterModelCoefficient {
  const validation = coefficientValidator(row);
  const payload = validation.record(row.payload, 'payload must be a JSON object');
  const boardType = validateBoardIdentity(row, payload, validation);
  const rawBiases = validation.record(payload.biases, 'biases must be a JSON object');
  const biases: RaterModelCoefficient['biases'] = {};
  for (const [locationKey, rawBias] of Object.entries(rawBiases)) {
    const bias = validation.record(rawBias, `biases.${locationKey} must be a JSON object`);
    biases[locationKey] = {
      bias: validation.finiteNumber(bias, 'bias'),
      shrinkage: validation.finiteNumber(bias, 'shrinkage'),
      effectiveN: validation.finiteNumber(bias, 'effectiveN'),
      rawVotes: validation.integer(bias, 'rawVotes'),
      weightedResidual: validation.finiteNumber(bias, 'weightedResidual'),
    };
  }
  const summary = validation.record(payload.summary, 'summary must be a JSON object');
  return {
    boardType,
    biases,
    summary: {
      expressedVotes: validation.finiteNumber(summary, 'expressedVotes'),
      users: validation.integer(summary, 'users'),
      locations: validation.integer(summary, 'locations'),
      topUserShare: validation.finiteNumber(summary, 'topUserShare'),
    },
  };
}

function parseBehaviorBucket(row: FrozenCoefficientRow, value: string): BehaviorOutcomeBucket {
  switch (value) {
    case 'flash':
    case 'send_2_3':
    case 'send_4_plus':
    case 'attempt_1_3':
    case 'attempt_4_plus':
      return value;
    default:
      throw coefficientError(row, `payload contains unknown behavior bucket ${JSON.stringify(value)}`);
  }
}

function validateBehaviorModel(row: FrozenCoefficientRow): BehaviorModelCoefficient {
  const validation = coefficientValidator(row);
  const payload = validation.record(row.payload, 'payload must be a JSON object');
  const boardType = validateBoardIdentity(row, payload, validation);
  const rawOffsets = validation.record(payload.outcomeOffset, 'outcomeOffset must be a JSON object');
  const outcomeOffset: BehaviorModelCoefficient['outcomeOffset'] = {};
  for (const bucketText of Object.keys(rawOffsets)) {
    const bucket = parseBehaviorBucket(row, bucketText);
    outcomeOffset[bucket] = validation.finiteNumber(rawOffsets, bucketText);
  }
  const summary = validation.record(payload.summary, 'summary must be a JSON object');
  return {
    boardType,
    boardMean: validation.finiteNumber(payload, 'boardMean'),
    outcomeOffset,
    eligible: validation.boolean(payload, 'eligible'),
    summary: {
      users: validation.integer(summary, 'users'),
      outcomes: validation.integer(summary, 'outcomes'),
      topUserShare: validation.finiteNumber(summary, 'topUserShare'),
      usedUsers: validation.integer(summary, 'usedUsers'),
      usedOutcomes: validation.integer(summary, 'usedOutcomes'),
      usedTopUserShare: validation.finiteNumber(summary, 'usedTopUserShare'),
    },
  };
}

function validateBridgeReadiness(row: FrozenCoefficientRow): MoonBridgeReadiness {
  const validation = coefficientValidator(row);
  const payload = validation.record(row.payload, 'payload must be a JSON object');
  const boardType = validateBoardIdentity(row, payload, validation);
  if (boardType !== 'moonboard') {
    throw coefficientError(row, `bridge payload boardType must be "moonboard", received ${JSON.stringify(boardType)}`);
  }
  return {
    boardType,
    bridgeUsers: validation.integer(payload, 'bridgeUsers'),
    requiredUsers: validation.integer(payload, 'requiredUsers'),
    minSendsPerBoard: validation.integer(payload, 'minSendsPerBoard'),
    candidateOffset: validation.nullableFiniteNumber(payload, 'candidateOffset'),
    looMaxDelta: validation.nullableFiniteNumber(payload, 'looMaxDelta'),
    publishable: validation.boolean(payload, 'publishable'),
  };
}

/** Hydrate the persisted coefficient rows without refitting or mutating them. */
export function hydrateFrozenGradeCoefficients(rows: readonly FrozenCoefficientRow[]): GradeCoefficients | null {
  const coeffVersion = rows[0]?.coeff_version;
  if (!coeffVersion) return null;
  if (rows.some((row) => row.coeff_version !== coeffVersion)) {
    throw new Error('Cannot hydrate a mixed coefficient-version snapshot.');
  }

  const coefficients: GradeCoefficients = {
    coeffVersion,
    echoFraction: {},
    sigmaWithin: {},
    tauSquared: {},
    angleOffset: {},
    boardOffset: {},
    raterModel: {},
    behaviorModel: {},
    bridgeReadiness: {},
  };

  const seen = new Set<string>();
  for (const row of rows) {
    if (!row.key) throw coefficientError(row, 'key must be a non-empty string');
    const identity = `${row.kind}\u0000${row.key}`;
    if (seen.has(identity)) {
      throw coefficientError(row, 'snapshot contains a duplicate kind/key row');
    }
    seen.add(identity);

    switch (row.kind) {
      case 'echo_fraction': {
        const validation = coefficientValidator(row);
        const payload = validation.record(row.payload, 'payload must be a JSON object');
        coefficients.echoFraction[row.key] = validation.finiteNumber(payload, 'lambda');
        break;
      }
      case 'sigma_within':
        coefficients.sigmaWithin[row.key] = validateBandMap(row);
        break;
      case 'tau_squared':
        coefficients.tauSquared[row.key] = validateBandMap(row);
        break;
      case 'angle_offset':
        coefficients.angleOffset[row.key] = validateAngleOffset(row);
        break;
      case 'board_offset':
        coefficients.boardOffset[row.key] = validateBoardOffset(row);
        break;
      case 'rater_model':
        coefficients.raterModel[row.key] = validateRaterModel(row);
        break;
      case 'behavior_model':
        coefficients.behaviorModel[row.key] = validateBehaviorModel(row);
        break;
      case 'bridge_readiness':
        coefficients.bridgeReadiness[row.key] = validateBridgeReadiness(row);
        break;
      default:
        throw coefficientError(row, 'unknown coefficient kind');
    }
  }

  return coefficients;
}
