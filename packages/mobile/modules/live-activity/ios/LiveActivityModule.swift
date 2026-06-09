import ExpoModulesCore
import ActivityKit
import UIKit
import os.log

/// Expo Module bridge to the ActivityKit / SessionWebSocket / push-token
/// machinery. Direct port of the Capacitor `LiveActivityPlugin` — the
/// private state machinery, retry chains, and Darwin observers are
/// preserved verbatim; only the outer bridge layer changes:
///
/// - `CAPPlugin` → `Module`
/// - `pluginMethods` declarations → `AsyncFunction` blocks in `definition()`
/// - `@objc func name(_ call: CAPPluginCall)` + `call.getX("k")` → `AsyncFunction("name") { (opts: Record) in ... }`
/// - `notifyListeners(name, data, retainUntilConsumed: true)` → buffered
///   `sendEvent(name, data)` so events queued before any JS listener attaches
///   are flushed on `OnStartObserving`
public class LiveActivityModule: Module {
    private let logger = Logger(subsystem: "com.boardsesh.app", category: "LiveActivityModule")
    private var observingDarwinNotification = false
    private var observingPushRegistrationStale = false
    private var observingForegroundNotification = false
    private var observingBleReconnect = false

    /// Serial queue protecting push token state accessed from both the JS-call
    /// thread and the LiveActivityManager push token callback.
    private let tokenQueue = DispatchQueue(label: "com.boardsesh.LiveActivityModule.token")
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

    // Replaces Capacitor's `retainUntilConsumed: true` event buffering.
    private struct PendingEvent {
        let name: String
        let body: [String: Any]
    }
    private let bufferQueue = DispatchQueue(label: "com.boardsesh.LiveActivityModule.buffer")
    private var pendingEvents: [PendingEvent] = []
    private var hasListener = false

    public func definition() -> ModuleDefinition {
        Name("LiveActivity")

        Events("queueNavigate")

        OnDestroy {
            self.stopDarwinObservation()
            self.stopPushRegistrationStaleObservation()
            self.stopForegroundObservation()
            self.stopBleReconnectObservation()
        }

        OnStartObserving {
            self.bufferQueue.sync {
                self.hasListener = true
                let buffered = self.pendingEvents
                self.pendingEvents = []
                for event in buffered {
                    self.sendEvent(event.name, event.body)
                }
            }
        }

        OnStopObserving {
            self.bufferQueue.sync {
                self.hasListener = false
            }
        }

        AsyncFunction("isAvailable") { () -> [String: Any] in
            if #available(iOS 17.0, *) {
                return ["available": LiveActivityManager.shared.isAvailable]
            }
            return ["available": false]
        }

        AsyncFunction("startSession") { (options: StartSessionOptions, promise: Promise) in
            self.startSession(options: options, promise: promise)
        }

        AsyncFunction("endSession") { (promise: Promise) in
            self.endSession(promise: promise)
        }

        AsyncFunction("updateActivity") { (options: UpdateActivityOptions) -> Void in
            self.updateActivity(options: options)
        }

