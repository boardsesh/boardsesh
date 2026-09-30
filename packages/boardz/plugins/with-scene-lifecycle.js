const { createRunOncePlugin, withAppDelegate, withInfoPlist } = require('expo/config-plugins');

// Apps built with the iOS 27 SDK must use the UIScene life cycle, or UIKit
// refuses to launch them ("UIScene life cycle is required for apps built with
// this SDK"). Expo SDK 57's AppDelegate template still creates its window in
// application(_:didFinishLaunchingWithOptions:), so this plugin:
//   1. declares a single-window scene manifest in Info.plist, and
//   2. moves the window + React Native start into a SceneDelegate appended to
//      the generated AppDelegate.swift (same file, so the Xcode project needs
//      no new build file).
// Drop it once Expo's template adopts scenes itself.

const SCENE_DELEGATE_CLASS = '$(PRODUCT_MODULE_NAME).SceneDelegate';

// The window block in Expo SDK 57's AppDelegate.swift template.
const TEMPLATE_WINDOW_BLOCK = `#if os(iOS) || os(tvOS)
    window = UIWindow(frame: UIScreen.main.bounds)
    factory.startReactNative(
      withModuleName: "main",
      in: window,
      launchOptions: launchOptions)
#endif
`;

const SCENE_DELEGATE_MARKER = 'class SceneDelegate: UIResponder, UIWindowSceneDelegate';

const SCENE_DELEGATE_SOURCE = `
// Under the UIScene life cycle the window belongs to the scene, so React
// Native starts here rather than in application(_:didFinishLaunchingWithOptions:).
${SCENE_DELEGATE_MARKER} {
  var window: UIWindow?

  func scene(
    _ scene: UIScene,
    willConnectTo session: UISceneSession,
    options connectionOptions: UIScene.ConnectionOptions
  ) {
    guard let windowScene = scene as? UIWindowScene,
          let appDelegate = UIApplication.shared.delegate as? AppDelegate,
          let factory = appDelegate.reactNativeFactory else {
      return
    }

    let window = UIWindow(windowScene: windowScene)
    self.window = window
    appDelegate.window = window
    factory.startReactNative(
      withModuleName: "main",
      in: window,
      launchOptions: SceneDelegate.launchOptions(from: connectionOptions))
  }

  // UIKit stops calling the app delegate's URL and user-activity methods once
  // scenes are adopted. Forward to them so Expo's subscribers (dev launcher,
  // expo-router) and RCTLinkingManager still see every link.
  func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
    guard let appDelegate = UIApplication.shared.delegate as? AppDelegate else { return }
    for context in URLContexts {
      var options: [UIApplication.OpenURLOptionsKey: Any] = [:]
      if let sourceApplication = context.options.sourceApplication {
        options[.sourceApplication] = sourceApplication
      }
      _ = appDelegate.application(UIApplication.shared, open: context.url, options: options)
    }
  }

  func scene(_ scene: UIScene, continue userActivity: NSUserActivity) {
    guard let appDelegate = UIApplication.shared.delegate as? AppDelegate else { return }
    _ = appDelegate.application(UIApplication.shared, continue: userActivity) { _ in }
  }

  // A link that cold-starts the app arrives in the connection options, but
  // RCTLinkingManager.getInitialURL reads the launch options. Rebuild the two
  // keys it looks for.
  private static func launchOptions(
    from connectionOptions: UIScene.ConnectionOptions
  ) -> [UIApplication.LaunchOptionsKey: Any]? {
    if let url = connectionOptions.urlContexts.first?.url {
      return [.url: url]
    }
    if let activity = connectionOptions.userActivities.first(where: {
      $0.activityType == NSUserActivityTypeBrowsingWeb
    }) {
      let activityDictionary: [String: Any] = [
        UIApplication.LaunchOptionsKey.userActivityType.rawValue: activity.activityType,
        "UIApplicationLaunchOptionsUserActivityKey": activity,
      ]
      return [.userActivityDictionary: activityDictionary]
    }
    return nil
  }
}
`;

function withSceneManifest(config) {
  return withInfoPlist(config, (modConfig) => {
    modConfig.modResults.UIApplicationSceneManifest = {
      UIApplicationSupportsMultipleScenes: false,
      UISceneConfigurations: {
        UIWindowSceneSessionRoleApplication: [
          {
            UISceneConfigurationName: 'Default Configuration',
            UISceneDelegateClassName: SCENE_DELEGATE_CLASS,
          },
        ],
      },
    };
    return modConfig;
  });
}

function withSceneDelegate(config) {
  return withAppDelegate(config, (modConfig) => {
    const { language, contents } = modConfig.modResults;
    if (language !== 'swift') {
      throw new Error(`with-scene-lifecycle: expected a Swift AppDelegate, got ${language}`);
    }
    if (contents.includes(SCENE_DELEGATE_MARKER)) {
      return modConfig;
    }
    if (!contents.includes(TEMPLATE_WINDOW_BLOCK)) {
      // Fail loudly: a silent no-op here builds an app that won't launch.
      throw new Error(
        'with-scene-lifecycle: AppDelegate.swift no longer matches the Expo SDK 57 template. ' +
          'Check whether Expo now adopts UIScene itself and update or remove this plugin.',
      );
    }
    modConfig.modResults.contents = contents.replace(TEMPLATE_WINDOW_BLOCK, '') + SCENE_DELEGATE_SOURCE;
    return modConfig;
  });
}

function withSceneLifecycle(config) {
  return withSceneDelegate(withSceneManifest(config));
}

module.exports = createRunOncePlugin(withSceneLifecycle, 'with-scene-lifecycle', '1.0.0');
