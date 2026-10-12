import type { ConfigContext } from 'expo/config';
import { afterEach, describe, expect, it, vi } from 'vitest';
import createExpoConfig from '../../../app.config';

function resolveConfig() {
  vi.stubEnv('TAILSCALE_HOSTS', '');
  return createExpoConfig({ config: { name: 'Boardsesh', slug: 'boardsesh' } } as ConfigContext);
}

afterEach(() => vi.unstubAllEnvs());

describe('iOS development app identity', () => {
  it('isolates the TestFlight client while keeping Android identity production', () => {
    vi.stubEnv('BOARDSESH_IOS_APP_VARIANT', 'dev');
    vi.stubEnv('BOARDSESH_APP_VARIANT', '');
    vi.stubEnv('EAS_BUILD_PROFILE', 'development-testflight');
    const config = resolveConfig();
    expect(config.name).toBe('Boardsesh Dev');
    expect(config.icon).toBe('./dev-assets/icon.png');
    expect(config.scheme).toBe('com.boardsesh.app.dev');
    expect(config.android?.package).toBe('com.boardsesh.app');
    expect(config.ios?.bundleIdentifier).toBe('com.boardsesh.app.dev');
    expect(config.ios?.associatedDomains).toEqual([]);
    expect(config.ios?.entitlements).toMatchObject({
      'com.apple.security.application-groups': ['group.com.boardsesh.app.dev'],
      'keychain-access-groups': ['$(AppIdentifierPrefix)group.com.boardsesh.app.dev'],
    });
    expect(config.ios?.infoPlist).toMatchObject({
      BoardseshHostBundleIdentifier: 'com.boardsesh.app.dev',
      BoardseshAppGroupIdentifier: 'group.com.boardsesh.app.dev',
      BoardseshKeychainAccessGroup: '$(AppIdentifierPrefix)group.com.boardsesh.app.dev',
    });
    expect(config.plugins).toContain('./plugins/with-boardsesh-dev-networking');
    const sharePlugin = config.plugins?.find((plugin) => Array.isArray(plugin) && plugin[0] === 'expo-share-intent');
    expect(sharePlugin).toEqual([
      'expo-share-intent',
      expect.objectContaining({ iosAppGroupIdentifier: 'group.com.boardsesh.app.dev' }),
    ]);
  });

  it('keeps Android development builds on the existing iOS identity and scheme', () => {
    vi.stubEnv('BOARDSESH_IOS_APP_VARIANT', '');
    vi.stubEnv('BOARDSESH_APP_VARIANT', 'dev');
    const config = resolveConfig();
    expect(config.android?.package).toBe('com.boardsesh.app.dev');
    expect(config.ios?.bundleIdentifier).toBe('com.boardsesh.app');
    expect(config.ios?.associatedDomains).toEqual(['applinks:www.boardsesh.com', 'applinks:boardsesh.com']);
    expect(config.scheme).toBe('com.boardsesh.app');
    expect(config.ios?.infoPlist?.BoardseshAppGroupIdentifier).toBe('group.com.boardsesh.app');
  });
});
