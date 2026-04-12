import UIKit
import Capacitor
import WebKit

class BoardseshViewController: CAPBridgeViewController {

    override func capacitorDidLoad() {
        super.capacitorDidLoad()
        bridge?.registerPluginInstance(LiveActivityPlugin())
        bridge?.registerPluginInstance(NativeWebSocketPlugin())
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
    }

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
