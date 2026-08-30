import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { HOLD_STATE_MAP, STATE_TO_PRIMARY_CODE } from '@boardsesh/board-constants/hold-states';
import type { BoardName, HoldState, LitUpHoldsMap } from '@boardsesh/shared-schema';
import { getEffectiveHoldRoleColor, type HoldColorOverrides } from '../../lib/hold-color-overrides';

// The four paintable roles plus the eraser. `'OFF'` clears a hold; the four
// named roles map straight onto the create-climb hold-state machine's
// `setHoldState(holdId, role)`.
export type BrushRole = Extract<HoldState, 'STARTING' | 'HAND' | 'FINISH' | 'FOOT'> | 'OFF';

export const PAINT_ROLES: ReadonlyArray<Exclude<BrushRole, 'OFF'>> = ['STARTING', 'HAND', 'FINISH', 'FOOT'];

// Optional-chained for the same reason as `brushRoleColor` below: callers read this
// during render (CreateDrawerActionBar, HoldRoleSheet), so an unknown `boardName`
// would throw where nothing can catch it. An unknown board paints no roles.
export function getPaintRoles(boardName: BoardName): ReadonlyArray<Exclude<BrushRole, 'OFF'>> {
  const supportedRoles = STATE_TO_PRIMARY_CODE[boardName];
  return PAINT_ROLES.filter((role) => supportedRoles?.[role] !== undefined);
}

/** Which paint roles currently have no room left, keyed by role (missing/false = open). */
export type RoleCapacity = Partial<Record<Exclude<BrushRole, 'OFF'>, boolean>>;

/**
 * Capacity for the tapped hold's own board, excluding the tapped hold itself
 * (it's about to be reassigned, so its current slot doesn't count against the
 * role it's leaving). STARTING and FINISH cap at 2; FOOT caps at 0 — no feet
 * allowed — while a "campus" climb is toggled on; HAND has no cap.
 */
export function computeRoleCapacity(litUpHoldsMap: LitUpHoldsMap, holdId: number, campus: boolean): RoleCapacity {
  let startingCount = 0;
  let finishCount = 0;
  for (const [id, hold] of Object.entries(litUpHoldsMap)) {
    if (Number(id) === holdId) continue;
    if (hold.state === 'STARTING') startingCount += 1;
    if (hold.state === 'FINISH') finishCount += 1;
  }
  return {
    STARTING: startingCount >= 2,
    FINISH: finishCount >= 2,
    FOOT: campus,
  };
}

/**
 * The role a tap should advance a hold to. Cycles through the board's paint
 * roles starting at the selected brush, then OFF, then back to the selected
 * brush — so tapping a hold repeatedly walks every role without needing the
 * long-press sheet. The eraser brush ('OFF' selected) skips the cycle and
 * always clears, matching its role as a dedicated erase tool rather than a
 * cycle anchor.
 *
 * `atCapacity` (from {@link computeRoleCapacity}) makes the cycle skip a role
 * that's already full — e.g. it never proposes a third start piece, and never
 * proposes a foot piece on a "campus" climb — landing on the next open role
 * instead. 'OFF' (no hold) never counts as full, so the loop always resolves
 * by the time it gets there; the trailing return only satisfies the compiler.
 */
export function getNextBrushRole(
  boardName: BoardName,
  currentState: HoldState | 'OFF',
  selectedBrush: BrushRole,
  atCapacity: RoleCapacity = {},
): BrushRole {
  if (selectedBrush === 'OFF') return 'OFF';
  const supportedRoles = getPaintRoles(boardName);
  if (supportedRoles.length === 0) return 'OFF';
  const startIndex = Math.max(supportedRoles.indexOf(selectedBrush), 0);
  const cycle: BrushRole[] = [...supportedRoles.slice(startIndex), ...supportedRoles.slice(0, startIndex), 'OFF'];
  const anchor = cycle.findIndex((role) => role === currentState);
  for (let step = 1; step <= cycle.length; step += 1) {
    const candidate = cycle[(anchor + step) % cycle.length];
    if (candidate === 'OFF' || !atCapacity[candidate]) return candidate;
  }
  // Unreachable: 'OFF' is always in `cycle` and never counts as full.
  return anchor === -1 ? cycle[0] : cycle[anchor];
}

/**
 * The swatch colour for a role on a given board, taken from the board's
 * canonical role code (the same code the frame string and BLE encoder use).
 * Falls back to a neutral grey when a board doesn't define the role (e.g. a
 * Tycho-style colour-only product has no STARTING/FINISH) so the chip stays
 * visible rather than rendering an undefined colour.
 */
export function brushRoleColor(
  boardName: BoardName,
  role: Exclude<BrushRole, 'OFF'>,
  overrides: HoldColorOverrides = {},
): string {
  const code = STATE_TO_PRIMARY_CODE[boardName]?.[role];
  if (code === undefined) return '#8E8E93';
  const info = HOLD_STATE_MAP[boardName]?.[code];
  if (!info) return '#8E8E93';
  return getEffectiveHoldRoleColor(boardName, role, overrides);
}

/**
 * Localised labels for the four paint roles, built from static `t()` calls so
 * the i18n orphan checker can trace every key (a `t(variable)` lookup is
 * lint-blocked). Shared by the brush bar and the long-press role sheet.
 */
export function useBrushRoleLabels(): Record<Exclude<BrushRole, 'OFF'>, string> {
  const { t } = useTranslation('climbs');
  return useMemo(
    () => ({
      STARTING: t('mobile.create.brush.start'),
      HAND: t('mobile.create.brush.hand'),
      FINISH: t('mobile.create.brush.finish'),
      FOOT: t('mobile.create.brush.foot'),
    }),
    [t],
  );
}
