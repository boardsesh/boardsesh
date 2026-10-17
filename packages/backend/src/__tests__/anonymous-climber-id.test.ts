import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import { anonymousClimberId } from '../graphql/resolvers/shared/helpers';

afterEach(() => vi.unstubAllEnvs());

describe('anonymous climber identity key', () => {
  it.each(['production', 'staging', undefined])('fails closed without a key in %s', (environment) => {
    vi.stubEnv('NODE_ENV', environment);
    vi.stubEnv('NEXTAUTH_SECRET', '   ');
    expect(() => anonymousClimberId('private-user')).toThrow('NEXTAUTH_SECRET is required');
  });

  it.each(['development', 'test'])('permits the fixed local key only in %s', (environment) => {
    vi.stubEnv('NODE_ENV', environment);
    vi.stubEnv('NEXTAUTH_SECRET', '   ');
    expect(anonymousClimberId('local-user')).toMatch(/^anon:/);
  });

  it('trims the configured key and never falls back when it is present', () => {
    vi.stubEnv('NODE_ENV', 'staging');
    vi.stubEnv('NEXTAUTH_SECRET', ' configured-key ');
    const padded = anonymousClimberId('private-user');
    vi.stubEnv('NEXTAUTH_SECRET', 'configured-key');
    expect(anonymousClimberId('private-user')).toBe(padded);
    vi.stubEnv('NEXTAUTH_SECRET', 'other-key');
    expect(anonymousClimberId('private-user')).not.toBe(padded);
  });
});
