import { createRequire } from 'node:module';

import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);

type PackageEntry = {
  $: Record<string, string>;
};

type QueriesEntry = {
  package?: PackageEntry[];
};

type AndroidManifestShape = {
  manifest: {
    queries?: QueriesEntry[];
  };
};

type InstallReferrerQueriesPlugin = {
  addInstallReferrerQueries(androidManifest: AndroidManifestShape): AndroidManifestShape;
  VENDING_PACKAGE: string;
};

const plugin = require('../../../plugins/with-android-install-referrer-queries.js') as InstallReferrerQueriesPlugin;

function emptyManifest(): AndroidManifestShape {
  return { manifest: {} };
}

describe('with-android-install-referrer-queries', () => {
  it('adds a <queries><package android:name="com.android.vending"/></queries> entry', () => {
    const result = plugin.addInstallReferrerQueries(emptyManifest());

    const packages = result.manifest.queries?.[0]?.package ?? [];
    const vending = packages.find((entry) => entry.$['android:name'] === plugin.VENDING_PACKAGE);

    expect(vending).toBeDefined();
  });

  it('preserves existing queries/package entries', () => {
    const manifest: AndroidManifestShape = {
      manifest: {
        queries: [{ package: [{ $: { 'android:name': 'com.some.other.app' } }] }],
      },
    };

    const result = plugin.addInstallReferrerQueries(manifest);
    const names = (result.manifest.queries?.[0]?.package ?? []).map((entry) => entry.$['android:name']);

    expect(names).toContain('com.some.other.app');
    expect(names).toContain(plugin.VENDING_PACKAGE);
  });

  it('is idempotent — a second pass adds no duplicate', () => {
    const once = plugin.addInstallReferrerQueries(emptyManifest());
    const twice = plugin.addInstallReferrerQueries(once);

    const vendingEntries = (twice.manifest.queries?.[0]?.package ?? []).filter(
      (entry) => entry.$['android:name'] === plugin.VENDING_PACKAGE,
    );
    expect(vendingEntries).toHaveLength(1);
  });
});
