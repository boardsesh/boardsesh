import { describe, expect, it } from 'vitest';
import { SYNC_DAEMON_DISABLED_MESSAGE } from '@boardsesh/sync-runtime';
import { isOperatorLogLine } from './log-filter';

describe('isOperatorLogLine', () => {
  it('prints the daemon-disabled line the runner logs', () => {
    expect(isOperatorLogLine(`[SyncRunner] ${SYNC_DAEMON_DISABLED_MESSAGE}`)).toBe(true);
  });

  it('keeps the existing operator lines', () => {
    expect(isOperatorLogLine('[SyncRunner] Daemon started')).toBe(true);
    expect(isOperatorLogLine('[SyncRunner] CREDENTIAL QUARANTINED user-1/kilter')).toBe(true);
    expect(isOperatorLogLine('[SyncRunner] Sync health: 3 active')).toBe(true);
  });

  it('drops per-table chatter', () => {
    expect(isOperatorLogLine('[SyncRunner] Syncing table climbs page 3')).toBe(false);
  });
});
