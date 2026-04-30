import UIKit
import Capacitor

class SceneDelegate: UIResponder, UIWindowSceneDelegate {

    var window: UIWindow?
    /// Universal link URL received during cold start, before the Capacitor bridge is ready.
    var pendingUniversalLinkURL: URL?

    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options connectionOptions: UIScene.ConnectionOptions) {
        guard let windowScene = (scene as? UIWindowScene) else { return }

        // Save any universal link that triggered this cold start.
        // The bridge isn't ready yet, so we store it and let
        // BoardseshViewController pick it up after viewDidLoad.
        if let userActivity = connectionOptions.userActivities.first(where: {
            $0.activityType == NSUserActivityTypeBrowsingWeb
        }), let url = userActivity.webpageURL {
            pendingUniversalLinkURL = url
        }

        let window = UIWindow(windowScene: windowScene)
        let storyboard = UIStoryboard(name: "Main", bundle: nil)
        window.rootViewController = storyboard.instantiateInitialViewController()
        self.window = window
        window.makeKeyAndVisible()

        // Clean up any orphaned Live Activities from a previous session/crash.
        // Use Task.detached to avoid inheriting MainActor context and blocking
        // the main run loop with Activity<> enumeration continuations.
        if #available(iOS 16.1, *) {
            Task.detached(priority: .utility) {
                await LiveActivityManager.shared.endStaleActivities()
                await LiveActivityManager.shared.cleanupOrphanedActivities()
            }
        }
    }

    func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
        for context in URLContexts {
            let _ = ApplicationDelegateProxy.shared.application(
                UIApplication.shared,
                open: context.url,
                options: [:]
            )
        }
    }

    func scene(_ scene: UIScene, continue userActivity: NSUserActivity) {
        // Forward to Capacitor's proxy for plugin handling
        let _ = ApplicationDelegateProxy.shared.application(
            UIApplication.shared,
            continue: userActivity,
            restorationHandler: { _ in }
        )

        // Navigate the WebView directly for universal links (warm start).
        // Without @capacitor/app plugin, the proxy alone does not trigger navigation.
        if userActivity.activityType == NSUserActivityTypeBrowsingWeb,
           let url = userActivity.webpageURL,
           let vc = window?.rootViewController as? BoardseshViewController {
            vc.webView?.load(URLRequest(url: url))
        }
    }

    func sceneDidDisconnect(_ scene: UIScene) {
        // End Live Activity when the scene is discarded to avoid stale state
        SessionWebSocketManager.shared.disconnect()
        if #available(iOS 16.1, *) {
            Task.detached(priority: .utility) {
                await LiveActivityManager.shared.endAllActivities()
            }
        }
    }
    func sceneDidBecomeActive(_ scene: UIScene) {}
    func sceneWillResignActive(_ scene: UIScene) {}
    func sceneWillEnterForeground(_ scene: UIScene) {
        // Live Activities auto-dismiss after their 3-minute stale date.
        // Cold-start cleanup in scene(_:willConnectTo:) handles the rest.
        // No work needed here — avoids ActivityKit IPC on every foreground.
    }
    func sceneDidEnterBackground(_ scene: UIScene) {}
}
