import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { HOLD_STATE_MAP, STATE_TO_PRIMARY_CODE } from '@boardsesh/board-constants/hold-states';
import type { BoardName, HoldState } from '@boardsesh/shared-schema';

// The four paintable roles plus the eraser. `'OFF'` clears a hold; the four
// named roles map straight onto the create-climb hold-state machine's
// `setHoldState(holdId, role)`.
export type BrushRole = Extract<HoldState, 'STARTING' | 'HAND' | 'FINISH' | 'FOOT'> | 'OFF';

export const PAINT_ROLES: ReadonlyArray<Exclude<BrushRole, 'OFF'>> = ['STARTING', 'HAND', 'FINISH', 'FOOT'];

// MoonBoard has no foot holds, so its editor only paints Start/Hand/Finish.
export const MOONBOARD_PAINT_ROLES: ReadonlyArray<Exclude<BrushRole, 'OFF'>> = ['STARTING', 'HAND', 'FINISH'];

export function getPaintRoles(boardName: BoardName): ReadonlyArray<Exclude<BrushRole, 'OFF'>> {
  const supportedRoles = STATE_TO_PRIMARY_CODE[boardName];
  return PAINT_ROLES.filter((role) => supportedRoles[role] !== undefined);
}

/**
 * The swatch colour for a role on a given board, taken from the board's
 * canonical role code (the same code the frame string and BLE encoder use).
 * Falls back to a neutral grey when a board doesn't define the role (e.g. a
 * Tycho-style colour-only product has no STARTING/FINISH) so the chip stays
 * visible rather than rendering an undefined colour.
 */
export function brushRoleColor(boardName: BoardName, role: Exclude<BrushRole, 'OFF'>): string {
  const code = STATE_TO_PRIMARY_CODE[boardName]?.[role];
  if (code === undefined) return '#8E8E93';
  const info = HOLD_STATE_MAP[boardName]?.[code];
  if (!info) return '#8E8E93';
  return info.displayColor || info.color;
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
