import { describe, expect, it } from 'vitest';
import { deriveLocalOnly, pickerNoticeKey } from '../local-only';

describe('deriveLocalOnly', () => {
  it('falls back to downloaded boards whenever nothing is reachable', () => {
    expect(deriveLocalOnly({ effectiveOffline: true, isError: false, myBoardsCount: 0 })).toBe(true);
  });

  it('falls back on the lying connection — online, every request failing, nothing cached', () => {
    // Captive portal or gym wifi with a dead upstream: the phone reports a
    // working network, so retries never pause and the query really errors.
    expect(deriveLocalOnly({ effectiveOffline: false, isError: true, myBoardsCount: 0 })).toBe(true);
  });

  it('keeps the online screen when an error still has a cached list to show', () => {
    expect(deriveLocalOnly({ effectiveOffline: false, isError: true, myBoardsCount: 3 })).toBe(false);
  });

  it('keeps the online screen when everything is fine', () => {
    expect(deriveLocalOnly({ effectiveOffline: false, isError: false, myBoardsCount: 0 })).toBe(false);
  });

  it('still falls back offline even with a cached list — those boards need a connection to act on', () => {
    expect(deriveLocalOnly({ effectiveOffline: true, isError: false, myBoardsCount: 3 })).toBe(true);
  });
});

describe('pickerNoticeKey', () => {
  it('says "no signal" only when the phone is the thing that is down', () => {
    expect(pickerNoticeKey({ reason: 'device_offline', isError: false })).toBe('pickerNotice');
  });

  it('blames our server when the backend is unreachable', () => {
    // The #4862 bug: full bars, our outage, and the app told the climber they
    // had no signal.
    expect(pickerNoticeKey({ reason: 'backend_unreachable', isError: false })).toBe('pickerNoticeUnreachable');
  });

  it('names Offline mode when the climber flipped the switch themselves', () => {
    expect(pickerNoticeKey({ reason: 'offline_mode', isError: false })).toBe('pickerNoticeOfflineMode');
  });

  it('reads the lying connection as unreachable — it has bars and a dead request', () => {
    expect(pickerNoticeKey({ reason: null, isError: true })).toBe('pickerNoticeUnreachable');
  });

  it('lets the store outrank a failed query: Offline mode is still the reason', () => {
    expect(pickerNoticeKey({ reason: 'offline_mode', isError: true })).toBe('pickerNoticeOfflineMode');
  });
});
