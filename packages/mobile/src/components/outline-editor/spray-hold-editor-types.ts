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
 * Handed to the editor rather than fetched by it: detection runs on the device
 * (epic decision 2026-09-15 — trust the client's detections) and SW-06 owns
 * where. The editor's only opinion is that a candidate is drawn and never
 * written until somebody rules on it.
 */
export type SprayHoldCandidate = {
  cx: number;
  cy: number;
  r: number;
  /** Radius-unit ring, or null for a plain circle. */
  outline?: number[] | null;
  /** 0–1. Drives the threshold slider and the low-confidence styling. */
  confidence: number;
};

/** What one save actually applied, as the server counted it. */
export type SprayHoldSaveSummary = {
  written: number;
  removed: number;
};
