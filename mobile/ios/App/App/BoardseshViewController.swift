import UIKit
import Capacitor

class BoardseshViewController: CAPBridgeViewController {
    override func viewDidLoad() {
        super.viewDidLoad()

        // Disable rubber-band bounce so the page cannot overscroll
        webView?.scrollView.bounces = false

        // If a universal link triggered a cold start, navigate to it now
        // that the bridge and WebView are ready.
        if let sceneDelegate = view.window?.windowScene?.delegate as? SceneDelegate,
           let pendingURL = sceneDelegate.pendingUniversalLinkURL {
            sceneDelegate.pendingUniversalLinkURL = nil
            webView?.load(URLRequest(url: pendingURL))
        }
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)

        // Fallback: the window may not be set during viewDidLoad on first launch.
        // Check again once the view is fully in the hierarchy.
        if let sceneDelegate = view.window?.windowScene?.delegate as? SceneDelegate,
           let pendingURL = sceneDelegate.pendingUniversalLinkURL {
            sceneDelegate.pendingUniversalLinkURL = nil
            webView?.load(URLRequest(url: pendingURL))
        }
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
