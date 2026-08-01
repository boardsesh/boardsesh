import { describe, expect, it } from 'vitest';
import { shouldLogAuroraSyncMessage } from './log-filter';

describe('Aurora CLI non-verbose log filter', () => {
  it.each([
    '[aurora-sync] skipped foreign owner {"event":"aurora_circuit_playlist_refused"}',
    '[SyncRunner] User user-1: circuits not syncing — tension playlist ownership state is foreign',
    '[SyncRunner] CREDENTIAL FLAPPING user-1',
    '[SyncRunner] Sync health: active=1',
  ])('keeps operational warning %s', (message) => {
    expect(shouldLogAuroraSyncMessage(message)).toBe(true);
  });

  it('still suppresses ordinary progress chatter', () => {
    expect(shouldLogAuroraSyncMessage('Sync attempt 2 for user 144574')).toBe(false);
  });
});
