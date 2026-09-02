import { beforeEach, describe, expect, it, vi } from 'vitest';

const posthog = vi.hoisted(() => ({
  client: null as { register: ReturnType<typeof vi.fn>; unregister: ReturnType<typeof vi.fn> } | null,
}));

vi.mock('../posthog-client', () => ({ getPostHogClient: () => posthog.client }));

import {
  GYM_NAME_SUPER_PROPERTY,
  GYM_UUID_SUPER_PROPERTY,
  registerActiveGym,
  reregisterActiveGym,
  __resetActiveGymForTests,
} from '../analytics-gym';

function makeClient() {
  return { register: vi.fn(() => Promise.resolve()), unregister: vi.fn(() => Promise.resolve()) };
}

beforeEach(() => {
  __resetActiveGymForTests();
  posthog.client = makeClient();
});

describe('registerActiveGym', () => {
  it('registers both properties for a board that has a gym', () => {
    registerActiveGym({ uuid: 'gym-1', name: 'Bloclab' });

    expect(posthog.client?.register).toHaveBeenCalledWith({
      [GYM_UUID_SUPER_PROPERTY]: 'gym-1',
      [GYM_NAME_SUPER_PROPERTY]: 'Bloclab',
    });
    expect(posthog.client?.unregister).not.toHaveBeenCalled();
  });

  // The correctness bug this module exists to avoid: a climber moves from a gym
  // wall to their home board, and every home session keeps landing on the gym's
  // leaderboard row.
  it('clears both properties when the active board has no gym', () => {
    registerActiveGym({ uuid: 'gym-1', name: 'Bloclab' });
    posthog.client = makeClient();

    registerActiveGym(null);

    expect(posthog.client.unregister).toHaveBeenCalledWith(GYM_UUID_SUPER_PROPERTY);
    expect(posthog.client.unregister).toHaveBeenCalledWith(GYM_NAME_SUPER_PROPERTY);
    expect(posthog.client.register).not.toHaveBeenCalled();
  });

  it('is a silent no-op when analytics is disabled, but still remembers the value', () => {
    posthog.client = null;
    expect(() => registerActiveGym({ uuid: 'gym-1', name: 'Bloclab' })).not.toThrow();

    // A client that appears later still gets it on the next re-registration.
    const client = makeClient();
    posthog.client = client;
    reregisterActiveGym();

    expect(client.register).toHaveBeenCalledWith({
      [GYM_UUID_SUPER_PROPERTY]: 'gym-1',
      [GYM_NAME_SUPER_PROPERTY]: 'Bloclab',
    });
  });

  it('does not reject when the client throws', () => {
    posthog.client = {
      register: vi.fn(() => {
        throw new Error('nope');
      }),
      unregister: vi.fn(() => Promise.resolve()),
    };

    expect(() => registerActiveGym({ uuid: 'gym-1', name: 'Bloclab' })).not.toThrow();
  });
});

describe('reregisterActiveGym', () => {
  // The trap: PostHog's reset() clears every super property, and the active
  // board does not change on sign-out, so the effect that registered the gym
  // will not re-run. Without this restore, every event after a sign-out loses
  // its venue for the rest of the launch.
  it('restores the remembered gym onto the client reset() hands it', () => {
    registerActiveGym({ uuid: 'gym-1', name: 'Bloclab' });
    const clientAfterReset = makeClient();

    reregisterActiveGym(clientAfterReset);

    expect(clientAfterReset.register).toHaveBeenCalledWith({
      [GYM_UUID_SUPER_PROPERTY]: 'gym-1',
      [GYM_NAME_SUPER_PROPERTY]: 'Bloclab',
    });
  });

  it('re-clears when the remembered state is "no gym"', () => {
    registerActiveGym(null);
    const clientAfterReset = makeClient();

    reregisterActiveGym(clientAfterReset);

    expect(clientAfterReset.unregister).toHaveBeenCalledWith(GYM_UUID_SUPER_PROPERTY);
    expect(clientAfterReset.register).not.toHaveBeenCalled();
  });

  it('does nothing before the root effect has published anything', () => {
    const clientAfterReset = makeClient();

    reregisterActiveGym(clientAfterReset);

    expect(clientAfterReset.register).not.toHaveBeenCalled();
    expect(clientAfterReset.unregister).not.toHaveBeenCalled();
  });
});
