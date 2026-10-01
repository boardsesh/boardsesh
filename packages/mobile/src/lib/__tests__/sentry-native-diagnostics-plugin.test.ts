import { describe, expect, it } from 'vitest';

// Config-plugin transforms run in Node at prebuild, without native SDKs.
const plugin = require('../../../plugins/with-sentry-native-diagnostics.js') as {
  guardAndroidInit: (contents: string) => string;
  guardIosInit: (contents: string) => string;
};

describe('early native Sentry guards', () => {
  it('keeps Kotlin startup capture release-only and enables raw tombstones before JS', () => {
    const guarded = plugin.guardAndroidInit('super.onCreate()\nRNSentrySDK.init(this)\nloadReactNative(this)');
    expect(guarded).toContain('if (!BuildConfig.DEBUG)');
    expect(guarded).toContain('options.setAttachRawTombstone(true)');
    expect(guarded.indexOf('.commit()')).toBeLessThan(guarded.indexOf('RNSentrySDK.init(this)'));
    expect(guarded).toContain('if (!startupMarkerDurable)');
    expect(guarded).toContain('putString("previousStartupId", previousStartupId)');
    expect(guarded.indexOf('getString("startupId", null)')).toBeLessThan(
      guarded.indexOf('putString("startupId", startupId)'),
    );
    expect(guarded.indexOf('native_startup_id')).toBeLessThan(guarded.indexOf('loadReactNative'));
    expect(plugin.guardAndroidInit(guarded)).toBe(guarded);
  });

  it('keeps Swift startup capture release-only and saves the same startup identifier', () => {
    const guarded = plugin.guardIosInit('import RNSentry\nRNSentrySDK.start()\nstartReactNative()');
    expect(guarded).toContain('#if !DEBUG');
    expect(guarded.indexOf('UserDefaults.standard.synchronize()')).toBeLessThan(guarded.indexOf('RNSentrySDK.start()'));
    expect(guarded).toContain('UserDefaults.standard.set(false, forKey: "boardsesh.diagnostics.startupMarkerDurable")');
    expect(guarded).toContain('UserDefaults.standard.set(startupId');
    expect(guarded).toContain(
      'UserDefaults.standard.set(previousStartupId, forKey: "boardsesh.diagnostics.previousStartupId")',
    );
    expect(guarded).toContain('setTag(value: startupId');
    expect(plugin.guardIosInit(guarded)).toBe(guarded);
  });

  it('fails prebuild if official native initialization stops matching', () => {
    expect(() => plugin.guardAndroidInit('loadReactNative(this)')).toThrow('not generated');
    expect(() => plugin.guardIosInit('startReactNative()')).toThrow('not generated');
  });
});
