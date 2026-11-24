import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { ConfigContext } from 'expo/config';
import { AndroidConfig, compileModsAsync, withPlugins, type AndroidManifest } from 'expo/config-plugins';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import createExpoConfig, { APP_LOCALIZATIONS, localeStringsPath } from '../../app.config';

const MOBILE_ROOT = fileURLToPath(new URL('../..', import.meta.url));

beforeEach(() => {
  vi.stubEnv('TAILSCALE_HOSTS', '');
  vi.stubEnv('EAS_BUILD', '1');
  vi.stubEnv('BOARDSESH_WEB', '');
});

afterEach(() => {
  vi.unstubAllEnvs();
});

async function resolveLocationMods() {
  const config = createExpoConfig({
    config: { name: 'Boardsesh', slug: 'boardsesh' },
    projectRoot: MOBILE_ROOT,
  } as ConfigContext);
  const locationPlugin = config.plugins?.find(
    (plugin): plugin is [string, Record<string, unknown>] =>
      Array.isArray(plugin) &&
      plugin.length === 2 &&
      plugin[0] === 'expo-location' &&
      typeof plugin[1] === 'object' &&
      plugin[1] !== null,
  );
  if (!locationPlugin) throw new Error('Missing expo-location plugin');

  // Run the real location and permission mods without generating native projects.
  // This catches plugin defaults that can re-add Always or precision prompts.
  const locationConfig = withPlugins({ ...config, _internal: { projectRoot: MOBILE_ROOT } }, [locationPlugin]);
  AndroidConfig.Permissions.withInternalBlockedPermissions(locationConfig);
  return compileModsAsync(locationConfig, {
    projectRoot: MOBILE_ROOT,
    platforms: ['ios', 'android'],
    introspect: true,
    ignoreExistingNativeFiles: true,
  });
}

describe('foreground and approximate location permissions', () => {
  it('emits only the iOS When In Use location prompt', async () => {
    const config = await resolveLocationMods();
    const infoPlist = config.ios?.infoPlist;

    expect(infoPlist?.NSLocationWhenInUseUsageDescription).toBeTruthy();
    expect(infoPlist).not.toHaveProperty('NSLocationAlwaysUsageDescription');
    expect(infoPlist).not.toHaveProperty('NSLocationAlwaysAndWhenInUseUsageDescription');
    expect(infoPlist?.NSLocationTemporaryUsageDescriptionDictionary ?? {}).not.toHaveProperty(
      'ExpoLocationFullAccuracy',
    );
    expect(infoPlist?.UIBackgroundModes).not.toContain('location');
    expect(infoPlist?.UIBackgroundModes).toContain('bluetooth-central');
  });

  it('keeps every localized location prompt limited to When In Use', () => {
    for (const language of APP_LOCALIZATIONS) {
      const localized = JSON.parse(
        readFileSync(new URL(`../../${localeStringsPath(language)}`, import.meta.url), 'utf8'),
      ) as { ios: Record<string, string> };
      expect(localized.ios.NSLocationWhenInUseUsageDescription).toBeTruthy();
      expect(localized.ios).not.toHaveProperty('NSLocationAlwaysUsageDescription');
      expect(localized.ios).not.toHaveProperty('NSLocationAlwaysAndWhenInUseUsageDescription');
    }
  });

  it('emits coarse and fine access while blocking Android background location', async () => {
    const config = await resolveLocationMods();
    const androidManifest = config._internal?.modResults?.android?.manifest as AndroidManifest | undefined;
    const permissions = androidManifest?.manifest['uses-permission'] ?? [];
    const allowed = permissions.filter((permission) => permission.$['tools:node'] !== 'remove');
    const blocked = permissions.filter((permission) => permission.$['tools:node'] === 'remove');

    for (const permission of ['ACCESS_COARSE_LOCATION', 'ACCESS_FINE_LOCATION']) {
      expect(allowed).toContainEqual({ $: { 'android:name': `android.permission.${permission}` } });
    }
    for (const permission of ['ACCESS_BACKGROUND_LOCATION', 'FOREGROUND_SERVICE_LOCATION']) {
      expect(allowed.some((entry) => entry.$['android:name'] === `android.permission.${permission}`)).toBe(false);
      expect(blocked).toContainEqual({
        $: { 'android:name': `android.permission.${permission}`, 'tools:node': 'remove' },
      });
    }
    expect(allowed).toContainEqual({ $: { 'android:name': 'android.permission.FOREGROUND_SERVICE_CONNECTED_DEVICE' } });
  });
});