        AsyncFunction("updateActivityClimb") { (options: UpdateActivityClimbOptions) -> Void in
            self.updateActivityClimb(options: options)
        }
    }

    // MARK: - Event emission

    private func emitOrBuffer(name: String, body: [String: Any]) {
        bufferQueue.sync {
            if hasListener {
                sendEvent(name, body)
            } else {
                pendingEvents.append(PendingEvent(name: name, body: body))
                if pendingEvents.count > 32 {
                    pendingEvents.removeFirst(pendingEvents.count - 32)
                }
            }
        }
    }

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
                let module = Unmanaged<LiveActivityModule>.fromOpaque(observer).takeUnretainedValue()
                module.handleQueueNavigateFromWidget()
            },
            name.rawValue,
            nil,
            .deliverImmediately
        )
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
                let module = Unmanaged<LiveActivityModule>.fromOpaque(observer).takeUnretainedValue()
                module.handlePushRegistrationStale()
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
        if let token, let sessionId, let serverUrl, let graphqlUrl {
            logger.info("Re-registering push token after widget 410")
            registerPushTokenWithBackend(token: token, sessionId: sessionId, serverUrl: serverUrl, graphqlUrl: graphqlUrl)
        } else {
            logger.warning("Push registration stale notification received but no current session/token to re-register")
        }
    }

    // MARK: - BLE reconnect (widget lightbulb fallback)

    /// Observe the Darwin notification ReconnectBoardIntent posts when iOS runs it
    /// in the widget extension (which can't link BoardBleManager). We reconnect on
    /// the main app's behalf. In the normal path the intent runs in this process
    /// and calls BoardBleManager directly, so this observer never fires.
    private func startBleReconnectObservation() {
        guard !observingBleReconnect else { return }
        observingBleReconnect = true

        let center = CFNotificationCenterGetDarwinNotifyCenter()
        let name = CFNotificationName(SharedConstants.bleReconnectNotification as CFString)
        let observer = Unmanaged.passUnretained(self).toOpaque()

        CFNotificationCenterAddObserver(
            center,
            observer,
            { (_, observer, _, _, _) in
                guard let observer = observer else { return }
                let module = Unmanaged<LiveActivityModule>.fromOpaque(observer).takeUnretainedValue()
                module.handleBleReconnectFromWidget()
            },
            name.rawValue,
            nil,
            .deliverImmediately
        )
    }

    private func stopBleReconnectObservation() {
        guard observingBleReconnect else { return }
        observingBleReconnect = false

        let center = CFNotificationCenterGetDarwinNotifyCenter()
        let observer = Unmanaged.passUnretained(self).toOpaque()
        let name = CFNotificationName(SharedConstants.bleReconnectNotification as CFString)
        CFNotificationCenterRemoveObserver(center, observer, name, nil)
    }

    private func handleBleReconnectFromWidget() {
        Task { @MainActor in
            _ = await LiveActivityBleBridge.reconnectForIntent()
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

        guard let action = defaults.string(forKey: SharedConstants.widgetNavigateActionKey) else {
            if let legacyAction = defaults.string(forKey: SharedConstants.pendingActionKey) {
                handleLegacyMutationFallback(defaults: defaults, action: legacyAction)
            }
            return
        }
        defaults.removeObject(forKey: SharedConstants.widgetNavigateActionKey)

        let needsMutationFallback = defaults.string(forKey: SharedConstants.pendingActionKey) != nil
        defaults.removeObject(forKey: SharedConstants.pendingActionKey)

        let (items, currentIndex) = SharedQueueState.load(from: defaults)

        let storedCorrelationId = defaults.string(forKey: SharedConstants.widgetNavigateCorrelationIdKey)
        defaults.removeObject(forKey: SharedConstants.widgetNavigateCorrelationIdKey)
        let correlationId = storedCorrelationId ?? UUID().uuidString

        if needsMutationFallback, !items.isEmpty, currentIndex >= 0, currentIndex < items.count {
            let item = items[currentIndex]
            SessionWebSocketManager.shared.navigateToItem(item, at: currentIndex, totalItems: items, correlationId: correlationId)
        }

        emitOrBuffer(name: "queueNavigate", body: [
            "action": action,
            "currentIndex": currentIndex,
            "correlationId": correlationId
        ])
    }

    private func handleLegacyMutationFallback(defaults: UserDefaults, action: String) {
        defaults.removeObject(forKey: SharedConstants.pendingActionKey)

        let (items, currentIndex) = SharedQueueState.load(from: defaults)
        let correlationId = UUID().uuidString

        if !items.isEmpty, currentIndex >= 0, currentIndex < items.count {
            let item = items[currentIndex]
            SessionWebSocketManager.shared.navigateToItem(item, at: currentIndex, totalItems: items, correlationId: correlationId)
        }

        emitOrBuffer(name: "queueNavigate", body: [
            "action": action,
            "currentIndex": currentIndex,
            "correlationId": correlationId
        ])
    }

    // MARK: - Push Token Registration

    private func writePendingRegistration(token: String, sessionId: String, serverUrl: String, graphqlUrl: String) {
        let payload: [String: String] = [
            "token": token,
            "sessionId": sessionId,
            "serverUrl": serverUrl,
            "graphqlUrl": graphqlUrl
        ]
        guard let data = try? JSONSerialization.data(withJSONObject: payload),
              let json = String(data: data, encoding: .utf8) else { return }
        if !SharedKeychain.set(json, for: SharedKeychain.pendingPushRegistrationKey) {
            logger.error("Failed to persist pending push registration")
        }
    }

    private func clearPendingRegistration() {
        SharedKeychain.remove(SharedKeychain.pendingPushRegistrationKey)
    }

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
              let graphqlUrl = obj["graphqlUrl"], !graphqlUrl.isEmpty
        else { return nil }
        return (token: token, sessionId: sessionId, serverUrl: serverUrl, graphqlUrl: graphqlUrl)
    }

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

        guard let authToken = SharedKeychain.get(SharedKeychain.authTokenKey),
              !authToken.isEmpty
        else {
            logger.warning(
                "Skipping push token registration (attempt \(attemptIndex + 1, privacy: .public)): no auth token in keychain"
            )
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

            self.clearPendingRegistrationIfMatches(token: token, sessionId: sessionId)
            self.logger.info("Push token registered with backend (attempt \(attemptIndex + 1, privacy: .public))")
        }.resume()
    }

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

    // MARK: - startSession

    private func startSession(options: StartSessionOptions, promise: Promise) {
        guard #available(iOS 17.0, *) else {
            promise.reject("LA_UNSUPPORTED", "Live Activities require iOS 17.0 or later")
            return
        }

        let sessionId = options.sessionId
        let serverUrl = options.serverUrl
        let boardName = options.boardName
        let layoutId = options.layoutId
        let sizeId = options.sizeId
        let setIds = options.setIds
        let authToken = options.authToken
        let wsUrl = options.wsUrl
        let graphqlUrl = options.graphqlUrl
        let widgetNavigationAllowed = options.widgetNavigationAllowed
        let isPartySession = options.isPartySession

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

        wsManager.onConnected = { [weak self] in
            self?.retryPendingRegistrationIfNeeded(trigger: "ws-connect")
        }

        wsManager.connect(serverUrl: serverUrl, sessionId: sessionId, authToken: authToken, wsUrl: wsUrl)

        startDarwinObservation()
        startPushRegistrationStaleObservation()
        startForegroundObservation()
        startBleReconnectObservation()

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

        let pushTokenHandler: @Sendable (String) -> Void = { [weak self] token in
            guard let self else { return }
            let (sid, surl, gurl) = self.tokenQueue.sync { () -> (String?, String?, String?) in
                self._currentPushToken = token
                return (self._currentSessionId, self._currentServerUrl, self._currentGraphqlUrl)
            }
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
                promise.resolve(nil)
            } catch {
                self.logger.error("Failed to start Live Activity: \(error.localizedDescription, privacy: .public)")
                promise.reject("LA_START_FAILED", "Failed to start Live Activity: \(error.localizedDescription)")
            }
        }
    }

    // MARK: - endSession

    private func endSession(promise: Promise) {
        stopDarwinObservation()
        stopPushRegistrationStaleObservation()
        stopForegroundObservation()
        stopBleReconnectObservation()

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
        clearPendingRegistration()

        let wsManager = SessionWebSocketManager.shared
        wsManager.onQueueStateChanged = nil
        wsManager.onConnected = nil
        wsManager.disconnect()

        if let defaults = SharedConstants.sharedDefaults {
            defaults.removeObject(forKey: SharedConstants.queueItemsKey)
            defaults.removeObject(forKey: SharedConstants.currentIndexKey)
            defaults.removeObject(forKey: SharedConstants.sessionIdKey)
            defaults.removeObject(forKey: SharedConstants.pendingActionKey)
            defaults.removeObject(forKey: SharedConstants.widgetNavigateUrlKey)
            defaults.removeObject(forKey: SharedConstants.widgetTakeControlUrlKey)
            defaults.removeObject(forKey: SharedConstants.authTokenKey)
            defaults.removeObject(forKey: SharedConstants.livePushTokenKey)
            defaults.removeObject(forKey: SharedConstants.widgetNavigationAllowedKey)
            defaults.removeObject(forKey: SharedConstants.partySessionKey)
        }
        SharedKeychain.remove(SharedKeychain.authTokenKey)
        SharedKeychain.remove(SharedKeychain.livePushTokenKey)

        if #available(iOS 17.0, *) {
            Task {
                await LiveActivityManager.shared.endAllActivities()
                self.logger.info("Ended session and cleaned up Live Activity")
                promise.resolve(nil)
            }
        } else {
            logger.info("Ended session")
            promise.resolve(nil)
        }
    }

    // MARK: - updateActivity

    private func updateActivity(options: UpdateActivityOptions) {
        guard #available(iOS 17.0, *) else { return }

        var wallControlChanged = false
        if let defaults = SharedConstants.sharedDefaults {
            let previousWallControl = SharedWidgetWallControlState.load(from: defaults)
            wallControlChanged =
                previousWallControl.navigationAllowed != options.widgetNavigationAllowed ||
                previousWallControl.requiresServerAuthorization != options.isPartySession

            var queueItems: [SharedQueueItem] = []
            for item in options.queue {
                queueItems.append(SharedQueueItem(
                    uuid: item.uuid,
                    climbUuid: item.climbUuid,
                    climbName: item.climbName,
                    difficulty: item.difficulty,
                    angle: item.angle,
                    frames: item.frames,
                    setterUsername: item.setterUsername,
                    mirrored: item.mirrored
                ))
            }
            SharedQueueState.save(items: queueItems, currentIndex: options.currentIndex, to: defaults)
            SharedWidgetWallControlState.save(
                navigationAllowed: options.widgetNavigationAllowed,
                isPartySession: options.isPartySession,
                to: defaults
            )
        }

        let state = ClimbSessionAttributes.ContentState(
            climbName: options.climbName,
            climbDifficulty: VGradeFormatter.formatVGrade(options.climbDifficulty),
            angle: options.angle,
            currentIndex: options.currentIndex,
            totalClimbs: options.totalClimbs,
            hasNext: options.hasNext,
            hasPrevious: options.hasPrevious,
            climbUuid: options.climbUuid
        )

        let activityManager = LiveActivityManager.shared
        Task {
            let elapsed = await activityManager.timeSinceLastUpdate()
            if !wallControlChanged, let elapsed, elapsed < SharedConstants.liveActivityDedupWindow {
                self.logger.debug("Skipping redundant ActivityKit push (\(Int(elapsed * 1000))ms since last native update)")
            } else {
                await activityManager.updateActivity(state: state)
            }
        }
    }

    // MARK: - updateActivityClimb (lightweight — no queue serialization)

    private func updateActivityClimb(options: UpdateActivityClimbOptions) {
        guard #available(iOS 17.0, *) else { return }

        var wallControlChanged = false
        if let defaults = SharedConstants.sharedDefaults {
            let previousWallControl = SharedWidgetWallControlState.load(from: defaults)
            wallControlChanged =
                previousWallControl.navigationAllowed != options.widgetNavigationAllowed ||
                previousWallControl.requiresServerAuthorization != options.isPartySession

            SharedQueueState.saveCurrentIndex(options.currentIndex, to: defaults)
            SharedWidgetWallControlState.save(
                navigationAllowed: options.widgetNavigationAllowed,
                isPartySession: options.isPartySession,
                to: defaults
            )
        }

        let state = ClimbSessionAttributes.ContentState(
            climbName: options.climbName,
            climbDifficulty: VGradeFormatter.formatVGrade(options.climbDifficulty),
            angle: options.angle,
            currentIndex: options.currentIndex,
            totalClimbs: options.totalClimbs,
            hasNext: options.hasNext,
            hasPrevious: options.hasPrevious,
            climbUuid: options.climbUuid
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
    }
}

