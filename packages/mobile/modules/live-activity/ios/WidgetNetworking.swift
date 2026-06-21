import Foundation

enum WidgetNavigationResult: Equatable {
    case success
    case serverRejected
    case retryableFailure
}

enum WidgetNetworking {
    private static func postWidgetRequest(urlKey: String, body: [String: Any], requestName: String) async -> WidgetNavigationResult {
        guard let defaults = SharedConstants.sharedDefaults,
              let widgetUrl = defaults.string(forKey: urlKey)
        else { return .retryableFailure }

        guard let url = URL(string: widgetUrl) else { return .retryableFailure }
        guard let jsonData = try? JSONSerialization.data(withJSONObject: body) else { return .retryableFailure }

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.timeoutInterval = 10
        request.httpBody = jsonData

        // Attach the APNs Live Activity push token as a Bearer header. The
        // backend looks up the token in `activity_push_tokens` to authenticate
        // widget requests. If it isn't there yet, fail closed instead of
        // falling through to a non-authoritative mutation path.
        if let pushToken = SharedKeychain.get(SharedKeychain.livePushTokenKey),
           !pushToken.isEmpty
        {
            request.setValue("Bearer \(pushToken)", forHTTPHeaderField: "Authorization")
        } else {
            return .serverRejected
        }

        do {
            let (_, response) = try await URLSession.shared.data(for: request)
            let statusCode = (response as? HTTPURLResponse)?.statusCode ?? -1
            if statusCode == 200 {
                return .success
            }
            if statusCode == 410 {
                // The push token was rebound to a different session (the main
                // app joined another session on the same device). Post the
                // Darwin notification so the main app re-registers; do NOT
                // clear the keychain entry. The Bearer is still the right
                // APNs token — the backend just needs to update its
                // (token, sessionId) mapping.
                print("[Widget] \(requestName) received 410; signaling re-registration")
                let name = CFNotificationName(SharedConstants.pushRegistrationStaleNotification as CFString)
                CFNotificationCenterPostNotification(
                    CFNotificationCenterGetDarwinNotifyCenter(),
                    name,
                    nil,
                    nil,
                    true
                )
                return .serverRejected
            }
            if (400...499).contains(statusCode) {
                print("[Widget] \(requestName) rejected with status \(statusCode)")
                return .serverRejected
            }
            print("[Widget] \(requestName) failed with status \(statusCode)")
            return .retryableFailure
        } catch {
            print("[Widget] \(requestName) failed: \(error.localizedDescription)")
            return .retryableFailure
        }
    }

    /// Sends a queue navigation request to the backend.
    /// Returns whether the request succeeded, was explicitly rejected by the
    /// server, or failed before the server could make an authoritative decision.
    @discardableResult
    static func sendNavigation(action: String, currentIndex: Int) async -> WidgetNavigationResult {
        // `widgetNavigateUrlKey` is written by `LiveActivityPlugin.startSession`.
        // If the user upgrades the app mid-session without re-running
        // `startSession` (e.g. they had a Live Activity running, installed the
        // new build, didn't relaunch the main app), the key won't be in
        // UserDefaults and the widget falls back to the local mutation path.
        // Acceptable: the user gets recovery as soon as they open the main app
        // and start a new session.
        guard let defaults = SharedConstants.sharedDefaults,
              let sessionId = defaults.string(forKey: SharedConstants.sessionIdKey)
        else { return .retryableFailure }

        let body: [String: Any] = [
            "sessionId": sessionId,
            "action": action,
            "currentIndex": currentIndex
        ]

        return await postWidgetRequest(
            urlKey: SharedConstants.widgetNavigateUrlKey,
            body: body,
            requestName: "Navigation request"
        )
    }

    /// Sends a wall-control claim request to the backend.
    @discardableResult
    static func sendTakeControl() async -> WidgetNavigationResult {
        guard let defaults = SharedConstants.sharedDefaults,
              let sessionId = defaults.string(forKey: SharedConstants.sessionIdKey)
        else { return .retryableFailure }

        return await postWidgetRequest(
            urlKey: SharedConstants.widgetTakeControlUrlKey,
            body: ["sessionId": sessionId],
            requestName: "Take-control request"
        )
    }
}
