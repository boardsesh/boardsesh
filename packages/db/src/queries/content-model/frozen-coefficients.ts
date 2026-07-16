import type { GradeCoefficients } from '../grade-model';

export interface FrozenCoefficientRow {
  coeff_version: string;
  kind: string;
  key: string;
  payload: unknown;
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

  for (const row of rows) {
    if (row.kind === 'echo_fraction') {
      coefficients.echoFraction[row.key] = (row.payload as { lambda: number }).lambda;
    } else if (row.kind === 'sigma_within') {
      coefficients.sigmaWithin[row.key] = row.payload as GradeCoefficients['sigmaWithin'][string];
    } else if (row.kind === 'tau_squared') {
      coefficients.tauSquared[row.key] = row.payload as GradeCoefficients['tauSquared'][string];
    } else if (row.kind === 'angle_offset') {
      coefficients.angleOffset[row.key] = row.payload as GradeCoefficients['angleOffset'][string];
    } else if (row.kind === 'board_offset') {
      coefficients.boardOffset[row.key] = row.payload as GradeCoefficients['boardOffset'][string];
    } else if (row.kind === 'rater_model') {
      coefficients.raterModel[row.key] = row.payload as GradeCoefficients['raterModel'][string];
    } else if (row.kind === 'behavior_model') {
      coefficients.behaviorModel[row.key] = row.payload as GradeCoefficients['behaviorModel'][string];
    } else if (row.kind === 'bridge_readiness') {
      coefficients.bridgeReadiness[row.key] = row.payload as GradeCoefficients['bridgeReadiness'][string];
    }
  }

  return coefficients;
}
