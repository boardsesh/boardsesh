import Capacitor
import ActivityKit
import UIKit
import os.log

@objc(LiveActivityPlugin)
public class LiveActivityPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "LiveActivityPlugin"
    public let jsName = "LiveActivity"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "isAvailable", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "startSession", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "endSession", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "updateActivity", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "updateActivityClimb", returnType: CAPPluginReturnPromise),
    ]

    private let logger = Logger(subsystem: "com.boardsesh.app", category: "LiveActivityPlugin")
    private var observingDarwinNotification = false
    private var observingPushRegistrationStale = false
    private var observingForegroundNotification = false

    /// Serial queue protecting push token state accessed from both the Capacitor
    /// thread and the LiveActivityManager push token callback.
    private let tokenQueue = DispatchQueue(label: "com.boardsesh.LiveActivityPlugin.token")
    private var _currentPushToken: String?
    private var _currentServerUrl: String?
    /// HTTP GraphQL endpoint on the backend (e.g. https://ws.boardsesh.com/graphql).
    /// Distinct from _currentServerUrl, which is the web origin
    /// (https://www.boardsesh.com) — the backend lives on a different host.
    private var _currentGraphqlUrl: String?
    private var _currentSessionId: String?

    /// Monotonically increments every time `registerPushTokenWithBackend` is
    /// called. A retry chain captures its generation and aborts as soon as the
    /// counter advances — so a second entry point (foreground, WS reconnect,
    /// widget 410, fresh ActivityKit token) supersedes any in-flight chain
    /// rather than running in parallel with it.
    private var _activeRegistrationGeneration: UInt64 = 0

    /// Retry schedule for push-token registration when the initial HTTP attempt
    /// fails (network blip on the just-locked phone is the common case). Five
    /// attempts spread across ~50 seconds, all in-process and non-blocking.
    private let pushRegistrationRetryDelays: [TimeInterval] = [0, 2, 5, 15, 30]

    // MARK: - Darwin Notification (Widget → JS bridge)

    /// Start observing Darwin notifications from the widget's Next/Previous intents.
    /// When the widget navigates, we forward the action to the JS side so it can
    /// send the server mutation via its GraphQL connection.
    private func startDarwinObservation() {
        guard !observingDarwinNotification else { return }
        observingDarwinNotification = true

        let center = CFNotificationCenterGetDarwinNotifyCenter()
        let name = CFNotificationName(SharedConstants.queueNavigateNotification as CFString)
        let observer = Unmanaged.passUnretained(self).toOpaque()

        CFNotificationCenterAddObserver(
            center,
            observer,
            { (_, observer, _, _, _) in
                guard let observer = observer else { return }
                let plugin = Unmanaged<LiveActivityPlugin>.fromOpaque(observer).takeUnretainedValue()
                plugin.handleQueueNavigateFromWidget()
            },
            name.rawValue,
            nil,
            .deliverImmediately
        )
    }

    deinit {
        stopDarwinObservation()
        stopPushRegistrationStaleObservation()
        stopForegroundObservation()
    }

    private func stopDarwinObservation() {
        guard observingDarwinNotification else { return }
        observingDarwinNotification = false

        // Pass the specific name; CFNotificationCenterRemoveObserver with
        // nil-name would clobber every Darwin observer registered against
        // `self`, not just this one.
        let center = CFNotificationCenterGetDarwinNotifyCenter()
        let observer = Unmanaged.passUnretained(self).toOpaque()
        let name = CFNotificationName(SharedConstants.queueNavigateNotification as CFString)
        CFNotificationCenterRemoveObserver(center, observer, name, nil)
    }

    // MARK: - Push registration stale (widget 410)

    /// Observe the Darwin notification fired by the widget when
    /// `/api/widget/navigate` responds 410 Gone — the cached push token is
    /// bound to a different session. We respond by re-registering.
    private func startPushRegistrationStaleObservation() {
        guard !observingPushRegistrationStale else { return }
        observingPushRegistrationStale = true

        let center = CFNotificationCenterGetDarwinNotifyCenter()
        let name = CFNotificationName(SharedConstants.pushRegistrationStaleNotification as CFString)
        let observer = Unmanaged.passUnretained(self).toOpaque()

        CFNotificationCenterAddObserver(
            center,
            observer,
            { (_, observer, _, _, _) in
                guard let observer = observer else { return }
                let plugin = Unmanaged<LiveActivityPlugin>.fromOpaque(observer).takeUnretainedValue()
                plugin.handlePushRegistrationStale()
            },
            name.rawValue,
            nil,
            .deliverImmediately
        )
    }

    private func stopPushRegistrationStaleObservation() {
        guard observingPushRegistrationStale else { return }
        observingPushRegistrationStale = false

        let center = CFNotificationCenterGetDarwinNotifyCenter()
        let observer = Unmanaged.passUnretained(self).toOpaque()
        let name = CFNotificationName(SharedConstants.pushRegistrationStaleNotification as CFString)
        CFNotificationCenterRemoveObserver(center, observer, name, nil)
    }

    private func handlePushRegistrationStale() {
        let (token, sessionId, serverUrl, graphqlUrl) = tokenQueue.sync {
            (_currentPushToken, _currentSessionId, _currentServerUrl, _currentGraphqlUrl)
        }
        // Leave `livePushTokenKey` in the keychain so the widget keeps sending
        // the same Bearer while we re-register. Once the backend rebinds the
        // token to the current session, the widget's next call returns 200
        // without needing a new token. Wiping the keychain here would make
        // widget requests authenticate as 401 (not 410) during the ~50s
        // retry window, which doesn't trigger the Darwin notification
        // fallback — so the widget would silently fail buttons until the
        // foreground observer eventually runs.
        if let token, let sessionId, let serverUrl, let graphqlUrl {
            logger.info("Re-registering push token after widget 410")
            registerPushTokenWithBackend(token: token, sessionId: sessionId, serverUrl: serverUrl, graphqlUrl: graphqlUrl)
        } else {
            logger.warning("Push registration stale notification received but no current session/token to re-register")
        }
    }

    // MARK: - App foreground

    private func startForegroundObservation() {
        guard !observingForegroundNotification else { return }
        observingForegroundNotification = true
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(handleAppWillEnterForeground),
            name: UIApplication.willEnterForegroundNotification,
            object: nil
        )
    }

    private func stopForegroundObservation() {
        guard observingForegroundNotification else { return }
        observingForegroundNotification = false
        NotificationCenter.default.removeObserver(
            self,
            name: UIApplication.willEnterForegroundNotification,
            object: nil
        )
    }

    @objc private func handleAppWillEnterForeground() {
        retryPendingRegistrationIfNeeded(trigger: "foreground")
    }

    private func handleQueueNavigateFromWidget() {
        guard let defaults = SharedConstants.sharedDefaults else { return }

        // The intent always writes widgetNavigateActionKey; pendingActionKey
        // is only present when the HTTP path failed and we need to send a
        // WebSocket mutation as a fallback.
        guard let action = defaults.string(forKey: SharedConstants.widgetNavigateActionKey) else {
            // Backwards compatible path for pre-update intents that still only
            // set pendingActionKey. Falls back to the old behaviour: fallback
            // mutation + notify JS.
            if let legacyAction = defaults.string(forKey: SharedConstants.pendingActionKey) {
                handleLegacyMutationFallback(defaults: defaults, action: legacyAction)
            }
            return
        }
        defaults.removeObject(forKey: SharedConstants.widgetNavigateActionKey)

        let needsMutationFallback = defaults.string(forKey: SharedConstants.pendingActionKey) != nil
        defaults.removeObject(forKey: SharedConstants.pendingActionKey)

        // Read the updated queue state that the widget intent already saved.
        let (items, currentIndex) = SharedQueueState.load(from: defaults)

        // CorrelationId resolution:
        //   - HTTP success path: intent stored `'widget-navigate'` (matches the
        //     constant the backend's `/api/widget/navigate` handler echoes
        //     back), and the WebSocket mutation is skipped.
        //   - HTTP failure path: no correlationId was stored; we generate a
        //     fresh UUID here and use it for both the WebSocket mutation we
        //     send and the JS notify, so the reducer's pending-update tracker
        //     can match the server echo.
        let storedCorrelationId = defaults.string(forKey: SharedConstants.widgetNavigateCorrelationIdKey)
        defaults.removeObject(forKey: SharedConstants.widgetNavigateCorrelationIdKey)
        let correlationId = storedCorrelationId ?? UUID().uuidString

        if needsMutationFallback, !items.isEmpty, currentIndex >= 0, currentIndex < items.count {
            let item = items[currentIndex]
            SessionWebSocketManager.shared.navigateToItem(item, at: currentIndex, totalItems: items, correlationId: correlationId)
        }

        // Always notify JS so the bridge dispatches the optimistic reducer
        // update. retainUntilConsumed ensures the event is queued if no
        // listener is attached yet (e.g. app was on the lock screen).
        notifyListeners("queueNavigate", data: [
            "action": action,
            "currentIndex": currentIndex,
            "correlationId": correlationId,
        ], retainUntilConsumed: true)
    }

    /// Legacy path for older intent builds (pre-widgetNavigateActionKey) that
    /// only ever wrote pendingActionKey. New installs never hit this branch;
    /// it stays so a TestFlight build with the old intent + new plugin still
    /// behaves the same as before.
    private func handleLegacyMutationFallback(defaults: UserDefaults, action: String) {
        defaults.removeObject(forKey: SharedConstants.pendingActionKey)

        let (items, currentIndex) = SharedQueueState.load(from: defaults)
        let correlationId = UUID().uuidString

        if !items.isEmpty, currentIndex >= 0, currentIndex < items.count {
            let item = items[currentIndex]
            SessionWebSocketManager.shared.navigateToItem(item, at: currentIndex, totalItems: items, correlationId: correlationId)
        }

        notifyListeners("queueNavigate", data: [
            "action": action,
            "currentIndex": currentIndex,
            "correlationId": correlationId,
        ], retainUntilConsumed: true)
    }

    // MARK: - Push Token Registration

    /// Persist a pending-registration record to the shared keychain so that a
    /// crash, app relaunch, or backgrounded retry path can pick it up later.
    private func writePendingRegistration(token: String, sessionId: String, serverUrl: String, graphqlUrl: String) {
        let payload: [String: String] = [
            "token": token,
            "sessionId": sessionId,
            "serverUrl": serverUrl,
            "graphqlUrl": graphqlUrl,
        ]
        guard let data = try? JSONSerialization.data(withJSONObject: payload),
              let json = String(data: data, encoding: .utf8) else { return }
        if !SharedKeychain.set(json, for: SharedKeychain.pendingPushRegistrationKey) {
            logger.error("Failed to persist pending push registration")
        }
    }

    /// Remove the pending-registration record unconditionally. Used by
    /// `endSession`; callers in the success path should prefer
    /// `clearPendingRegistrationIfMatches` to avoid wiping a record written
    /// for a fresher (token, sessionId) by a later `startSession`.
    private func clearPendingRegistration() {
        SharedKeychain.remove(SharedKeychain.pendingPushRegistrationKey)
    }

    /// Remove the pending record only if it still describes the same
    /// (token, sessionId) we just registered. Protects against a late-arriving
    /// URLSession completion clobbering a record that a new session wrote in
    /// the meantime.
    private func clearPendingRegistrationIfMatches(token: String, sessionId: String) {
        guard let pending = readPendingRegistration() else { return }
        guard pending.token == token, pending.sessionId == sessionId else { return }
        SharedKeychain.remove(SharedKeychain.pendingPushRegistrationKey)
    }

    private func readPendingRegistration() -> (token: String, sessionId: String, serverUrl: String, graphqlUrl: String)? {
        guard let json = SharedKeychain.get(SharedKeychain.pendingPushRegistrationKey),
              let data = json.data(using: .utf8),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: String],
              let token = obj["token"], !token.isEmpty,
              let sessionId = obj["sessionId"], !sessionId.isEmpty,
              let serverUrl = obj["serverUrl"], !serverUrl.isEmpty,
              // graphqlUrl was added in the same release that fixed the
              // wrong-host registration bug. Records written by earlier builds
              // lack it; discard them so we don't retry against a stale URL.
              // ActivityKit will deliver a fresh push token shortly after
              // foregrounding, which kicks off a new registration with the
              // correct URL.
              let graphqlUrl = obj["graphqlUrl"], !graphqlUrl.isEmpty
        else { return nil }
        return (token: token, sessionId: sessionId, serverUrl: serverUrl, graphqlUrl: graphqlUrl)
    }

    /// Kick off a push-token registration with exponential retries.
    ///
    /// Bumps the active registration generation, so any in-flight retry chain
    /// from a previous call aborts on its next tick. Persists a pending record
    /// to the shared keychain so foreground / WS-reconnect hooks can retry
    /// later. Safe to call from any thread.
    private func registerPushTokenWithBackend(token: String, sessionId: String, serverUrl: String, graphqlUrl: String) {
        let generation = tokenQueue.sync { () -> UInt64 in
            _activeRegistrationGeneration += 1
            return _activeRegistrationGeneration
        }
        writePendingRegistration(token: token, sessionId: sessionId, serverUrl: serverUrl, graphqlUrl: graphqlUrl)
        scheduleRegistrationAttempt(
            token: token, sessionId: sessionId, serverUrl: serverUrl, graphqlUrl: graphqlUrl,
            attemptIndex: 0, generation: generation
        )
    }

    private func scheduleRegistrationAttempt(
        token: String, sessionId: String, serverUrl: String, graphqlUrl: String,
        attemptIndex: Int, generation: UInt64
    ) {
        guard attemptIndex < pushRegistrationRetryDelays.count else {
            logger.error(
                "Push token registration exhausted retries (\(self.pushRegistrationRetryDelays.count, privacy: .public)); leaving pending record for later retry"
            )
            return
        }
        let delay = pushRegistrationRetryDelays[attemptIndex]
        let work: () -> Void = { [weak self] in
            self?.attemptRegistration(
                token: token, sessionId: sessionId, serverUrl: serverUrl, graphqlUrl: graphqlUrl,
                attemptIndex: attemptIndex, generation: generation
            )
        }
        if delay == 0 {
            DispatchQueue.global(qos: .utility).async(execute: work)
        } else {
            DispatchQueue.global(qos: .utility).asyncAfter(deadline: .now() + delay, execute: work)
        }
    }

    private func attemptRegistration(
        token: String, sessionId: String, serverUrl: String, graphqlUrl: String,
        attemptIndex: Int, generation: UInt64
    ) {
        // Treat both a session-mismatch AND a nil active session as "abort":
        // nil means `endSession` has already cleared module state, so an
        // in-flight retry must not re-register a token for a session the user
        // has just left. A superseding `registerPushTokenWithBackend` call
        // also aborts us via the generation counter.
        let (activeSessionId, activeGeneration) = tokenQueue.sync {
            (_currentSessionId, _activeRegistrationGeneration)
        }
        guard activeSessionId == sessionId else {
            logger.info(
                "Aborting stale push token registration: active session is \(activeSessionId ?? "nil", privacy: .public), retry was for \(sessionId, privacy: .public)"
            )
            return
        }
        guard activeGeneration == generation else {
            logger.info(
                "Aborting superseded push token registration (generation \(generation, privacy: .public) < \(activeGeneration, privacy: .public))"
            )
            return
        }

        // The backend resolver authenticates via ConnectionContext, so we MUST
        // attach the user's app auth token. Without it the resolver rejects.
        guard let authToken = SharedKeychain.get(SharedKeychain.authTokenKey),
              !authToken.isEmpty
        else {
            logger.warning(
                "Skipping push token registration (attempt \(attemptIndex + 1, privacy: .public)): no auth token in keychain"
            )
            // Without an auth token, retrying immediately won't help. Leave
            // the pending record in place — the foreground / WS-connected
            // hook will pick it up once the user is signed in again.
            return
        }

        let query = """
        mutation RegisterToken($sessionId: ID!, $token: String!) {
          registerActivityPushToken(sessionId: $sessionId, token: $token)
        }
        """
        let body: [String: Any] = [
            "query": query,
            "variables": ["sessionId": sessionId, "token": token]
        ]
        guard let url = URL(string: graphqlUrl),
              let jsonData = try? JSONSerialization.data(withJSONObject: body) else { return }

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("Bearer \(authToken)", forHTTPHeaderField: "Authorization")
        request.timeoutInterval = 15
        request.httpBody = jsonData

        URLSession.shared.dataTask(with: request) { [weak self] data, response, error in
            guard let self else { return }

            var failureReason: String?
            if let error = error {
                failureReason = error.localizedDescription
            } else if let httpResponse = response as? HTTPURLResponse,
                      !(200...299).contains(httpResponse.statusCode) {
                failureReason = "HTTP \(httpResponse.statusCode)"
            } else if let graphQLError = Self.graphQLErrorMessage(from: data) {
                failureReason = graphQLError
            }

            if let failureReason {
                let nextAttemptIndex = attemptIndex + 1
                if nextAttemptIndex < self.pushRegistrationRetryDelays.count {
                    self.logger.warning(
                        "Push token registration attempt \(attemptIndex + 1, privacy: .public) failed (\(failureReason, privacy: .public)); retrying in \(self.pushRegistrationRetryDelays[nextAttemptIndex], privacy: .public)s"
                    )
                    self.scheduleRegistrationAttempt(
                        token: token, sessionId: sessionId, serverUrl: serverUrl, graphqlUrl: graphqlUrl,
                        attemptIndex: nextAttemptIndex, generation: generation
                    )
                } else {
                    self.logger.error(
                        "Push token registration failed after \(self.pushRegistrationRetryDelays.count, privacy: .public) attempts (\(failureReason, privacy: .public)); pending record retained for foreground retry"
                    )
                }
                return
            }

            // Only clear the pending record if it still describes this
            // (token, sessionId). A later startSession may have already
            // written a fresh record we mustn't wipe.
            self.clearPendingRegistrationIfMatches(token: token, sessionId: sessionId)
            self.logger.info("Push token registered with backend (attempt \(attemptIndex + 1, privacy: .public))")
        }.resume()
    }

    /// Trigger another registration attempt from any persisted pending record.
    /// Called on app foreground and on WebSocket reconnect.
    ///
    /// If the pending record is for a different session than the currently
    /// active one (force-quit during session A, started session B), drop the
    /// orphan rather than letting it accumulate in the keychain across
    /// installs.
    private func retryPendingRegistrationIfNeeded(trigger: String) {
        guard let pending = readPendingRegistration() else { return }
        let activeSessionId = tokenQueue.sync { _currentSessionId }
        if let activeSessionId, activeSessionId != pending.sessionId {
            logger.info(
                "Discarding orphan pending push registration (\(trigger, privacy: .public)): active session \(activeSessionId, privacy: .public) ≠ pending \(pending.sessionId, privacy: .public)"
            )
            clearPendingRegistration()
            return
        }
        if activeSessionId == nil {
            // No session is active — nothing to register against. Wait for
            // the next startSession to either re-register or clear.
            return
        }
        logger.info("Retrying pending push token registration (\(trigger, privacy: .public))")
        registerPushTokenWithBackend(
            token: pending.token,
            sessionId: pending.sessionId,
            serverUrl: pending.serverUrl,
            graphqlUrl: pending.graphqlUrl
        )
    }

    private func unregisterPushTokenFromBackend(token: String, sessionId: String, graphqlUrl: String) {
        // The backend resolver authenticates via ConnectionContext, so we MUST
        // attach the user's app auth token. Without it the resolver rejects.
        guard let authToken = SharedKeychain.get(SharedKeychain.authTokenKey),
              !authToken.isEmpty
        else {
            logger.warning("Skipping push token unregistration: no auth token in keychain")
            return
        }

        let query = """
        mutation UnregisterToken($sessionId: ID!, $token: String!) {
          unregisterActivityPushToken(sessionId: $sessionId, token: $token)
        }
        """
        let body: [String: Any] = [
            "query": query,
            "variables": ["sessionId": sessionId, "token": token]
        ]
        guard let url = URL(string: graphqlUrl),
              let jsonData = try? JSONSerialization.data(withJSONObject: body) else { return }

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("Bearer \(authToken)", forHTTPHeaderField: "Authorization")
        request.httpBody = jsonData

        URLSession.shared.dataTask(with: request) { [weak self] data, response, error in
            if let error = error {
                self?.logger.error("Failed to unregister push token: \(error.localizedDescription, privacy: .public)")
            } else if let httpResponse = response as? HTTPURLResponse,
                      !(200...299).contains(httpResponse.statusCode) {
                self?.logger.error("Failed to unregister push token: HTTP \(httpResponse.statusCode, privacy: .public)")
            } else if let graphQLError = Self.graphQLErrorMessage(from: data) {
                self?.logger.error("Failed to unregister push token: \(graphQLError, privacy: .public)")
            } else {
                self?.logger.info("Push token unregistered from backend")
            }
        }.resume()
    }

    private static func graphQLErrorMessage(from data: Data?) -> String? {
        guard let data,
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let errors = json["errors"] as? [[String: Any]],
              !errors.isEmpty
        else {
            return nil
        }

        let messages = errors.compactMap { $0["message"] as? String }
        if messages.isEmpty {
            return "GraphQL returned errors"
        }
        return messages.joined(separator: "; ")
    }

    // MARK: - isAvailable

    @objc func isAvailable(_ call: CAPPluginCall) {
        if #available(iOS 17.0, *) {
            let available = LiveActivityManager.shared.isAvailable
            call.resolve(["available": available])
        } else {
            call.resolve(["available": false])
        }
    }

    // MARK: - startSession

    @objc func startSession(_ call: CAPPluginCall) {
        guard #available(iOS 17.0, *) else {
            call.reject("Live Activities require iOS 17.0 or later")
            return
        }

        guard let sessionId = call.getString("sessionId") else {
            call.reject("Missing required parameter: sessionId")
            return
        }

        guard let serverUrl = call.getString("serverUrl") else {
            call.reject("Missing required parameter: serverUrl")
            return
        }

        guard let boardName = call.getString("boardName") else {
            call.reject("Missing required parameter: boardName")
            return
        }

        let layoutId = call.getInt("layoutId") ?? 0
        let sizeId = call.getInt("sizeId") ?? 0
        let setIds = call.getString("setIds") ?? ""
        let authToken = call.getString("authToken")
        let wsUrl = call.getString("wsUrl")
        // Backend GraphQL endpoint. The web origin (`serverUrl`) does not
        // serve `/graphql` — that route is on the backend host (e.g.
        // ws.boardsesh.com). Without this, registerActivityPushToken hits
        // the web origin and 404s silently.
        let graphqlUrl = call.getString("graphqlUrl")
        let widgetNavigationAllowed = call.getBool("widgetNavigationAllowed") ?? true
        let isPartySession = call.getBool("isPartySession") ?? false

        // Store session details for push token registration.
        tokenQueue.sync {
            _currentServerUrl = serverUrl
            _currentGraphqlUrl = graphqlUrl
            _currentSessionId = sessionId
        }

        // Derive the widget navigate URL from the backend GraphQL URL —
        // they share host + scheme, just different paths.
        let widgetNavigateUrl: String? = {
            guard let graphqlUrl, var components = URLComponents(string: graphqlUrl) else { return nil }
            components.path = "/api/widget/navigate"
            components.query = nil
            components.fragment = nil
            return components.url?.absoluteString
        }()
        let widgetTakeControlUrl: String? = {
            guard let graphqlUrl, var components = URLComponents(string: graphqlUrl) else { return nil }
            components.path = "/api/widget/take-control"
            components.query = nil
            components.fragment = nil
            return components.url?.absoluteString
        }()

        // Store board details in shared UserDefaults for App Intents
        // and thumbnail URL construction. Auth + push tokens go through
        // the shared Keychain instead — App Group UserDefaults are
        // unencrypted on disk and we don't want Bearer credentials there.
        if let defaults = SharedConstants.sharedDefaults {
            defaults.set(sessionId, forKey: SharedConstants.sessionIdKey)
            defaults.set(serverUrl, forKey: SharedConstants.serverUrlKey)
            if let widgetNavigateUrl {
                defaults.set(widgetNavigateUrl, forKey: SharedConstants.widgetNavigateUrlKey)
            }
            if let widgetTakeControlUrl {
                defaults.set(widgetTakeControlUrl, forKey: SharedConstants.widgetTakeControlUrlKey)
            }
            defaults.set(boardName, forKey: SharedConstants.boardNameKey)
            defaults.set(layoutId, forKey: SharedConstants.layoutIdKey)
            defaults.set(sizeId, forKey: SharedConstants.sizeIdKey)
            defaults.set(setIds, forKey: SharedConstants.setIdsKey)
            SharedWidgetWallControlState.save(
                navigationAllowed: widgetNavigationAllowed,
                isPartySession: isPartySession,
                to: defaults
            )
        }
        if let authToken = authToken {
            if authToken.isEmpty {
                logger.warning("Skipping shared keychain auth token write: authToken was empty")
            } else if !SharedKeychain.set(authToken, for: SharedKeychain.authTokenKey) {
                logger.error("Failed to write auth token to shared keychain")
            }
        } else {
            logger.debug("Skipping shared keychain auth token write: authToken was not provided")
        }

        // For party mode (real session), connect the WebSocket manager
        // so queue updates flow through to the Live Activity.
        // Set callback BEFORE connect to avoid race where a fast connection
        // fires events before the callback is installed.
        let wsManager = SessionWebSocketManager.shared
        let activityManager = LiveActivityManager.shared

        wsManager.onQueueStateChanged = { [weak self] items, currentIndex in
            guard let self else { return }
            guard let state = LiveActivityManager.buildContentState(
                items: items,
                currentIndex: currentIndex
            ) else {
                self.logger.debug("Queue state changed but no valid content state could be built")
                return
            }
            Task {
                await activityManager.updateActivity(state: state)
            }
        }

        // On reconnect (initial or recovery), retry any pending push-token
        // registration that previously failed. The first WS connection often
        // beats the ActivityKit push-token callback, so the foreground/Darwin
        // observers below also cover the case where there's nothing pending
        // until ActivityKit emits.
        wsManager.onConnected = { [weak self] in
            self?.retryPendingRegistrationIfNeeded(trigger: "ws-connect")
        }

        // Connect after callback is set to ensure no events are missed.
        wsManager.connect(serverUrl: serverUrl, sessionId: sessionId, authToken: authToken, wsUrl: wsUrl)

        // Observe widget navigation intents and forward to JS.
        startDarwinObservation()
        // Observe widget 410 hints and app foreground transitions so we can
        // retry push-token registration in both directions.
        startPushRegistrationStaleObservation()
        startForegroundObservation()

        // Start the Live Activity with an initial "Loading..." state.
        let initialState = ClimbSessionAttributes.ContentState(
            climbName: "Loading...",
            climbDifficulty: "",
            angle: 0,
            currentIndex: 0,
            totalClimbs: 0,
            hasNext: false,
            hasPrevious: false,
            climbUuid: ""
        )

        // Build the push-token callback up front so it's installed atomically
        // with the activity creation — ActivityKit can emit the first token
        // before a follow-up setOnPushTokenUpdate would land, which would
        // silently drop it.
        let pushTokenHandler: @Sendable (String) -> Void = { [weak self] token in
            guard let self else { return }
            // Single sync block: write the token and read sessionId/serverUrl/
            // graphqlUrl in one critical section. Two separate tokenQueue.sync
            // calls would deadlock if ActivityKit ever delivers the token on a
            // thread already holding the queue (Swift serial DispatchQueues
            // are not reentrant).
            let (sid, surl, gurl) = self.tokenQueue.sync { () -> (String?, String?, String?) in
                self._currentPushToken = token
                return (self._currentSessionId, self._currentServerUrl, self._currentGraphqlUrl)
            }
            // Write the APNs push token to the shared keychain so the
            // widget extension can attach it as a Bearer header on
            // /api/widget/navigate calls.
            if !SharedKeychain.set(token, for: SharedKeychain.livePushTokenKey) {
                self.logger.error("Failed to write Live Activity push token to shared keychain")
            }
            if let sessionId = sid, let serverUrl = surl, let graphqlUrl = gurl {
                self.registerPushTokenWithBackend(token: token, sessionId: sessionId, serverUrl: serverUrl, graphqlUrl: graphqlUrl)
            } else {
                self.logger.warning(
                    "Received push token but cannot register (sessionId=\(sid ?? "nil", privacy: .public), serverUrl=\(surl ?? "nil", privacy: .public), graphqlUrl=\(gurl ?? "nil", privacy: .public))"
                )
            }
        }

        Task {
            do {
                try await activityManager.startActivity(
                    boardName: boardName,
                    sessionId: sessionId,
                    initialState: initialState,
                    onPushTokenUpdate: pushTokenHandler
                )
                self.logger.info("Started session \(sessionId, privacy: .public) with Live Activity")
                call.resolve()
            } catch {
                self.logger.error("Failed to start Live Activity: \(error.localizedDescription, privacy: .public)")
                call.reject("Failed to start Live Activity: \(error.localizedDescription)")
            }
        }
    }

    // MARK: - endSession

    @objc func endSession(_ call: CAPPluginCall) {
        stopDarwinObservation()
        stopPushRegistrationStaleObservation()
        stopForegroundObservation()

        // Unregister the push token from the backend before tearing down.
        let (token, sessionId, graphqlUrl) = tokenQueue.sync {
            (_currentPushToken, _currentSessionId, _currentGraphqlUrl)
        }
        if let token, let sessionId, let graphqlUrl {
            unregisterPushTokenFromBackend(token: token, sessionId: sessionId, graphqlUrl: graphqlUrl)
        }
        tokenQueue.sync {
            _currentPushToken = nil
            _currentServerUrl = nil
            _currentGraphqlUrl = nil
            _currentSessionId = nil
        }
        // Drop any in-flight pending registration so a stale retry can't
        // resurrect the token after the session ended.
        clearPendingRegistration()

        let wsManager = SessionWebSocketManager.shared
        wsManager.onQueueStateChanged = nil
        wsManager.onConnected = nil
        wsManager.disconnect()

        // Clear shared UserDefaults queue state.
        if let defaults = SharedConstants.sharedDefaults {
            defaults.removeObject(forKey: SharedConstants.queueItemsKey)
            defaults.removeObject(forKey: SharedConstants.currentIndexKey)
            defaults.removeObject(forKey: SharedConstants.sessionIdKey)
            defaults.removeObject(forKey: SharedConstants.pendingActionKey)
            defaults.removeObject(forKey: SharedConstants.widgetNavigateUrlKey)
            defaults.removeObject(forKey: SharedConstants.widgetTakeControlUrlKey)
            defaults.removeObject(forKey: SharedConstants.widgetNavigationAllowedKey)
            defaults.removeObject(forKey: SharedConstants.partySessionKey)
            // Cover earlier builds that wrote tokens to UserDefaults so
            // we don't leave plaintext credentials behind after upgrade.
            defaults.removeObject(forKey: SharedConstants.authTokenKey)
            defaults.removeObject(forKey: SharedConstants.livePushTokenKey)
        }
        SharedKeychain.remove(SharedKeychain.authTokenKey)
        SharedKeychain.remove(SharedKeychain.livePushTokenKey)

        if #available(iOS 17.0, *) {
            Task {
                await LiveActivityManager.shared.endAllActivities()
                self.logger.info("Ended session and cleaned up Live Activity")
                call.resolve()
            }
        } else {
            logger.info("Ended session")
            call.resolve()
        }
    }

    // MARK: - updateActivity

    @objc func updateActivity(_ call: CAPPluginCall) {
        guard #available(iOS 17.0, *) else {
            call.reject("Live Activities require iOS 17.0 or later")
            return
        }

        let climbName = call.getString("climbName") ?? ""
        let climbDifficulty = call.getString("climbDifficulty") ?? ""
        let angle = call.getInt("angle") ?? 0
        let currentIndex = call.getInt("currentIndex") ?? 0
        let totalClimbs = call.getInt("totalClimbs") ?? 0
        let hasNext = call.getBool("hasNext") ?? false
        let hasPrevious = call.getBool("hasPrevious") ?? false
        let climbUuid = call.getString("climbUuid") ?? ""
        let widgetNavigationAllowed = call.getBool("widgetNavigationAllowed") ?? true
        let isPartySession = call.getBool("isPartySession") ?? false

        // Parse the queue array from the call and store in shared UserDefaults
        // so App Intents can navigate locally.
        var wallControlChanged = false
        if let defaults = SharedConstants.sharedDefaults {
            let previousWallControl = SharedWidgetWallControlState.load(from: defaults)
            wallControlChanged =
                previousWallControl.navigationAllowed != widgetNavigationAllowed ||
                previousWallControl.requiresServerAuthorization != isPartySession

            var queueItems: [SharedQueueItem] = []

            if let queueArray = call.getArray("queue") as? [JSObject] {
                for item in queueArray {
                    let itemUuid = item["uuid"] as? String ?? ""
                    let itemClimbUuid = item["climbUuid"] as? String ?? ""
                    let itemClimbName = item["climbName"] as? String ?? ""
                    let itemDifficulty = item["difficulty"] as? String ?? ""
                    let itemAngle = item["angle"] as? Int ?? 0
                    let itemFrames = item["frames"] as? String ?? ""
                    let itemSetterUsername = item["setterUsername"] as? String ?? ""
                    let itemMirrored = item["mirrored"] as? Bool ?? false

                    queueItems.append(SharedQueueItem(
                        uuid: itemUuid,
                        climbUuid: itemClimbUuid,
                        climbName: itemClimbName,
                        difficulty: itemDifficulty,
                        angle: itemAngle,
                        frames: itemFrames,
                        setterUsername: itemSetterUsername,
                        mirrored: itemMirrored
                    ))
                }
            }

            SharedQueueState.save(items: queueItems, currentIndex: currentIndex, to: defaults)
            SharedWidgetWallControlState.save(
                navigationAllowed: widgetNavigationAllowed,
                isPartySession: isPartySession,
                to: defaults
            )
        }

        // Build and push the new content state to the Live Activity.
        let state = ClimbSessionAttributes.ContentState(
            climbName: climbName,
            climbDifficulty: VGradeFormatter.formatVGrade(climbDifficulty),
            angle: angle,
            currentIndex: currentIndex,
            totalClimbs: totalClimbs,
            hasNext: hasNext,
            hasPrevious: hasPrevious,
            climbUuid: climbUuid
        )

        let activityManager = LiveActivityManager.shared

        Task {
            // Skip the ActivityKit push if the native WebSocket callback already
            // updated the Live Activity within the dedup window. The UserDefaults
            // write above still runs to keep state consistent.
            let elapsed = await activityManager.timeSinceLastUpdate()
            if !wallControlChanged, let elapsed, elapsed < SharedConstants.liveActivityDedupWindow {
                self.logger.debug("Skipping redundant ActivityKit push (\(Int(elapsed * 1000))ms since last native update)")
            } else {
                await activityManager.updateActivity(state: state)
            }
        }

        call.resolve()
    }

    // MARK: - updateActivityClimb (lightweight — no queue serialization)

    /// Lightweight update that only sends scalar climb data + current index.
    /// Skips re-encoding the full queue array to UserDefaults.
    /// Use this for climb navigation; use `updateActivity` for queue changes.
    @objc func updateActivityClimb(_ call: CAPPluginCall) {
        guard #available(iOS 17.0, *) else {
            call.reject("Live Activities require iOS 17.0 or later")
            return
        }

        let climbName = call.getString("climbName") ?? ""
        let climbDifficulty = call.getString("climbDifficulty") ?? ""
        let angle = call.getInt("angle") ?? 0
        let currentIndex = call.getInt("currentIndex") ?? 0
        let totalClimbs = call.getInt("totalClimbs") ?? 0
        let hasNext = call.getBool("hasNext") ?? false
        let hasPrevious = call.getBool("hasPrevious") ?? false
        let climbUuid = call.getString("climbUuid") ?? ""
        let widgetNavigationAllowed = call.getBool("widgetNavigationAllowed") ?? true
        let isPartySession = call.getBool("isPartySession") ?? false

        // Only update the current index in shared UserDefaults (not the full items array).
        var wallControlChanged = false
        if let defaults = SharedConstants.sharedDefaults {
            let previousWallControl = SharedWidgetWallControlState.load(from: defaults)
            wallControlChanged =
                previousWallControl.navigationAllowed != widgetNavigationAllowed ||
                previousWallControl.requiresServerAuthorization != isPartySession

            SharedQueueState.saveCurrentIndex(currentIndex, to: defaults)
            SharedWidgetWallControlState.save(
                navigationAllowed: widgetNavigationAllowed,
                isPartySession: isPartySession,
                to: defaults
            )
        }

        let state = ClimbSessionAttributes.ContentState(
            climbName: climbName,
            climbDifficulty: VGradeFormatter.formatVGrade(climbDifficulty),
            angle: angle,
            currentIndex: currentIndex,
            totalClimbs: totalClimbs,
            hasNext: hasNext,
            hasPrevious: hasPrevious,
            climbUuid: climbUuid
        )

        let activityManager = LiveActivityManager.shared

        Task {
            let elapsed = await activityManager.timeSinceLastUpdate()
            if !wallControlChanged, let elapsed, elapsed < SharedConstants.liveActivityDedupWindow {
                self.logger.debug("Skipping redundant climb ActivityKit push (\(Int(elapsed * 1000))ms since last native update)")
            } else {
                await activityManager.updateActivity(state: state)
            }
        }

        call.resolve()
    }
}
