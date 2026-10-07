/**
 * The editor's public shapes, in a module with no React in it.
 *
 * Split out of the screen so the pure seeding rules (`spray-hold-seed.ts`) can
 * name a candidate without importing a file that pulls in react-native,
 * reanimated and the board surface — which would make the seam that decides
 * whether to throw away somebody's work untestable without mounting a board.
 */

/**
 * One detector candidate, in PHOTO pixels of the draft version's photo.
 *
 * Handed to the editor rather than fetched by it: the wizard owns the detection
 * job. The editor's opinion is only how confident a find must be to open ON.
 */
export type SprayHoldCandidate = {
  cx: number;
  cy: number;
  r: number;
  /** Radius-unit ring, or null for a plain circle. */
  outline?: number[] | null;
  /** 0–1. Decides whether the find opens ON, as a maybe, or not at all (`spray-hold-tools.ts`). */
  confidence: number;
  /**
   * The detection run this find came from, stamped where the run is read
   * (`SprayDetectionStep`). With `index`, it lets the training review (SW-20,
   * #5471) point a saved hold back at the exact suggestion it started as.
   */
  detectionId?: string;
  /**
   * The find's position in that run's FULL candidate list, before the seed
   * drops anything below the maybe floor. Never a loop counter downstream.
   */
  index?: number;
};

/** What one commit actually applied, as the server counted it. */
export type SprayHoldSaveSummary = {
  written: number;
  removed: number;
  /** Holds ON the wall once the commit landed — what Publish is about to publish. */
  holdCount: number;
};
