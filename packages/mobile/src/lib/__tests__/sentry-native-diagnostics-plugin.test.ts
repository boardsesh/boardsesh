import { createRequire } from 'node:module';
import type { ConfigContext } from 'expo/config';
import { afterEach, vi } from 'vitest';
import createExpoConfig from '../../../app.config';
import { describe, expect, it } from 'vitest';

// Config-plugin transforms run in Node at prebuild, without native SDKs.
const require = createRequire(import.meta.url);
const plugin = require('../../../plugins/with-sentry-native-diagnostics.js') as {
  guardAndroidInit: (contents: string) => string;
  guardIosInit: (contents: string) => string;
};

const privacy = require('../../../plugins/with-sentry-native-privacy.js') as {
  applyKotlinSentryPrivacy(contents: string, options: { dsn: string }): string;
  applySwiftSentryPrivacy(contents: string, options: { dsn: string }): string;
};
const dsn = 'https://public-key@example.sentry.io/123';
const kotlinTemplate = `package com.boardsesh.app
import android.app.Application
class MainApplication : Application() {
  override fun onCreate() {
    super.onCreate()
    loadReactNative(this)
  }
}`;
const swiftTemplate = `import Expo
import React
class AppDelegate: ExpoAppDelegate {
  public override func application(_ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
    startReactNative()
    return true
  }
}`;
afterEach(() => vi.unstubAllEnvs());

describe('early native Sentry guards', () => {
  it('keeps Kotlin startup capture release-only and enables raw tombstones before JS', () => {
    const guarded = plugin.guardAndroidInit(privacy.applyKotlinSentryPrivacy(kotlinTemplate, { dsn }));
    expect(guarded).toContain('if (!BuildConfig.DEBUG)');
    expect(guarded).toContain('options.setAttachRawTombstone(true)');
    expect(guarded.indexOf('.commit()')).toBeLessThan(guarded.indexOf('RNSentrySDK.init(this)'));
    expect(guarded).toContain('if (!startupMarkerDurable)');
    expect(guarded).toContain('putString("previousStartupId", previousStartupId)');
    expect(guarded.indexOf('getString("startupId", null)')).toBeLessThan(
      guarded.indexOf('putString("startupId", startupId)'),
    );
    expect(guarded.indexOf('native_startup_id')).toBeLessThan(guarded.indexOf('loadReactNative'));
    expect(guarded.match(/RNSentrySDK\.init\(this\)/g)).toHaveLength(1);
    expect(guarded).toContain('options.setBeforeSend {');
    expect(guarded).toContain('options.setBeforeSendTransaction {');
    expect(guarded).toContain('transaction.user = null');
    expect(guarded).toContain('event.contexts.device?.id = null');
    expect(plugin.guardAndroidInit(guarded)).toBe(guarded);
  });

  it('keeps Swift startup capture release-only and saves the same startup identifier', () => {
    const guarded = plugin.guardIosInit(privacy.applySwiftSentryPrivacy(swiftTemplate, { dsn }));
    expect(guarded).toContain('#if !DEBUG');
    expect(guarded.indexOf('UserDefaults.standard.synchronize()')).toBeLessThan(
      guarded.indexOf('RNSentryStart.start(options: options)'),
    );
    expect(guarded).toContain('UserDefaults.standard.set(false, forKey: "boardsesh.diagnostics.startupMarkerDurable")');
    expect(guarded).toContain('UserDefaults.standard.set(startupId');
    expect(guarded).toContain(
      'UserDefaults.standard.set(previousStartupId, forKey: "boardsesh.diagnostics.previousStartupId")',
    );
    expect(guarded).toContain('setTag(value: startupId');
    expect(guarded.match(/RNSentryStart\.start\(options: options\)/g)).toHaveLength(1);
    expect(guarded).not.toContain('RNSentrySDK.start(');
    expect(guarded).toContain('options.beforeSend = {');
    expect(guarded).toContain('event.user = nil');
    expect(guarded).toContain('RNSentryStart.update(withReactFinals: options)');
    expect(plugin.guardIosInit(guarded)).toBe(guarded);
  });

  it('fails prebuild if official native initialization stops matching', () => {
    expect(() => plugin.guardAndroidInit('loadReactNative(this)')).toThrow('not generated');
    expect(() => plugin.guardIosInit('startReactNative()')).toThrow('not generated');
  });
});

describe('native privacy and diagnostic plugin composition', () => {
  it('registers diagnostics before privacy so reverse source mods preserve both', () => {
    vi.stubEnv('EXPO_PUBLIC_SENTRY_DSN', dsn);
    vi.stubEnv('TAILSCALE_HOSTS', '');
    const config = createExpoConfig({ config: { name: 'Boardsesh', slug: 'boardsesh' } } as ConfigContext);
    const names = config.plugins?.map((entry) => (typeof entry === 'string' ? entry : entry[0])) ?? [];
    expect(names.indexOf('./plugins/with-sentry-native-diagnostics')).toBeGreaterThanOrEqual(0);
    expect(names.indexOf('./plugins/with-sentry-native-diagnostics')).toBeLessThan(
      names.indexOf('./plugins/with-sentry-native-privacy'),
    );
    const android = plugin.guardAndroidInit(privacy.applyKotlinSentryPrivacy(kotlinTemplate, { dsn }));
    const ios = plugin.guardIosInit(privacy.applySwiftSentryPrivacy(swiftTemplate, { dsn }));
    expect(android.indexOf('.commit()')).toBeLessThan(android.indexOf('RNSentrySDK.init(this)'));
    expect(ios.indexOf('synchronize()')).toBeLessThan(ios.indexOf('RNSentryStart.start(options: options)'));
    expect(plugin.guardAndroidInit(privacy.applyKotlinSentryPrivacy(android, { dsn }))).toBe(android);
    expect(plugin.guardIosInit(privacy.applySwiftSentryPrivacy(ios, { dsn }))).toBe(ios);
  });
  it('omits diagnostic startup decoration when no native DSN is configured', () => {
    vi.stubEnv('EXPO_PUBLIC_SENTRY_DSN', '');
    vi.stubEnv('TAILSCALE_HOSTS', '');
    const config = createExpoConfig({ config: { name: 'Boardsesh', slug: 'boardsesh' } } as ConfigContext);
    expect(config.plugins).not.toContain('./plugins/with-sentry-native-diagnostics');
  });
});
