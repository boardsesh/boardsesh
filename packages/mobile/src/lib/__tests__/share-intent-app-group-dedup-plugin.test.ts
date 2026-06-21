import { createRequire } from 'node:module';

import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);

interface DedupPlugin {
  dedupeApplicationGroups(entitlements: Record<string, unknown>): Record<string, unknown>;
  APP_GROUP_KEY: string;
}

const plugin = require('../../../plugins/with-share-intent-app-group-dedup.js') as DedupPlugin;

describe('with-share-intent-app-group-dedup', () => {
  it('collapses the duplicate App Group expo-share-intent prepends', () => {
    // What the merged entitlements look like after expo-share-intent prepends
    // our group to the one already declared in ios.entitlements.
    const entitlements = {
      [plugin.APP_GROUP_KEY]: ['group.com.boardsesh.app', 'group.com.boardsesh.app'],
    };

    const result = plugin.dedupeApplicationGroups(entitlements);

    expect(result[plugin.APP_GROUP_KEY]).toEqual(['group.com.boardsesh.app']);
  });

  it('preserves order and keeps distinct groups', () => {
    const entitlements = {
      [plugin.APP_GROUP_KEY]: ['group.com.boardsesh.app', 'group.com.boardsesh.other', 'group.com.boardsesh.app'],
    };

    const result = plugin.dedupeApplicationGroups(entitlements);

    expect(result[plugin.APP_GROUP_KEY]).toEqual(['group.com.boardsesh.app', 'group.com.boardsesh.other']);
  });

  it('leaves entitlements without an application-groups array untouched', () => {
    const entitlements = { 'aps-environment': 'production' };

    const result = plugin.dedupeApplicationGroups(entitlements);

    expect(result).toEqual({ 'aps-environment': 'production' });
  });
});

describe('with-share-intent-app-group-dedup ordering (real mod chain)', () => {
  // Run the entitlements mod chain through the real @expo/config-plugins
  // composition to prove the dedup actually wins given the registration order in
  // app.config.ts — not just that the pure transform works in isolation.
  const { withEntitlementsPlist } = require('expo/config-plugins');

  // Mirrors expo-share-intent's withIosAppEntitlements, which PREPENDS the App
  // Group to the main app's application-groups without deduping (see
  // node_modules/expo-share-intent/plugin/build/ios/withIosAppEntitlements.js).
  const withPrependAppGroup = (config: unknown) =>
    withEntitlementsPlist(config, (modConfig: { modResults: Record<string, unknown> }) => {
      const existing = modConfig.modResults[plugin.APP_GROUP_KEY];
      modConfig.modResults[plugin.APP_GROUP_KEY] = [
        'group.com.boardsesh.app',
        ...(Array.isArray(existing) ? existing : []),
      ];
      return modConfig;
    });

  const withDedup = (config: unknown) =>
    withEntitlementsPlist(config, (modConfig: { modResults: Record<string, unknown> }) => {
      modConfig.modResults = plugin.dedupeApplicationGroups(modConfig.modResults);
      return modConfig;
    });

  async function runEntitlements(config: unknown): Promise<Record<string, unknown>> {
    const mod = (
      config as { mods: { ios: { entitlements: (c: unknown) => Promise<{ modResults: Record<string, unknown> }> } } }
    ).mods.ios.entitlements;
    // Seed modResults the way the base provider does from ios.entitlements.
    const result = await mod({
      ...(config as object),
      modResults: { [plugin.APP_GROUP_KEY]: ['group.com.boardsesh.app'] },
      modRequest: { projectRoot: '/tmp', platform: 'ios', modName: 'entitlements', introspect: true },
    });
    return result.modResults;
  }

  it('yields a single App Group when dedup is registered FIRST (app.config order)', async () => {
    // Expo composes withEntitlementsPlist mods to run in reverse registration
    // order, so registering dedup first makes it run LAST — after the prepend.
    let config: unknown = { name: 'x', slug: 'x', mods: {} };
    config = withDedup(config); // registered first
    config = withPrependAppGroup(config); // registered after (mimics expo-share-intent)

    expect(await runEntitlements(config)).toEqual({ [plugin.APP_GROUP_KEY]: ['group.com.boardsesh.app'] });
  });

  it('would leave the duplicate in the reverse order — pins WHY dedup must be first', async () => {
    let config: unknown = { name: 'x', slug: 'x', mods: {} };
    config = withPrependAppGroup(config); // registered first → runs last
    config = withDedup(config); // registered after → runs first, before the prepend

    expect(await runEntitlements(config)).toEqual({
      [plugin.APP_GROUP_KEY]: ['group.com.boardsesh.app', 'group.com.boardsesh.app'],
    });
  });
});
