// The busy-wall question (#7017): someone else put a climb up while this
// climber looked around, so the next tap would replace theirs. The header's
// caption says what happened ("Test2 just put up Crimp Ladder") and the wall
// button's row becomes a pair in the wall-button family:
//
//   [ (T)  Keep Test2's ]  [ 💡  Put mine up ]      side by side
//   [ 💡       Put mine up                    ]      stacked, when either label
//   [ (T)      Keep Test2's                   ]      won't fit in half the row
//
// Put mine up is the primary: it confirms the tap the climber just made.
//
// This file is the rule: who to name, the labels, when a tap counts, and when the pair stacks. The view (`BusyWallQuestionGroup`)
// only draws it; the handler (`use-busy-wall-question`) runs the taps.

import type { QueueItemUser } from '@boardsesh/queue';
import type { WallControlFace } from './wall-control';

export type BusyWallSegmentId = 'keep' | 'put';

/**
 * Taps on either segment are dropped this long after the question appears. The
 * question arrives under a thumb already moving toward the wall button that
 * armed it, so the first tap after a wall change is the old intent, not an answer.
 */
export const BUSY_WALL_TAP_DEBOUNCE_MS = 500;

/**
 * Who put the lit climb up: the crew's current climb records who picked it.
 * Not the board-presence driver, which is whoever's phone holds Bluetooth (in a
 * crew, often you). Unknown, you, or a current climb that isn't the lit one:
 * null, which reads "Someone".
 */
export function resolveBusyWallHolder({
  picker,
  viewerUserId,
  wallClimbUuid,
  currentClimbUuid,
}: {
  picker: QueueItemUser | null;
  /** Null while signed out or the profile loads: never read as somebody else, it could be you. */
  viewerUserId: string | null;
  wallClimbUuid: string | null;
  currentClimbUuid: string | null;
}): WallControlFace | null {
  if (picker === null || viewerUserId === null || picker.id === viewerUserId) return null;
  if (wallClimbUuid === null || currentClimbUuid !== wallClimbUuid) return null;
  return { name: picker.username, avatarUrl: picker.avatarUrl ?? null };
}

export type BusyWallQuestionInput = {
  /** Who put the lit climb up (`resolveBusyWallHolder`), or null for "Someone". */
  holder: WallControlFace | null;
  /** The lit climb, named in the caption. */
  wallClimbName: string | null;
  /** This phone holds the board: Put mine up's bulb is filled, as the wall button's is. */
  selfHoldsBoard: boolean;
  /** The question has been up for `BUSY_WALL_TAP_DEBOUNCE_MS`: taps count. */
  ready: boolean;
};

export type BusyWallQuestionModel = {
  /** The holder's name, or null for "Someone". */
  holderName: string | null;
  /** The face on Keep's leading edge, or null for none. */
  holderFace: WallControlFace | null;
  wallClimbName: string;
  /** Put mine up's bulb: filled amber while this phone holds the board. */
  putBulbFilled: boolean;
  /** False for the first `BUSY_WALL_TAP_DEBOUNCE_MS`: both segments read disabled and drop taps. */
  ready: boolean;
};

/** The one rule behind every view of the busy-wall question, in both Board control modes. */
export function resolveBusyWallQuestion({
  holder,
  wallClimbName,
  selfHoldsBoard,
  ready,
}: BusyWallQuestionInput): BusyWallQuestionModel {
  const holderName = holder?.name?.trim() ? holder.name.trim() : null;
  return {
    holderName,
    holderFace: holder,
    wallClimbName: wallClimbName?.trim() ?? '',
    putBulbFilled: selfHoldsBoard,
    ready,
  };
}

/** The segments left to right, and top to bottom once stacked (Put mine up on top). */
export const BUSY_WALL_ROW_ORDER: readonly [BusyWallSegmentId, BusyWallSegmentId] = ['keep', 'put'];
export const BUSY_WALL_STACK_ORDER: readonly [BusyWallSegmentId, BusyWallSegmentId] = ['put', 'keep'];

/** The gap between the two segments, side by side or stacked. */
export const BUSY_WALL_SEGMENT_GAP = 8;
/** A segment's own padding at each end. */
export const BUSY_WALL_SEGMENT_PADDING = 12;
/** The leading glyph's slot (the bulb, or the holder's face). */
export const BUSY_WALL_SEGMENT_EDGE = 24;
/** Between the leading glyph and the label. */
export const BUSY_WALL_SEGMENT_INNER_GAP = 8;
/** Everything in a segment that isn't its label. */
const SEGMENT_CHROME = BUSY_WALL_SEGMENT_PADDING * 2 + BUSY_WALL_SEGMENT_EDGE + BUSY_WALL_SEGMENT_INNER_GAP;

export type BusyWallFitInput = {
  /** The row's width, inside its gutters. Null before it has laid out. */
  rowWidth: number | null;
  /** Each label's one-line width at the current text size. Null until measured. */
  putLabelWidth: number | null;
  keepLabelWidth: number | null;
  keepShortLabelWidth: number | null;
};

export type BusyWallFit = {
  /** Two full-width segments, Put mine up on top. */
  stacked: boolean;
  /** "Keep Test2's", or "Keep theirs" where the name won't fit. */
  keepLabel: 'full' | 'short';
};

/**
 * How the pair fits: side by side with the named Keep where it fits, "Keep
 * theirs" where the name doesn't, and stacked full width where even that or
 * Put mine up won't fit in half the row (large Dynamic Type, German). Before
 * the row and labels measure, side by side with the name.
 */
export function resolveBusyWallFit({
  rowWidth,
  putLabelWidth,
  keepLabelWidth,
  keepShortLabelWidth,
}: BusyWallFitInput): BusyWallFit {
  if (rowWidth === null || putLabelWidth === null || keepLabelWidth === null || keepShortLabelWidth === null) {
    return { stacked: false, keepLabel: 'full' };
  }
  const halfLabelRoom = (rowWidth - BUSY_WALL_SEGMENT_GAP) / 2 - SEGMENT_CHROME;
  const fullLabelRoom = rowWidth - SEGMENT_CHROME;
  if (putLabelWidth <= halfLabelRoom) {
    if (keepLabelWidth <= halfLabelRoom) return { stacked: false, keepLabel: 'full' };
    if (keepShortLabelWidth <= halfLabelRoom) return { stacked: false, keepLabel: 'short' };
  }
  return { stacked: true, keepLabel: keepLabelWidth <= fullLabelRoom ? 'full' : 'short' };
}
