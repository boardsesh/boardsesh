import { describe, expect, it } from 'vite-plus/test';
import { watchPairingMode, assertWatchPairingRevocationCompatibility } from '../../watch-pairing-configuration';

describe('watch capability reader-before-emitter configuration', () => {
  it('keeps emission legacy by default and rejects unknown modes', () => {
    expect(watchPairingMode({})).toBe('legacy');
    expect(watchPairingMode({ AUTH_WATCH_PAIRING_MODE: 'source-bound-staging' })).toBe('source-bound-staging');
    expect(() => watchPairingMode({ AUTH_WATCH_PAIRING_MODE: 'unknown' })).toThrow();
  });
  it('cannot qualify native generation revocation while pairing emits unbound legacy codes', () => {
    expect(() => assertWatchPairingRevocationCompatibility('generation', {})).toThrow('SOURCE_BOUND_WATCH_PAIRING');
    expect(() =>
      assertWatchPairingRevocationCompatibility('generation', { AUTH_WATCH_PAIRING_MODE: 'source-bound-staging' }),
    ).not.toThrow();
    expect(() => assertWatchPairingRevocationCompatibility('legacy', {})).not.toThrow();
  });
});
