import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import type { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import type { ConfigContext } from 'expo/config';
import { afterEach, describe, expect, it, vi } from 'vitest';
import createExpoConfig from '../../../app.config';

const require = createRequire(import.meta.url);
type NativeOptions = { dsn?: string; environment?: string };
type NativePrivacyPlugin = {
  applySwiftSentryPrivacy(this: void, contents: string, options: NativeOptions): string;
  applyKotlinSentryPrivacy(this: void, contents: string, options: NativeOptions): string;
  ENVIRONMENT_TAG: string;
};
const plugin = require('../../../plugins/with-sentry-native-privacy.js') as NativePrivacyPlugin;
const dsn = 'https://public-key@example.sentry.io/123';

const swift = `import Expo
import React
@main
class AppDelegate: ExpoAppDelegate {
  public override func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
  ) -> Bool {
    let delegate = ReactNativeDelegate()
    let factory = ExpoReactNativeFactory(delegate: delegate)
    factory.startReactNative(withModuleName: "main", in: window, launchOptions: launchOptions)
    return super.application(application, didFinishLaunchingWithOptions: launchOptions)
  }
}
`;
const kotlin = `package com.boardsesh.app
import android.app.Application
class MainApplication : Application() {
  override fun onCreate() {
    super.onCreate()
    loadReactNative(this)
  }
}
`;

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.resetModules();
  vi.doUnmock('@sentry/react-native');
  vi.doUnmock('../global-error-capture');
});

