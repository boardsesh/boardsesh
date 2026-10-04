import { describe, expect, it } from 'vitest';
import { SYNC_DAEMON_DISABLED_MESSAGE } from '@boardsesh/sync-runtime';
import { isOperatorLogLine } from './log-filter';

describe('Aurora CLI non-verbose log filter', () => {
  it('prints the daemon-disabled line and existing operator lines', () => {
    expect(isOperatorLogLine(`[SyncRunner] ${SYNC_DAEMON_DISABLED_MESSAGE}`)).toBe(true);
    expect(isOperatorLogLine('[SyncRunner] Daemon started')).toBe(true);
    expect(isOperatorLogLine('[SyncRunner] CREDENTIAL QUARANTINED user-1/kilter')).toBe(true);
    expect(isOperatorLogLine('[SyncRunner] Sync health: 3 active')).toBe(true);
  });

  it.each([
    '[aurora-sync] skipped foreign owner {"event":"aurora_circuit_playlist_refused"}',
    '[SyncRunner] User user-1: circuits not syncing — tension playlist ownership state is foreign',
    '[SyncRunner] CREDENTIAL FLAPPING user-1',
    '[SyncRunner] Sync health: active=1',
  ])('keeps operational warning %s', (message) => {
    expect(isOperatorLogLine(message)).toBe(true);
  });

  it('drops progress chatter', () => {
    expect(isOperatorLogLine('[SyncRunner] Syncing table climbs page 3')).toBe(false);
    expect(isOperatorLogLine('Sync attempt 2 for user 144574')).toBe(false);
  });
});
