/// <reference types="node" />
import { createRequire } from 'node:module';

import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);

type SchedulerDelegateInvalidationPlugin = {
  applySchedulerDelegateInvalidation: (contents: string) => string;
  INSTALL_CALL: string;
  IMPORT_LINE: string;
};

const plugin =
  require('../../packages/mobile/plugins/with-scheduler-delegate-invalidation.js') as SchedulerDelegateInvalidationPlugin;

// The Expo SDK 57 template's AppDelegate.swift, as `expo prebuild` writes it for
// this app (checked against a local prebuild on 2026-09-13).
const TEMPLATE_APP_DELEGATE = `internal import Expo
import React
import ReactAppDependencyProvider

@main
class AppDelegate: ExpoAppDelegate {
  var window: UIWindow?

  var reactNativeDelegate: ExpoReactNativeFactoryDelegate?
  var reactNativeFactory: RCTReactNativeFactory?

  public override func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
  ) -> Bool {
    let delegate = ReactNativeDelegate()
    let factory = ExpoReactNativeFactory(delegate: delegate)
    delegate.dependencyProvider = RCTAppDependencyProvider()

    reactNativeDelegate = delegate
    reactNativeFactory = factory

#if os(iOS) || os(tvOS)
    window = UIWindow(frame: UIScreen.main.bounds)
    factory.startReactNative(
      withModuleName: "main",
      in: window,
      launchOptions: launchOptions)
#endif

    return super.application(application, didFinishLaunchingWithOptions: launchOptions)
  }
}
`;

describe('with-scheduler-delegate-invalidation', () => {
  it('imports the module and installs the override between the factory init and startReactNative', () => {
    const result = plugin.applySchedulerDelegateInvalidation(TEMPLATE_APP_DELEGATE);

    expect(result).toContain(`import React\n${plugin.IMPORT_LINE}\n`);
    const factoryIndex = result.indexOf('let factory = ExpoReactNativeFactory(delegate: delegate)');
    const installIndex = result.indexOf(plugin.INSTALL_CALL);
    const startIndex = result.indexOf('factory.startReactNative(');
    expect(factoryIndex).toBeGreaterThan(-1);
    expect(installIndex).toBeGreaterThan(factoryIndex);
    expect(startIndex).toBeGreaterThan(installIndex);
    expect(result).toContain(`\n    ${plugin.INSTALL_CALL}\n`);
  });

  it('is idempotent across repeated prebuilds', () => {
    const once = plugin.applySchedulerDelegateInvalidation(TEMPLATE_APP_DELEGATE);

    expect(plugin.applySchedulerDelegateInvalidation(once)).toBe(once);
  });

  it('throws when the template stops creating the factory the way it anchors on', () => {
    const renamed = TEMPLATE_APP_DELEGATE.replace(
      'let factory = ExpoReactNativeFactory(delegate: delegate)',
      'let reactFactory = ExpoReactNativeFactory(delegate: delegate)',
    );

    expect(() => plugin.applySchedulerDelegateInvalidation(renamed)).toThrow(
      /ExpoReactNativeFactory\(delegate: delegate\)/,
    );
  });

  it('throws rather than inserting after React Native has already started', () => {
    const startsFirst = TEMPLATE_APP_DELEGATE.replace(/#if os\(iOS\) \|\| os\(tvOS\)[\s\S]*?#endif\n/, '').replace(
      '    let delegate = ReactNativeDelegate()\n',
      '    let delegate = ReactNativeDelegate()\n    factory.startReactNative(withModuleName: "main", in: window, launchOptions: launchOptions)\n',
    );

    expect(() => plugin.applySchedulerDelegateInvalidation(startsFirst)).toThrow(/startReactNative/);
  });

  it('throws when there is no import React line to anchor the module import', () => {
    const noReactImport = TEMPLATE_APP_DELEGATE.replace('import React\n', '');

    expect(() => plugin.applySchedulerDelegateInvalidation(noReactImport)).toThrow(/import React/);
  });
});
