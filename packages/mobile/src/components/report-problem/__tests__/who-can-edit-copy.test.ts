import { describe, expect, it } from 'vitest';
import { SYSTEM_BOARD_OWNER_ID } from '@boardsesh/shared-schema';
import { boardWhoCanEditBody, gymWhoCanEditBody } from '../who-can-edit-copy';

const t = (key: string, options?: Record<string, unknown>) => (options ? `${key}${JSON.stringify(options)}` : key);
const runByGym = { name: 'Crux', listingState: 'RUN_BY_GYM' as const };
const unclaimed = { name: 'Crux', listingState: 'UNCLAIMED' as const };

describe('who can edit a board', () => {
  it('names the creator, and the staff when the gym runs its page', () => {
    expect(boardWhoCanEditBody({ ownerId: 'sam', ownerDisplayName: 'Sam' }, runByGym, 'alex', t)).toBe(
      'whoCanEdit.boardCreator{"name":"Sam"} whoCanEdit.boardStaff{"gym":"Crux"}',
    );
    expect(boardWhoCanEditBody({ ownerId: 'sam', ownerDisplayName: 'Sam' }, unclaimed, 'alex', t)).toBe(
      'whoCanEdit.boardCreator{"name":"Sam"}',
    );
  });

  it('keeps a hidden creator unnamed', () => {
    expect(boardWhoCanEditBody({ ownerId: 'sam' }, null, 'alex', t)).toBe('whoCanEdit.boardCreatorHidden');
  });

  it('explains a synced board, pointing at the claim when nobody runs the gym', () => {
    expect(boardWhoCanEditBody({ ownerId: SYSTEM_BOARD_OWNER_ID }, unclaimed, 'alex', t)).toBe(
      'whoCanEdit.boardSynced{"gym":"Crux"}',
    );
    expect(boardWhoCanEditBody({ ownerId: SYSTEM_BOARD_OWNER_ID }, runByGym, 'alex', t)).toBe(
      'whoCanEdit.boardSyncedNoGym whoCanEdit.boardStaff{"gym":"Crux"}',
    );
    expect(boardWhoCanEditBody({ ownerId: SYSTEM_BOARD_OWNER_ID }, null, 'alex', t)).toBe(
      'whoCanEdit.boardSyncedNoGym',
    );
  });
});

describe('who can edit a gym', () => {
  it('says who runs it, and invites a claim when the viewer may', () => {
    expect(gymWhoCanEditBody({ ...runByGym, ownerDisplayName: null, canClaim: false }, t)).toBe(
      'whoCanEdit.gymStaff{"gym":"Crux"}',
    );
    expect(
      gymWhoCanEditBody({ name: 'Crux', listingState: 'CLIMBER_LISTED', ownerDisplayName: 'Sam', canClaim: true }, t),
    ).toBe('whoCanEdit.gymClimber{"name":"Sam"} whoCanEdit.claimHint');
    expect(
      gymWhoCanEditBody({ name: 'Crux', listingState: 'CLIMBER_LISTED', ownerDisplayName: null, canClaim: false }, t),
    ).toBe('whoCanEdit.gymClimberHidden');
    expect(gymWhoCanEditBody({ ...unclaimed, ownerDisplayName: null, canClaim: true }, t)).toBe(
      'whoCanEdit.gymUnclaimed whoCanEdit.claimHint',
    );
  });
});