// MARK: - Argument Records

struct StartSessionOptions: Record {
    @Field var sessionId: String = ""
    @Field var serverUrl: String = ""
    @Field var boardName: String = ""
    @Field var layoutId: Int = 0
    @Field var sizeId: Int = 0
    @Field var setIds: String = ""
    @Field var authToken: String?
    @Field var wsUrl: String?
    @Field var graphqlUrl: String?
    @Field var widgetNavigationAllowed: Bool = true
    @Field var isPartySession: Bool = false
}

struct UpdateActivityQueueItem: Record {
    @Field var uuid: String = ""
    @Field var climbUuid: String = ""
    @Field var climbName: String = ""
    @Field var difficulty: String = ""
    @Field var angle: Int = 0
    @Field var frames: String = ""
    @Field var setterUsername: String = ""
    @Field var mirrored: Bool = false
}

struct UpdateActivityOptions: Record {
    @Field var climbName: String = ""
    @Field var climbDifficulty: String = ""
    @Field var angle: Int = 0
    @Field var currentIndex: Int = 0
    @Field var totalClimbs: Int = 0
    @Field var hasNext: Bool = false
    @Field var hasPrevious: Bool = false
    @Field var climbUuid: String = ""
    @Field var queue: [UpdateActivityQueueItem] = []
    @Field var widgetNavigationAllowed: Bool = true
    @Field var isPartySession: Bool = false
}

struct UpdateActivityClimbOptions: Record {
    @Field var climbName: String = ""
    @Field var climbDifficulty: String = ""
    @Field var angle: Int = 0
    @Field var currentIndex: Int = 0
    @Field var totalClimbs: Int = 0
    @Field var hasNext: Bool = false
    @Field var hasPrevious: Bool = false
    @Field var climbUuid: String = ""
    @Field var widgetNavigationAllowed: Bool = true
    @Field var isPartySession: Bool = false
}
