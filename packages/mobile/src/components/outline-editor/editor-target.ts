/**
 * What the outline editor is pointed at, and what that lets it do.
 *
 * The editor started as one admin-only screen that corrected the tracer's work
 * on a catalogue board. SW-08 (#5441) points the same stroke → ring chain at a
 * spray wall, where the holds themselves are the thing being edited rather than
 * their silhouettes. Rather than fork the chain — which is the one thing
 * `docs/board-art-geometry.md` says must not happen, because a second polygon
 * editor is a second ring contract — the differences are named here, once, as
 * capabilities a target carries.
 *
 * Pure on purpose: the gate, the toolbar, the SVG layer and the write path all
 * branch on the SAME answer, and a capability computed twice in two components
 * is a capability that will disagree with itself.
 */

import type { BoardName, HoldOutlineKind } from '@boardsesh/shared-schema';

/** Every boundary kind the catalogue target can store. */
const CATALOGUE_OUTLINE_KINDS: readonly HoldOutlineKind[] = ['SILHOUETTE', 'LED_INNER'];

/**
 * A wall has no LEDs at all, so it has no LED base plate to annotate. Named as
 * its own constant rather than sliced out of the catalogue list so the two can
 * never drift into each other.
 */
const SPRAY_OUTLINE_KINDS: readonly HoldOutlineKind[] = ['SILHOUETTE'];

/**
 * One catalogue board config: the admin-only correction pass over what the
 * tracer produced. Writes `hold_outline_overrides`.
 */
export type CatalogueEditorTarget = {
  kind: 'catalogue';
  boardName: BoardName;
  layoutId: number;
  sizeId: number;
  /** The route's raw comma-separated set ids, as the board components take it. */
  setIds: string;
};

/**
 * One spray wall's DRAFT version: the owner placing, correcting and reviewing
 * the holds on their own wall. Writes `upsertSprayWallHolds` /
 * `removeSprayWallHolds`.
 */
export type SprayWallEditorTarget = {
  kind: 'sprayWall';
  wallUuid: string;
  /** The wall's board layout id. Also its size id, and the registry's key. */
  layoutId: number;
  /** `SprayWallVersion.id` of the draft. Published versions are immutable. */
  versionId: string;
  /** `SprayWall.viewerCanEdit` — editing follows ownership (epic decision 2026-09-15). */
  viewerCanEdit: boolean;
};

export type OutlineEditorTarget = CatalogueEditorTarget | SprayWallEditorTarget;

export type OutlineEditorCapabilities = {
  /** Boundary kinds the target can store. One entry hides the kind switcher. */
  outlineKinds: readonly HoldOutlineKind[];
  /**
   * Holds themselves can be added, moved, resized, deleted and merged. False on
   * the catalogue target: a board's placements are the manufacturer's, and the
   * editor only ever redraws the boundary around one.
   */
  canEditHolds: boolean;
  /** `source: 'auto'` holds can be accepted or rejected against a threshold. */
  canReviewCandidates: boolean;
  /**
   * The finger-draw toggle starts ON.
   *
   * The catalogue target stays stylus-only: an iPad and a Pencil remain the best
   * way to trace a silhouette, and a finger that draws cannot also pan a zoomed
   * board. A wall is corrected on a phone in a garage, where there is no Pencil
   * at all, so the same default there would leave the tools unreachable.
   */
  fingerDrawDefault: boolean;
  /**
   * Strings come from the i18n catalogs. The catalogue target keeps its
   * hardcoded admin-only English (the tester-screen convention); a wall owner is
   * an ordinary climber and gets their own language.
   */
  localized: boolean;
  /** Who may write. Admin for the catalogue, the wall's own edit rule for a wall. */
  accessRule: 'admin' | 'wallOwner';
};

const CATALOGUE_CAPABILITIES: OutlineEditorCapabilities = {
  outlineKinds: CATALOGUE_OUTLINE_KINDS,
  canEditHolds: false,
  canReviewCandidates: false,
  fingerDrawDefault: false,
  localized: false,
  accessRule: 'admin',
};

const SPRAY_CAPABILITIES: OutlineEditorCapabilities = {
  outlineKinds: SPRAY_OUTLINE_KINDS,
  canEditHolds: true,
  canReviewCandidates: true,
  fingerDrawDefault: true,
  localized: true,
  accessRule: 'wallOwner',
};

/** What this target lets the editor do. Frozen module constants — O(1), no allocation. */
export function editorTargetCapabilities(target: OutlineEditorTarget): OutlineEditorCapabilities {
  return target.kind === 'sprayWall' ? SPRAY_CAPABILITIES : CATALOGUE_CAPABILITIES;
}

/** Narrowing helper, so a component reads as a question rather than a string compare. */
export function isSprayWallTarget(target: OutlineEditorTarget): target is SprayWallEditorTarget {
  return target.kind === 'sprayWall';
}
