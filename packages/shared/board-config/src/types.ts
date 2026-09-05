// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Boardsesh contributors

import type { BoardName } from '@boardsesh/shared-schema';

export type Angle = number;
export type SetIdList = number[];

export type ClimbCompatibilityInput = {
  boardType?: string;
  layoutId?: number | null;
  frames: string | null | undefined;
  /**
   * `board_climbs.compatible_size_ids` — every board size the climb fits on.
   * Only consulted when the target names its own `size_id`; null/undefined (the
   * usual case for a climb that arrived over the queue wire) means "unknown"
   * and imposes no constraint.
   */
  compatibleSizeIds?: readonly number[] | null;
};

export type BoardCompatibilityTarget = {
  board_name: BoardName;
  layout_id: number;
  holdsData?: { id: number }[] | null;
  /**
   * The hold sets bolted onto the wall. Only consulted for MoonBoard, whose
   * `holdsData` is the full grid regardless of which add-on sets are installed
   * (see `getMoonBoardDetails`), so hold-id containment alone can't tell a
   * base-set climb from a wooden-set one. Omit it and the set check is skipped.
   */
  set_ids?: number[] | null;
  /**
   * The product size bolted on the wall. Paired with the climb's
   * `compatibleSizeIds` it separates two sizes that hold-id containment cannot:
   * Woods' 8x10 numbers its holds 0-484 and the 12x12 numbers its own 0-893, so
   * every 8x10 climb's ids exist on the 12x12 — as different holds. Omit it (or
   * the climb's sizes) and the size check is skipped.
   */
  size_id?: number | null;
};
