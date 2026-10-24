import type { FilterToken } from './filter-tokens';
import type { LockedDimensions } from './dimension-chips';

/** Recovery can remove restrictions, but must not change ordering or board intent. */
export function getSearchRecoveryTokens(
  tokens: readonly FilterToken[],
  lockedDimensions: LockedDimensions,
): FilterToken[] {
  return tokens.filter((token) => {
    if (token.key === 'sort' || token.key === 'otherAngles' || token.key === 'climbType') return false;
    if (token.key === 'tall' && lockedDimensions.tall) return false;
    if (token.key === 'wide' && lockedDimensions.wide) return false;
    return true;
  });
}
