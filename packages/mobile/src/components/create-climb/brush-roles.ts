import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { HOLD_STATE_MAP, STATE_TO_PRIMARY_CODE } from '@boardsesh/board-constants/hold-states';
import type { BoardName, HoldState } from '@boardsesh/shared-schema';

export type BrushRole = Extract<HoldState, 'STARTING' | 'HAND' | 'FINISH' | 'FOOT'> | 'OFF';

export const PAINT_ROLES: ReadonlyArray<Exclude<BrushRole, 'OFF'>> = ['STARTING', 'HAND', 'FINISH', 'FOOT'];

export const MOONBOARD_PAINT_ROLES: ReadonlyArray<Exclude<BrushRole, 'OFF'>> = ['STARTING', 'HAND', 'FINISH'];

export function getPaintRoles(boardName: BoardName): ReadonlyArray<Exclude<BrushRole, 'OFF'>> {
  const supportedRoles = STATE_TO_PRIMARY_CODE[boardName];
  return PAINT_ROLES.filter((role) => supportedRoles[role] !== undefined);
}

/**
 * Swatch colour for a role on a given board, taken from the board's canonical
 * role code. Falls back to a neutral grey when a board does not define the role.
 */
export function brushRoleColor(boardName: BoardName, role: Exclude<BrushRole, 'OFF'>): string {
  const code = STATE_TO_PRIMARY_CODE[boardName]?.[role];
  if (code === undefined) return '#8E8E93';
  const info = HOLD_STATE_MAP[boardName]?.[code];
  if (!info) return '#8E8E93';
  return info.displayColor || info.color;
}

/**
 * Localised labels for paint roles, built from static t() calls so the i18n
 * orphan checker can trace every key.
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
