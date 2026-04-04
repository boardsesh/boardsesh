import XCTest
@testable import App

final class OfflineFallbackSupportTests: XCTestCase {
    func testSanitizedRetryURLAllowsHttpAndHttps() {
        let httpsURL = URL(string: "https://boardsesh.com/path")!
        let httpURL = URL(string: "http://boardsesh.com/path")!

        XCTAssertEqual(OfflineFallbackSupport.sanitizedRetryURL(httpsURL), httpsURL)
        XCTAssertEqual(OfflineFallbackSupport.sanitizedRetryURL(httpURL), httpURL)
    }

    func testSanitizedRetryURLRejectsJavascriptScheme() {
        let javascriptURL = URL(string: "javascript:alert(1)")
        XCTAssertEqual(
            OfflineFallbackSupport.sanitizedRetryURL(javascriptURL),
            OfflineFallbackSupport.defaultURL
        )
    }

    func testRetryableNetworkErrorClassification() {
        let retryableError = URLError(.notConnectedToInternet)
        let nonRetryableError = URLError(.badURL)

        XCTAssertTrue(OfflineFallbackSupport.isRetryableNetworkError(retryableError))
        XCTAssertFalse(OfflineFallbackSupport.isRetryableNetworkError(nonRetryableError))
    }

    func testStateMachineResetsAfterSuccessfulFinish() {
        let state = IOSOfflineFallbackStateMachine()
        state.onPageStarted()
        state.onMainFrameError(URL(string: "https://boardsesh.com/a"))
        state.onPageFinished()

        XCTAssertTrue(state.shouldAttemptCacheFallback())
        XCTAssertFalse(state.shouldAttemptCacheFallback())

        state.onPageStarted()
        state.onPageFinished()

        XCTAssertTrue(state.shouldAttemptCacheFallback())
    }
}
