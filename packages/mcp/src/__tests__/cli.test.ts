import { describe, expect, it } from 'vitest';
import { main, parseCommandArguments, selectClient } from '../cli';
import { ISSUER, PUBLIC_CLIENT_ID, type Profile } from '../types';

const profile: Profile = {
  issuer: ISSUER,
  clientId: PUBLIC_CLIENT_ID,
  subject: 'climber',
  accountId: 'account',
  generation: 'generation',
  authStatus: 'connected',
  scopes: [],
};

describe('public client selection at login', () => {
  it('moves bundled profiles to the registration shipped by the new release', () => {
    // This stored ID is from the first shipped build, independent of whatever
    // PUBLIC_CLIENT_ID a future release contains.
    const legacyProfile = { ...profile, clientId: 'IsrNoYVHWCQaBEREJawWEDMrNTXMdzQq' };
    for (const previous of [undefined, legacyProfile, { ...profile, clientIdSource: 'bundled' as const }]) {
      expect(selectClient(undefined, undefined, previous, 'replacement')).toEqual({
        clientId: 'replacement',
        clientIdSource: 'bundled',
      });
    }
  });

  it('retains explicit registrations, including a deliberate override to the old official ID', () => {
    expect(selectClient(undefined, undefined, { ...profile, clientIdSource: 'override' }, 'replacement')).toEqual({
      clientId: PUBLIC_CLIENT_ID,
      clientIdSource: 'override',
    });
    expect(selectClient(undefined, undefined, { ...profile, clientId: 'legacy-custom' }, 'replacement')).toEqual({
      clientId: 'legacy-custom',
      clientIdSource: 'override',
    });
  });

  it('prioritizes command-line and environment overrides over a saved registration', () => {
    expect(selectClient('command', 'environment', profile).clientId).toBe('command');
    expect(selectClient(undefined, 'environment', profile)).toEqual({
      clientId: 'environment',
      clientIdSource: 'override',
    });
    expect(selectClient('', 'environment', profile).clientId).toBe('');
  });
});

describe('command-line validation', () => {
  it('explains mistyped options before opening a profile or starting login', async () => {
    await expect(main(['login', '--no-browsr'])).rejects.toMatchObject({
      code: 'invalid_command',
      message: expect.stringContaining('--help'),
    });
  });

  it('explains missing option values and still accepts documented options', () => {
    expect(() => parseCommandArguments(['login', '--client-id'])).toThrow('Use --help');
    expect(parseCommandArguments(['login', '--no-browser', '--client-id', 'custom']).values).toEqual({
      'no-browser': true,
      'client-id': 'custom',
    });
  });
});
