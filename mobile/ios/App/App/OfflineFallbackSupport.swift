import Foundation

enum OfflineFallbackSupport {
    static let defaultURL = URL(string: "https://boardsesh.com")!

    static func sanitizedRetryURL(_ candidate: URL?) -> URL {
        guard let candidate, let scheme = candidate.scheme?.lowercased() else {
            return defaultURL
        }

        if scheme == "http" || scheme == "https" {
            return candidate
        }

        return defaultURL
    }

    static func isRetryableNetworkError(_ error: Error) -> Bool {
        let nsError = error as NSError
        guard nsError.domain == NSURLErrorDomain,
              let code = URLError.Code(rawValue: nsError.code)
        else {
            return false
        }

        switch code {
        case .notConnectedToInternet,
             .networkConnectionLost,
             .timedOut,
             .cannotFindHost,
             .cannotConnectToHost,
             .dnsLookupFailed,
             .internationalRoamingOff,
             .callIsActive,
             .dataNotAllowed:
            return true
        default:
            return false
        }
    }
}

final class IOSOfflineFallbackStateMachine {
    // Accessed only from WKWebView delegate callbacks inside BoardseshViewController,
    // which are executed on the main thread. Keep usage on main unless this class
    // is reused from background queues in the future.
    private var attemptedCacheFallback = false
    private var mainFrameLoadHadError = false
    private var lastFailedURL: URL?

    func onPageStarted() {
        mainFrameLoadHadError = false
    }

    func onMainFrameError(_ failedURL: URL?) {
        mainFrameLoadHadError = true
        if let failedURL {
            lastFailedURL = failedURL
        }
    }

    func onPageFinished() {
        if !mainFrameLoadHadError {
            attemptedCacheFallback = false
            lastFailedURL = nil
        }
    }

    func shouldAttemptCacheFallback() -> Bool {
        if attemptedCacheFallback {
            return false
        }

        attemptedCacheFallback = true
        return true
    }

    func retryURL(currentURL: URL?) -> URL {
        OfflineFallbackSupport.sanitizedRetryURL(lastFailedURL ?? currentURL)
    }
}
