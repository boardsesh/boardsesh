import { describe, it, expect } from 'vitest';
import { DUPLICATE_BOARD_ACCOUNT_CIRCUITS_SYNC_ERROR } from '@boardsesh/shared-schema/sync-error-codes';
import { hasPendingAccountSync, resolveBoardAccountSyncState, type BoardAccountSyncInput } from '../index';

function credential(overrides: Partial<BoardAccountSyncInput> = {}): BoardAccountSyncInput {
  return { syncStatus: 'active', syncError: null, lastSyncAt: '2026-09-01T00:00:00.000Z', ...overrides };
}

describe('resolveBoardAccountSyncState', () => {
  it.each(['pending', 'active'])('reports an unsynced %s account as waiting for its first sync', (syncStatus) => {
    // The #4741 case: the card used to call this "Connected", so an app with no
    // ascents in it looked broken rather than pending.
    expect(resolveBoardAccountSyncState(credential({ syncStatus, lastSyncAt: null }))).toBe('firstSync');
  });

  it('reports a reconnected Kilter account as syncing despite a previous successful import', () => {
    expect(resolveBoardAccountSyncState(credential({ syncStatus: 'pending' }))).toBe('syncing');
  });

  it('reports an account that has synced at least once as connected', () => {
    expect(resolveBoardAccountSyncState(credential())).toBe('connected');
  });

  it('reports an orphan mapping (sync_status "linked") as not syncing', () => {
    // A user_board_mappings row with no aurora_credentials row behind it: the
    // sync daemon can never claim it, so "Connected" would be a lie no amount of
    // waiting fixes.
    expect(resolveBoardAccountSyncState(credential({ syncStatus: 'linked', lastSyncAt: null }))).toBe('notSyncing');
  });

  it('keeps expired ahead of every other state', () => {
    expect(resolveBoardAccountSyncState(credential({ syncStatus: 'expired', lastSyncAt: null }))).toBe('expired');
    expect(resolveBoardAccountSyncState(credential({ syncStatus: 'expired', syncError: 'token rejected' }))).toBe(
      'expired',
    );
  });

  it('treats an unrecognised sync_error as an error even on an active credential', () => {
    expect(resolveBoardAccountSyncState(credential({ syncError: 'Refresh token rejected by Keycloak' }))).toBe('error');
    expect(resolveBoardAccountSyncState(credential({ syncStatus: 'error', syncError: null }))).toBe('error');
  });

  it('leaves the duplicate-circuits warning as a healthy account (#3526)', () => {
    expect(resolveBoardAccountSyncState(credential({ syncError: DUPLICATE_BOARD_ACCOUNT_CIRCUITS_SYNC_ERROR }))).toBe(
      'connected',
    );
    // ...and it does not mask a genuinely pending first sync either.
    expect(
      resolveBoardAccountSyncState(
        credential({ syncError: DUPLICATE_BOARD_ACCOUNT_CIRCUITS_SYNC_ERROR, lastSyncAt: null }),
      ),
    ).toBe('firstSync');
  });
});

describe('hasPendingAccountSync', () => {
  it('is false with nothing linked, or with every account synced', () => {
    expect(hasPendingAccountSync(undefined)).toBe(false);
    expect(hasPendingAccountSync([])).toBe(false);
    expect(hasPendingAccountSync([credential(), credential()])).toBe(false);
  });

  it('is true while any one account is waiting for its first sync', () => {
    expect(hasPendingAccountSync([credential(), credential({ syncStatus: 'pending', lastSyncAt: null })])).toBe(true);
  });

  it('polls reconnects and recoverable errors, then stops once the retry succeeds', () => {
    expect(hasPendingAccountSync([credential({ syncStatus: 'pending' })])).toBe(true);
    expect(hasPendingAccountSync([credential({ syncStatus: 'error', syncError: 'service unavailable' })])).toBe(true);
    expect(hasPendingAccountSync([credential({ syncError: 'service unavailable' })])).toBe(true);
    expect(hasPendingAccountSync([credential()])).toBe(false);
  });

  it('does not poll for a duplicate-circuits warning after a successful sync', () => {
    expect(hasPendingAccountSync([credential({ syncError: DUPLICATE_BOARD_ACCOUNT_CIRCUITS_SYNC_ERROR })])).toBe(false);
  });

  it('does not poll for an orphan or expired link, which no amount of waiting fixes', () => {
    expect(hasPendingAccountSync([credential({ syncStatus: 'linked', lastSyncAt: null })])).toBe(false);
    expect(hasPendingAccountSync([credential({ syncStatus: 'expired', lastSyncAt: null })])).toBe(false);
  });
});
