import { createRequire } from 'node:module';

import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);

type MetaDataItem = { $: Record<string, string> };
type AndroidManifest = {
  manifest: { application?: Array<{ $: Record<string, string>; 'meta-data'?: MetaDataItem[] }> };
};

type SentryProguardUuidPlugin = {
  applySentryProguardUuid(androidManifest: AndroidManifest, uuid: string | undefined): AndroidManifest;
  META_DATA_NAME: string;
  ENV_VAR: string;
};

const plugin = require('../../../plugins/with-android-sentry-proguard-uuid.js') as SentryProguardUuidPlugin;

const UUID = '3f2b1c8a-5d4e-4a7b-9c1d-0e6f8a2b4c5d';

/** The minimum an Expo-generated AndroidManifest needs for the main-application lookup. */
function manifestFixture(): AndroidManifest {
  return {
    manifest: {
      application: [{ $: { 'android:name': '.MainApplication' } }],
    },
  };
}

function metaDataOf(androidManifest: AndroidManifest): MetaDataItem[] {
  return androidManifest.manifest.application?.[0]?.['meta-data'] ?? [];
}

describe('with-android-sentry-proguard-uuid', () => {
  it('bakes the UUID into the main application as meta-data', () => {
    const result = plugin.applySentryProguardUuid(manifestFixture(), UUID);

    const entry = metaDataOf(result).find((item) => item.$['android:name'] === plugin.META_DATA_NAME);
    expect(entry?.$['android:value']).toBe(UUID);
  });

  // A local prebuild, a PR build and the screenshot capture all run without the
  // variable. None of them upload a mapping, so none of them should carry a UUID —
  // and none of them may fail to prebuild over it.
  it('is a no-op when the env var is unset', () => {
    const result = plugin.applySentryProguardUuid(manifestFixture(), undefined);

    expect(metaDataOf(result)).toHaveLength(0);
  });

  it('is a no-op on an empty string', () => {
    const result = plugin.applySentryProguardUuid(manifestFixture(), '');

    expect(metaDataOf(result)).toHaveLength(0);
  });

  it('replaces rather than duplicates on a repeated prebuild', () => {
    const once = plugin.applySentryProguardUuid(manifestFixture(), UUID);
    const twice = plugin.applySentryProguardUuid(once, UUID);

    expect(metaDataOf(twice).filter((item) => item.$['android:name'] === plugin.META_DATA_NAME)).toHaveLength(1);
  });

  // Shipping a binary whose manifest carries a UUID that no uploaded mapping
  // matches is worse than failing prebuild: Sentry would silently never
  // deobfuscate, and nothing downstream would say so.
  it('throws on a malformed UUID rather than baking it in', () => {
    expect(() => plugin.applySentryProguardUuid(manifestFixture(), 'not-a-uuid')).toThrow(/is not a UUID/);
  });
});