describe('supported native Sentry startup', () => {
  it('keeps preview OTA tagging out of the native fingerprint config', () => {
    vi.stubEnv('TAILSCALE_HOSTS', '');
    vi.stubEnv('EAS_BUILD', '1');
    vi.stubEnv('EXPO_PUBLIC_SENTRY_DSN', dsn);
    const context = {
      config: { name: 'Boardsesh', slug: 'boardsesh' },
      projectRoot: fileURLToPath(new URL('../../..', import.meta.url)),
    } as ConfigContext;
    vi.stubEnv('EXPO_PUBLIC_SENTRY_ENVIRONMENT', undefined);
    const storeConfig = createExpoConfig(context);
    vi.stubEnv('EXPO_PUBLIC_SENTRY_ENVIRONMENT', 'preview');
    const previewConfig = createExpoConfig(context);

    // The fingerprint hashes the resolved config, including plugin options.
    expect(previewConfig).toEqual(storeConfig);
    expect(previewConfig.plugins).toContainEqual([
      './plugins/with-sentry-native-privacy',
      { dsn, environment: 'production' },
    ]);
  });

  it('supports the installed Expo native templates before their React Native startup', async () => {
    const archive = join(dirname(require.resolve('expo/package.json')), 'template.tgz');
    // Use Expo CLI's archive reader without spawning subprocesses in Vitest.
    const expoRequire = createRequire(require.resolve('@expo/cli/package.json'));
    const tar = expoRequire('tar') as {
      list: (options: { file: string; onReadEntry: (entry: Readable & { path: string }) => void }) => Promise<unknown>;
    };
    const templates = new Map<string, string>();
    await tar.list({
      file: archive,
      onReadEntry(entry) {
        if (!entry.path.endsWith('AppDelegate.swift') && !entry.path.endsWith('MainApplication.kt')) {
          entry.resume();
          return;
        }
        entry.on('data', (chunk: Buffer) => {
          templates.set(entry.path, (templates.get(entry.path) ?? '') + chunk.toString('utf8'));
        });
      },
    });
    const iosTemplate = templates.get('package/ios/HelloWorld/AppDelegate.swift');
    const androidTemplate = templates.get('package/android/app/src/main/java/com/helloworld/MainApplication.kt');
    expect(iosTemplate).toBeDefined();
    expect(androidTemplate).toBeDefined();
    if (!iosTemplate || !androidTemplate) throw new Error('Expo native templates were not found');
    const ios = plugin.applySwiftSentryPrivacy(iosTemplate, { dsn });
    const android = plugin.applyKotlinSentryPrivacy(androidTemplate, { dsn });
    expect(ios.indexOf('RNSentryStart.start(options: options)')).toBeLessThan(ios.indexOf('ExpoReactNativeFactory('));
    expect(android.indexOf('RNSentrySDK.init(this)')).toBeLessThan(android.indexOf('loadReactNative(this)'));
    expect(plugin.applySwiftSentryPrivacy(ios, { dsn })).toBe(ios);
    expect(plugin.applyKotlinSentryPrivacy(android, { dsn })).toBe(android);
  });

  it('installs callbacks before React Native and retains crash/app-hang/ANR handling', () => {
    const ios = plugin.applySwiftSentryPrivacy(swift, { dsn, environment: 'preview' });
    const android = plugin.applyKotlinSentryPrivacy(kotlin, { dsn, environment: 'preview' });
    expect(ios.indexOf('RNSentryStart.start(options: options)')).toBeLessThan(ios.indexOf('ExpoReactNativeFactory('));
    expect(android.indexOf('super.onCreate()')).toBeLessThan(android.indexOf('RNSentrySDK.init(this)'));
    expect(android.indexOf('RNSentrySDK.init(this)')).toBeLessThan(android.indexOf('loadReactNative(this)'));
    expect(ios).toContain('options.enableCrashHandler = true');
    expect(ios).toContain('options.enableAppHangTracking = true');
    expect(ios).toContain('options.appHangTimeoutInterval = 2');
    expect(android).toContain('options.isAnrEnabled = true');
    expect(ios).toContain('event.user = nil');
    expect(ios).toContain('device.removeValue(forKey: "id")');
    expect(android).toContain('event.user = null');
    expect(android).toContain('event.contexts.device?.id = null');
    expect(android).toContain('transaction.user = null');
    expect(android).toContain('transaction.contexts.device?.id = null');
    expect(ios).toContain(`RNSentryStart.createOptions(with: ["dsn": "${dsn}"])`);
    expect(android).toContain(`options.dsn = "${dsn}"`);
    expect(ios).toContain('options.environment = "preview"');
    expect(android).toContain('options.environment = "preview"');
    expect(ios).toContain('#if !DEBUG');
    expect(android).toContain('if (!BuildConfig.DEBUG)');
    // Automatic native sessions retain the existing SDK defaults; this change
    // limits its privacy claim to errors/transactions, not every envelope item.
    expect(ios).not.toContain('enableAutoSessionTracking');
    expect(android).not.toContain('EnableAutoSessionTracking');
  });

  it('builds iOS options in code so a bundle without sentry.options.json cannot crash launch', () => {
    const ios = plugin.applySwiftSentryPrivacy(swift, { dsn });
    // RNSentrySDK.start(configureOptions:) reads the DSN from sentry.options.json.
    // Without that file it calls back with nil options, and the first write to
    // them segfaulted every launch of TestFlight 2.6.0 (15).
    expect(ios).not.toContain('RNSentrySDK');
    const order = [
      'do {',
      'let options = try RNSentryStart.createOptions(with:',
      'RNSentryStart.update(withReactDefaults: options)',
      'options.environment = ',
      'options.sendDefaultPii = false',
      'options.beforeSend = {',
      'RNSentryStart.update(withReactFinals: options)',
      'RNSentryStart.start(options: options)',
      '} catch {',
      'ExpoReactNativeFactory(',
    ].map((step) => ios.indexOf(step));
    expect(order).not.toContain(-1);
    expect(order).toEqual([...order].sort((first, second) => first - second));
  });

  it.each([
    ['Swift', plugin.applySwiftSentryPrivacy, swift],
    ['Kotlin', plugin.applyKotlinSentryPrivacy, kotlin],
  ] as const)(
    '%s prebuild is idempotent, replaces build settings, and removes startup without a DSN',
    (_, apply, template) => {
      const first = apply(template, { dsn });
      expect(apply(first, { dsn })).toBe(first);
      const secondDsn = 'https://next-key@example.sentry.io/456';
      const second = apply(first, { dsn: secondDsn, environment: 'preview' });
      expect(second).not.toContain(dsn);
      expect(second).toContain(secondDsn);
      expect(second.match(/RNSentry(?:Start\.start|SDK\.init)\(/g)).toHaveLength(1);
      expect(apply(second, {})).not.toMatch(/RNSentry(?:Start|SDK)\./);
      expect(apply(template, {})).toBe(template);
    },
  );

  it('escapes Kotlin interpolation and rejects invalid DSNs and moved startup anchors', () => {
    expect(plugin.applyKotlinSentryPrivacy(kotlin, { dsn: 'https://$key@example.sentry.io/123' })).toContain(
      'https://\\$key@',
    );
    expect(() => plugin.applySwiftSentryPrivacy(swift, { dsn: 'file:///123' })).toThrow(/Sentry project DSN/);
    expect(() => plugin.applyKotlinSentryPrivacy(kotlin, { dsn: 'https://example.sentry.io/123' })).toThrow(
      /Sentry project DSN/,
    );
    expect(() =>
      plugin.applySwiftSentryPrivacy(swift.replace('override func application', 'func renamed'), { dsn }),
    ).toThrow(/launch method/);
    expect(() =>
      plugin.applyKotlinSentryPrivacy(kotlin.replace('super.onCreate()', 'super.renamed()'), { dsn }),
    ).toThrow(/startup anchor/);
    expect(() => plugin.applySwiftSentryPrivacy(swift, { dsn, environment: 'preview\n' })).toThrow(
      /control characters/,
    );
  });

  it('keeps native callbacks when JS starts and forwards the current OTA environment via scope', async () => {
    const init = vi.fn();
    const setTag = vi.fn();
    vi.doMock('@sentry/react-native', () => ({ init, setTag }));
    vi.doMock('../global-error-capture', () => ({ installGlobalErrorCapture: vi.fn() }));
    vi.stubGlobal('__DEV__', false);
    vi.stubEnv('EXPO_PUBLIC_SENTRY_DSN', dsn);
    vi.stubEnv('EXPO_PUBLIC_SENTRY_ENVIRONMENT', 'preview');
    await import('../sentry');
    expect(init).toHaveBeenCalledWith(
      expect.objectContaining({
        dsn,
        environment: 'preview',
        autoInitializeNativeSdk: false,
        enableNativeCrashHandling: true,
        enableAppHangTracking: true,
        sendDefaultPii: false,
      }),
    );
    expect(setTag).toHaveBeenCalledWith(plugin.ENVIRONMENT_TAG, 'preview');
    const options = init.mock.calls[0][0] as {
      beforeSend: (event: object, hint: object) => unknown;
      beforeSendTransaction: (event: object) => unknown;
    };
    const error = { user: { id: 'account' }, contexts: { device: { id: 'installation', model: 'phone' } } };
    expect(options.beforeSend(error, {})).toEqual({ contexts: { device: { model: 'phone' } } });
    expect(options.beforeSendTransaction({ user: { id: 'account' } })).toEqual({});
    expect(plugin.applySwiftSentryPrivacy(swift, { dsn })).toContain(`event.tags?["${plugin.ENVIRONMENT_TAG}"]`);
    expect(plugin.applyKotlinSentryPrivacy(kotlin, { dsn })).toContain(`getTag("${plugin.ENVIRONMENT_TAG}")`);
  });
});
