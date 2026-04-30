import UIKit
import Capacitor
import WebKit

class BoardseshViewController: CAPBridgeViewController {

    override func capacitorDidLoad() {
        super.capacitorDidLoad()
        bridge?.registerPluginInstance(LiveActivityPlugin())
        bridge?.registerPluginInstance(HealthKitPlugin())
        // DevUrlPlugin is auto-registered via the CAP_PLUGIN macro in DevUrlPlugin.m
    }

    override open func instanceDescriptor() -> InstanceDescriptor {
        let descriptor = super.instanceDescriptor()
        #if DEBUG
        if let devUrl = DevUrlPlugin.currentOverride(), URL(string: devUrl) != nil {
            descriptor.serverURL = devUrl
            descriptor.allowedNavigationHostnames = ["*"]
        }
        #endif
        return descriptor
    }

    override open func webViewConfiguration(for instanceConfiguration: InstanceConfiguration) -> WKWebViewConfiguration {
        let config = super.webViewConfiguration(for: instanceConfiguration)

        // Enable inline media playback (avoids fullscreen video takeover)
        config.allowsInlineMediaPlayback = true
        config.mediaTypesRequiringUserActionForPlayback = []

        // Pre-warm the default data store to avoid cold-start penalty
        // on the first navigation that accesses cookies/IndexedDB.
        _ = WKWebsiteDataStore.default()

        // Show content as it arrives instead of waiting for full render.
        config.suppressesIncrementalRendering = false

        // Explicitly set desktop/mobile content mode via preferences.
        let prefs = WKWebpagePreferences()
        prefs.allowsContentJavaScript = true
        prefs.preferredContentMode = .mobile
        config.defaultWebpagePreferences = prefs

        return config
    }

    override func viewDidLoad() {
        super.viewDidLoad()

        // Let the native scroll view bounce naturally for smooth scroll physics.
        // CSS overscroll-behavior-y:none on <html> prevents web content from
        // rubber-banding, and Capacitor's backgroundColor (#0A0A0A) ensures
        // any native bounce reveals matching black — not a jarring white.
        // Previously bounces=false was set here, but it degrades momentum
        // scrolling and touch responsiveness vs Safari.

        // UIScrollView adds ~150ms delay to disambiguate taps from scrolls.
        // Since the web layer handles its own scroll/tap detection via
        // touch-action: manipulation, this native delay just makes taps
        // feel sluggish compared to Safari (which doesn't apply it).
        if let scrollView = webView?.scrollView {
            scrollView.delaysContentTouches = false
            scrollView.canCancelContentTouches = true
        }

        // If a universal link triggered a cold start, navigate to it now
        // that the bridge and WebView are ready.
        loadPendingUniversalLink()
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)

        // Fallback: the window may not be set during viewDidLoad on first launch.
        // Check again once the view is fully in the hierarchy.
        loadPendingUniversalLink()

        #if DEBUG
        scheduleDevUrlRescueCheck()
        #endif
    }

    #if DEBUG
    // DNS and connection-refused failures typically surface in under a second;
    // waiting longer than this just delays recovery. Follow-up to move to a
    // WKNavigationDelegate.didFailProvisionalNavigation hook tracked separately.
    private static let devUrlRescueDelay: TimeInterval = 4
    private var pendingDevUrlRescueWork: DispatchWorkItem?

    /// If a dev URL override is active and the WebView hasn't loaded anything
    /// meaningful after `devUrlRescueDelay` seconds, present a native alert that
    /// lets the developer clear the override. Without this, a dead preview URL
    /// leaves the app unable to reach the in-app Dev URL dialog to reset it.
    ///
    /// Any previously scheduled check is cancelled before a new one is queued,
    /// so repeated "Keep trying" taps or backgrounding/foregrounding cycles
    /// never cause multiple alerts to stack.
    private func scheduleDevUrlRescueCheck() {
        guard DevUrlPlugin.currentOverride() != nil else { return }
        pendingDevUrlRescueWork?.cancel()
        let work = DispatchWorkItem { [weak self] in
            self?.presentDevUrlRescueIfStillStuck()
        }
        pendingDevUrlRescueWork = work
        DispatchQueue.main.asyncAfter(deadline: .now() + Self.devUrlRescueDelay, execute: work)
    }

    private func presentDevUrlRescueIfStillStuck() {
        guard let override = DevUrlPlugin.currentOverride() else { return }
        // Don't stack alerts.
        guard presentedViewController == nil else { return }
        // Heuristic: a non-empty document title means the page loaded. Boardsesh
        // always sets a title; if we ever ship a page without one, revisit this.
        // See the "title-check fragility" follow-up note in the PR review.
        if let title = webView?.title, !title.isEmpty { return }

        let alert = UIAlertController(
            title: "Dev URL didn't load",
            message: "\(override) is unreachable. Reset to production?",
            preferredStyle: .alert
        )
        alert.addAction(UIAlertAction(title: "Reset", style: .destructive) { [weak self] _ in
            UserDefaults.standard.removeObject(forKey: DevUrlPlugin.defaultsKey)
            // Load production directly rather than exit(0) — calling `exit`
            // surfaces as an unexpected termination signal in dev/TestFlight
            // runs and is discouraged by Apple even in debug builds.
            if let productionURL = URL(string: DevUrlPlugin.defaultUrl) {
                self?.webView?.load(URLRequest(url: productionURL))
            }
        })
        alert.addAction(UIAlertAction(title: "Keep trying", style: .cancel) { [weak self] _ in
            // In case the tunnel came back up, re-arm the check.
            self?.scheduleDevUrlRescueCheck()
        })
        present(alert, animated: true)
    }
    #endif

    private func loadPendingUniversalLink() {
        guard let sceneDelegate = view.window?.windowScene?.delegate as? SceneDelegate,
              let pendingURL = sceneDelegate.pendingUniversalLinkURL else {
            return
        }
        sceneDelegate.pendingUniversalLinkURL = nil
        webView?.load(URLRequest(url: pendingURL))
    }

    override var supportedInterfaceOrientations: UIInterfaceOrientationMask {
        .portrait
    }

    override var preferredInterfaceOrientationForPresentation: UIInterfaceOrientation {
        .portrait
    }

    override var shouldAutorotate: Bool {
        false
    }
}
