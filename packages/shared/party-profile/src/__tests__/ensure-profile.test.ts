import { describe, it, expect, vi } from 'vitest';
import { ensureProfile } from '../ensure-profile';
import type { PartyProfile, PartyProfileStorage } from '../types';

function memoryStorage(initial: PartyProfile | null = null): PartyProfileStorage & { current: PartyProfile | null } {
  const state = { current: initial };
  return {
    async get() {
      return state.current;
    },
    async set(profile) {
      state.current = profile;
    },
    get current() {
      return state.current;
    },
  };
}

describe('ensureProfile', () => {
  it('returns the existing profile without writing when one is stored', async () => {
    const storage = memoryStorage({ id: 'existing' });
    const setSpy = vi.spyOn(storage, 'set');

    const profile = await ensureProfile(storage);

    expect(profile).toEqual({ id: 'existing' });
    expect(setSpy).not.toHaveBeenCalled();
  });

  it('creates and persists a new profile when none exists', async () => {
    const storage = memoryStorage(null);
    const profile = await ensureProfile(storage, () => 'generated-uuid');

    expect(profile).toEqual({ id: 'generated-uuid' });
    expect(storage.current).toEqual({ id: 'generated-uuid' });
  });

  it('defaults to crypto.randomUUID when no generator is passed', async () => {
    const storage = memoryStorage(null);
    const profile = await ensureProfile(storage);

    expect(typeof profile.id).toBe('string');
    expect(profile.id.length).toBeGreaterThan(0);
  });
});
