// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Boardsesh contributors

/**
 * Boulder-grade taxonomy: the static V ↔ Font mapping table.
 *
 * Owned by board-constants (zero deps) so display utilities can import it
 * without dragging the full @boardsesh/board-config module graph (board
 * image dimensions, set IDs, moonboard config, etc.) into the bundle.
 *
 * @boardsesh/board-config re-exports `BOULDER_GRADES` from here for
 * back-compat with existing call sites.
 */

export const BOULDER_GRADES = [
  { difficulty_id: 10, font_grade: '4a', v_grade: 'V0', difficulty_name: '4a/V0' },
  { difficulty_id: 11, font_grade: '4b', v_grade: 'V0', difficulty_name: '4b/V0' },
  { difficulty_id: 12, font_grade: '4c', v_grade: 'V0', difficulty_name: '4c/V0' },
  { difficulty_id: 13, font_grade: '5a', v_grade: 'V1', difficulty_name: '5a/V1' },
  { difficulty_id: 14, font_grade: '5b', v_grade: 'V1', difficulty_name: '5b/V1' },
  { difficulty_id: 15, font_grade: '5c', v_grade: 'V2', difficulty_name: '5c/V2' },
  { difficulty_id: 16, font_grade: '6a', v_grade: 'V3', difficulty_name: '6a/V3' },
  { difficulty_id: 17, font_grade: '6a+', v_grade: 'V3', difficulty_name: '6a+/V3' },
  { difficulty_id: 18, font_grade: '6b', v_grade: 'V4', difficulty_name: '6b/V4' },
  { difficulty_id: 19, font_grade: '6b+', v_grade: 'V4', difficulty_name: '6b+/V4' },
  { difficulty_id: 20, font_grade: '6c', v_grade: 'V5', difficulty_name: '6c/V5' },
  { difficulty_id: 21, font_grade: '6c+', v_grade: 'V5', difficulty_name: '6c+/V5' },
  { difficulty_id: 22, font_grade: '7a', v_grade: 'V6', difficulty_name: '7a/V6' },
  { difficulty_id: 23, font_grade: '7a+', v_grade: 'V7', difficulty_name: '7a+/V7' },
  { difficulty_id: 24, font_grade: '7b', v_grade: 'V8', difficulty_name: '7b/V8' },
  { difficulty_id: 25, font_grade: '7b+', v_grade: 'V8', difficulty_name: '7b+/V8' },
  { difficulty_id: 26, font_grade: '7c', v_grade: 'V9', difficulty_name: '7c/V9' },
  { difficulty_id: 27, font_grade: '7c+', v_grade: 'V10', difficulty_name: '7c+/V10' },
  { difficulty_id: 28, font_grade: '8a', v_grade: 'V11', difficulty_name: '8a/V11' },
  { difficulty_id: 29, font_grade: '8a+', v_grade: 'V12', difficulty_name: '8a+/V12' },
  { difficulty_id: 30, font_grade: '8b', v_grade: 'V13', difficulty_name: '8b/V13' },
  { difficulty_id: 31, font_grade: '8b+', v_grade: 'V14', difficulty_name: '8b+/V14' },
  { difficulty_id: 32, font_grade: '8c', v_grade: 'V15', difficulty_name: '8c/V15' },
  { difficulty_id: 33, font_grade: '8c+', v_grade: 'V16', difficulty_name: '8c+/V16' },
] as const;

export type BoulderGrade = (typeof BOULDER_GRADES)[number];
