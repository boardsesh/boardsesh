/**
 * Real climbs for the glow lab (`scripts/glow-lab.ts`), frozen from the dev DB
 * board catalogue (2026-08-31) so renders are reproducible without a database.
 *
 * All three set on the Kilter Homewall 10x12 (layout 8, size 25) — the glow
 * work's reference board: traced silhouettes cover it and the board art is
 * known-good. Chosen to stress different glow situations: a dense climb with
 * clustered same-colour hands (merge/seam behaviour), a sparse climb (isolated
 * lobes), and a chained column (seams along a line).
 */

export type GlowLabClimb = {
  /** `board_climbs.uuid` — provenance only, never queried at render time. */
  uuid: string;
  name: string;
  frames: string;
};

export const GLOW_LAB_BOARD = {
  boardName: 'kilter',
  layoutId: 8,
  sizeId: 25,
} as const;

export const GLOW_LAB_CLIMBS: GlowLabClimb[] = [
  {
    // The reference climb (owner's pick), 13 holds.
    uuid: '075022685EE543728865666B22F43576',
    name: 'Meadows Direct',
    frames: 'p4210r43p4244r43p4264r42p4268r43p4273r43p4321r45p4331r43p4337r43p4352r42p4502r44p4572r45p4656r45p4661r45',
  },
  {
    // Dense, 14 holds, several adjacent cyan hands — the metaball/seam fixture.
    uuid: 'A6E04278AE294E03AD9DD2A8E0CDE31F',
    name: 'Lightest Pair of Shorts',
    frames:
      'p4131r44p4156r43p4158r43p4189r44p4201r45p4214r43p4225r45p4272r43p4292r45p4296r43p4328r43p4352r42p4408r45p4412r42',
  },
  {
    // Sparse, 10 well-separated holds — isolated glow lobes, falloff reads clean.
    uuid: 'FC08DF05598B46BFB404BEDCA07685A2',
    name: 'Guessing Games',
    frames: 'p4123r42p4176r45p4238r42p4241r43p4264r45p4276r44p4301r43p4330r43p4354r45p4362r43',
  },
];
