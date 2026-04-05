import Capacitor
import os.log

@objc(NativeWebSocketPlugin)
public class NativeWebSocketPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "NativeWebSocketPlugin"
    public let jsName = "NativeWebSocket"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "connect", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "disconnect", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "sendOperation", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "subscribe", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "unsubscribe", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "updateAuthToken", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setWebviewActive", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "flushBuffer", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getConnectionState", returnType: CAPPluginReturnPromise),
    ]

    private let logger = Logger(subsystem: "com.boardsesh.app", category: "NativeWebSocketPlugin")
    private var observingAppLifecycle = false

    // MARK: - App Lifecycle

    private func startAppLifecycleObservation() {
        guard !observingAppLifecycle else { return }
        observingAppLifecycle = true

        NotificationCenter.default.addObserver(
            self,
            selector: #selector(appDidEnterBackground),
            name: UIApplication.didEnterBackgroundNotification,
            object: nil
        )
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(appWillEnterForeground),
            name: UIApplication.willEnterForegroundNotification,
            object: nil
        )
    }

    deinit {
        stopAppLifecycleObservation()
    }

    private func stopAppLifecycleObservation() {
        guard observingAppLifecycle else { return }
        observingAppLifecycle = false
        NotificationCenter.default.removeObserver(self, name: UIApplication.didEnterBackgroundNotification, object: nil)
        NotificationCenter.default.removeObserver(self, name: UIApplication.willEnterForegroundNotification, object: nil)
    }

    @objc private func appDidEnterBackground() {
        logger.debug("App entered background — buffering WS messages")
        SessionWebSocketManager.shared.setWebviewActive(false)
    }

    @objc private func appWillEnterForeground() {
        logger.debug("App entering foreground — flushing WS buffer")
        SessionWebSocketManager.shared.setWebviewActive(true)
    }

    // MARK: - connect

    @objc func connect(_ call: CAPPluginCall) {
        guard let serverUrl = call.getString("serverUrl") else {
            call.reject("Missing required parameter: serverUrl")
            return
        }

        guard let sessionId = call.getString("sessionId") else {
            call.reject("Missing required parameter: sessionId")
            return
        }

        let authToken = call.getString("authToken")
        let wsUrl = call.getString("wsUrl")

        let manager = SessionWebSocketManager.shared
        manager.messageDelegate = self
        manager.connect(serverUrl: serverUrl, sessionId: sessionId, authToken: authToken, wsUrl: wsUrl)

        startAppLifecycleObservation()

        logger.info("Connected to session \(sessionId, privacy: .public)")
        call.resolve()
    }

    // MARK: - disconnect

    @objc func disconnect(_ call: CAPPluginCall) {
        stopAppLifecycleObservation()

        let manager = SessionWebSocketManager.shared
        manager.messageDelegate = nil
        manager.disconnect()

        logger.info("Disconnected from session")
        call.resolve()
    }

    // MARK: - sendOperation

    @objc func sendOperation(_ call: CAPPluginCall) {
        guard let query = call.getString("query") else {
            call.reject("Missing required parameter: query")
            return
        }

        guard let operationId = call.getString("operationId") else {
            call.reject("Missing required parameter: operationId")
            return
        }

        let variables = parseVariables(call.getString("variables"))

        SessionWebSocketManager.shared.sendOperation(query: query, variables: variables, operationId: operationId)
        call.resolve()
    }

    // MARK: - subscribe

    @objc func subscribe(_ call: CAPPluginCall) {
        guard let query = call.getString("query") else {
            call.reject("Missing required parameter: query")
            return
        }

        guard let subscriptionId = call.getString("subscriptionId") else {
            call.reject("Missing required parameter: subscriptionId")
            return
        }

        let variables = parseVariables(call.getString("variables"))

        SessionWebSocketManager.shared.addSubscription(query: query, variables: variables, subscriptionId: subscriptionId)
        call.resolve()
    }

    // MARK: - unsubscribe

    @objc func unsubscribe(_ call: CAPPluginCall) {
        guard let subscriptionId = call.getString("subscriptionId") else {
            call.reject("Missing required parameter: subscriptionId")
            return
        }

        SessionWebSocketManager.shared.removeSubscription(subscriptionId)
        call.resolve()
    }

    // MARK: - updateAuthToken

    @objc func updateAuthToken(_ call: CAPPluginCall) {
        guard let token = call.getString("token") else {
            call.reject("Missing required parameter: token")
            return
        }

        SessionWebSocketManager.shared.updateAuthToken(token)
        call.resolve()
    }

    // MARK: - setWebviewActive

    @objc func setWebviewActive(_ call: CAPPluginCall) {
        guard let active = call.getBool("active") else {
            call.reject("Missing required parameter: active")
            return
        }

        SessionWebSocketManager.shared.setWebviewActive(active)
        call.resolve()
    }

    // MARK: - flushBuffer

    @objc func flushBuffer(_ call: CAPPluginCall) {
        SessionWebSocketManager.shared.setWebviewActive(true)
        call.resolve()
    }

    // MARK: - getConnectionState

    @objc func getConnectionState(_ call: CAPPluginCall) {
        let manager = SessionWebSocketManager.shared
        call.resolve([
            "connected": manager.isConnected,
            "reconnectAttempt": manager.reconnectAttempt,
        ])
    }

    // MARK: - Helpers

    private func parseVariables(_ jsonString: String?) -> [String: Any] {
        guard let jsonString = jsonString,
              let data = jsonString.data(using: .utf8),
              let parsed = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        else {
            return [:]
        }
        return parsed
    }
}

// MARK: - WebSocketMessageDelegate

extension NativeWebSocketPlugin: WebSocketMessageDelegate {
    func didReceiveRawMessage(_ text: String) {
        notifyListeners("wsMessage", data: ["raw": text])
    }

    func connectionStateDidChange(connected: Bool, reconnectAttempt: Int) {
        let state: String
        if connected {
            state = "connected"
        } else if reconnectAttempt > 0 {
            state = "reconnecting"
        } else {
            state = "disconnected"
        }
        notifyListeners("connectionStateChanged", data: [
            "state": state,
            "reconnectAttempt": reconnectAttempt,
        ])
    }
}
