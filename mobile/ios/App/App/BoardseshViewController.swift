import UIKit
import Capacitor
import WebKit
import Network

class BoardseshViewController: CAPBridgeViewController {
    private let pathMonitor = NWPathMonitor()
    private let pathMonitorQueue = DispatchQueue(label: "com.boardsesh.network-monitor")
    private var hasInternetConnection = true
    private var attemptedCacheFallback = false

    override func viewDidLoad() {
        super.viewDidLoad()

        // Disable rubber-band bounce so the page cannot overscroll
        webView?.scrollView.bounces = false
        startNetworkMonitoring()
    }

    deinit {
        pathMonitor.cancel()
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

    override func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        attemptedCacheFallback = false
        super.webView(webView, didFinish: navigation)
    }

    override func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        super.webView(webView, didFail: navigation, withError: error)

        guard !hasInternetConnection else {
            return
        }

        tryCacheThenFallback(in: webView)
    }

    override func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        super.webView(webView, didFailProvisionalNavigation: navigation, withError: error)

        guard !hasInternetConnection else {
            return
        }

        tryCacheThenFallback(in: webView)
    }

    private func startNetworkMonitoring() {
        pathMonitor.pathUpdateHandler = { [weak self] path in
            DispatchQueue.main.async {
                self?.hasInternetConnection = (path.status == .satisfied)
            }
        }

        pathMonitor.start(queue: pathMonitorQueue)
    }

    private func tryCacheThenFallback(in webView: WKWebView) {
        if !attemptedCacheFallback {
            attemptedCacheFallback = true

            if let existingURL = webView.url ?? bridge?.config.serverURL {
                let cachedRequest = URLRequest(
                    url: existingURL,
                    cachePolicy: .returnCacheDataElseLoad,
                    timeoutInterval: 30
                )
                webView.load(cachedRequest)
                return
            }
        }

        let offlineHtml = """
        <!DOCTYPE html>
        <html>
          <head>
            <meta charset=\"utf-8\" />
            <meta name=\"viewport\" content=\"width=device-width, initial-scale=1\" />
            <title>You're offline</title>
            <style>
              body {
                font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
                background: #0A0A0A;
                color: #fff;
                margin: 0;
                padding: 24px;
                display: flex;
                align-items: center;
                justify-content: center;
                min-height: 100vh;
                text-align: center;
              }
              h1 { font-size: 24px; margin: 0 0 12px; }
              p { color: #c4c4c4; line-height: 1.5; max-width: 360px; }
            </style>
          </head>
          <body>
            <main>
              <h1>You appear to be offline</h1>
              <p>
                We couldn't load Boardsesh from the network and no cached version was available yet.
                Check your connection and try again.
              </p>
            </main>
          </body>
        </html>
        """

        webView.loadHTMLString(offlineHtml, baseURL: nil)
    }
}
