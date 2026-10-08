import { beforeEach, describe, expect, it, vi } from 'vitest';
import { parseClientIdentity } from '@boardsesh/shared-schema/client-identity';

const { application, platform, constants } = vi.hoisted(() => ({
  application: {
    nativeApplicationVersion: '2.6.0' as string | null,
    nativeBuildVersion: '45' as string | null,
  },
  platform: { OS: 'ios' },
  constants: { expoConfig: { version: '2.6.0' } as { version?: string } | null },
}));

vi.mock('expo-application', () => application);
vi.mock('react-native', () => ({ Platform: platform }));
vi.mock('expo-constants', () => ({ default: constants }));

const native = await import('../client-identity');
const web = await import('../client-identity.web');

describe('native client identity', () => {
  beforeEach(() => {
    application.nativeApplicationVersion = '2.6.0';
    application.nativeBuildVersion = '45';
    platform.OS = 'ios';
    native.resetClientIdentityForTests();
  });

  it('names the binary, its version, platform and build', () => {
    expect(native.getClientIdentityHeaderValue()).toBe('boardsesh-mobile/2.6.0 (ios; build 45)');
  });

  it('produces a value the backend parser accepts', () => {
    platform.OS = 'android';
    application.nativeBuildVersion = '1234';

    expect(parseClientIdentity(native.getClientIdentityHeaderValue())).toEqual({
      name: 'boardsesh-mobile',
      version: '2.6.0',
      platform: 'android',
      build: '1234',
    });
  });

  it('memoises the value for the life of the process', () => {
    expect(native.getClientIdentityHeaderValue()).toBe('boardsesh-mobile/2.6.0 (ios; build 45)');
    application.nativeApplicationVersion = '9.9.9';

    expect(native.getClientIdentityHeaderValue()).toBe('boardsesh-mobile/2.6.0 (ios; build 45)');
  });

  it('still produces a parseable value when the native version and build are missing', () => {
    application.nativeApplicationVersion = null;
    application.nativeBuildVersion = null;

    expect(native.getClientIdentityHeaderValue()).toBe('boardsesh-mobile/unknown (ios)');
    expect(parseClientIdentity(native.getClientIdentityHeaderValue())).toBeDefined();
  });

  it('exposes the header record for raw fetch calls', () => {
    expect(native.clientIdentityHeaders()).toEqual({
      'x-boardsesh-client': 'boardsesh-mobile/2.6.0 (ios; build 45)',
    });
  });
});

describe('Expo web client identity', () => {
  beforeEach(() => {
    constants.expoConfig = { version: '2.6.0' };
    web.resetClientIdentityForTests();
  });

  it('uses the web name and the app config version', () => {
    expect(web.getClientIdentityHeaderValue()).toBe('boardsesh-mobile-web/2.6.0 (web)');
    expect(parseClientIdentity(web.getClientIdentityHeaderValue())).toEqual({
      name: 'boardsesh-mobile-web',
      version: '2.6.0',
      platform: 'web',
    });
  });

  it('exposes the same header record helper as the native fork', () => {
    expect(web.MOBILE_CLIENT_NAME).toBe('boardsesh-mobile-web');
    expect(web.clientIdentityHeaders()).toEqual({ 'x-boardsesh-client': 'boardsesh-mobile-web/2.6.0 (web)' });
  });

  it('falls back to unknown when the app config has no version', () => {
    constants.expoConfig = null;

    expect(web.getClientIdentityHeaderValue()).toBe('boardsesh-mobile-web/unknown (web)');
  });
});
