import Foundation

// MARK: - graphql-ws Protocol Messages

enum GQLMessageType: String {
    case connectionInit = "connection_init"
    case connectionAck = "connection_ack"
    case subscribe = "subscribe"
    case next = "next"
    case error = "error"
    case complete = "complete"
    case ping = "ping"
    case pong = "pong"
}

// MARK: - Parsed Protocol Message

struct GQLMessage {
    let type: GQLMessageType
    let id: String?
    let payload: [String: Any]?

    static func parse(_ text: String) -> GQLMessage? {
        guard let data = text.data(using: .utf8),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let typeStr = json["type"] as? String,
              let type = GQLMessageType(rawValue: typeStr)
        else {
            return nil
        }
        let id = json["id"] as? String
        let payload = json["payload"] as? [String: Any]
        return GQLMessage(type: type, id: id, payload: payload)
    }
}

// MARK: - Queue Update Events

enum QueueUpdateEvent {
    case fullSync(items: [SharedQueueItem], currentItem: SharedQueueItem?, sequence: Int)
    case currentClimbChanged(item: SharedQueueItem?, sequence: Int)
    case itemAdded(item: SharedQueueItem, position: Int, sequence: Int)
    case itemRemoved(uuid: String, sequence: Int)
    case reordered(uuid: String, oldIndex: Int, newIndex: Int, sequence: Int)
    case climbMirrored(mirrored: Bool, sequence: Int)
}

// MARK: - Message Parsing Helpers

enum QueueMessageParser {

    /// Extract the `queueUpdates` dictionary from a graphql-ws `next` payload.
    static func extractQueueUpdates(from payload: [String: Any]?) -> [String: Any]? {
        guard let data = payload?["data"] as? [String: Any],
              let updates = data["queueUpdates"] as? [String: Any]
        else {
            return nil
        }
        return updates
    }

    /// Convert a raw climb+queue-item dictionary into a `SharedQueueItem`.
    static func parseQueueItem(_ dict: [String: Any]?) -> SharedQueueItem? {
        guard let dict = dict,
              let uuid = dict["uuid"] as? String,
              let climb = dict["climb"] as? [String: Any],
              let climbUuid = climb["uuid"] as? String
        else {
            return nil
        }

        let name = climb["name"] as? String ?? ""
        let difficulty = Self.parseDifficulty(climb["difficulty"])
        let angle = Self.parseIntValue(climb["angle"]) ?? 0
        let frames = climb["frames"] as? String ?? ""
        let setter = climb["setter_username"] as? String ?? ""

        return SharedQueueItem(
            uuid: uuid,
            climbUuid: climbUuid,
            climbName: name,
            difficulty: difficulty,
            angle: angle,
            frames: frames,
            setterUsername: setter
        )
    }

    /// Parse a FullSync event from the queueUpdates dictionary.
    static func parseFullSync(_ updates: [String: Any]) -> QueueUpdateEvent? {
        guard let state = updates["state"] as? [String: Any] else { return nil }
        let sequence = Self.parseIntValue(updates["sequence"]) ?? 0

        let queueArray = state["queue"] as? [[String: Any]] ?? []
        let items = queueArray.compactMap { parseQueueItem($0) }

        let currentItem = parseQueueItem(state["currentClimbQueueItem"] as? [String: Any])

        return .fullSync(items: items, currentItem: currentItem, sequence: sequence)
    }

    /// Parse a CurrentClimbChanged event.
    static func parseCurrentClimbChanged(_ updates: [String: Any]) -> QueueUpdateEvent? {
        let sequence = Self.parseIntValue(updates["sequence"]) ?? 0
        let item = parseQueueItem(updates["currentItem"] as? [String: Any])
        return .currentClimbChanged(item: item, sequence: sequence)
    }

    /// Parse a QueueItemAdded event.
    static func parseQueueItemAdded(_ updates: [String: Any]) -> QueueUpdateEvent? {
        let sequence = Self.parseIntValue(updates["sequence"]) ?? 0
        let position = Self.parseIntValue(updates["position"]) ?? 0
        let item = parseQueueItem(updates["addedItem"] as? [String: Any])
        guard let item = item else { return nil }
        return .itemAdded(item: item, position: position, sequence: sequence)
    }

    /// Parse a QueueItemRemoved event.
    static func parseQueueItemRemoved(_ updates: [String: Any]) -> QueueUpdateEvent? {
        guard let uuid = updates["uuid"] as? String else { return nil }
        let sequence = Self.parseIntValue(updates["sequence"]) ?? 0
        return .itemRemoved(uuid: uuid, sequence: sequence)
    }

    /// Parse a QueueReordered event.
    static func parseQueueReordered(_ updates: [String: Any]) -> QueueUpdateEvent? {
        guard let uuid = updates["uuid"] as? String else { return nil }
        let sequence = Self.parseIntValue(updates["sequence"]) ?? 0
        let oldIndex = Self.parseIntValue(updates["oldIndex"]) ?? 0
        let newIndex = Self.parseIntValue(updates["newIndex"]) ?? 0
        return .reordered(uuid: uuid, oldIndex: oldIndex, newIndex: newIndex, sequence: sequence)
    }

    /// Parse a ClimbMirrored event.
    static func parseClimbMirrored(_ updates: [String: Any]) -> QueueUpdateEvent? {
        let sequence = Self.parseIntValue(updates["sequence"]) ?? 0
        let mirrored = updates["mirrored"] as? Bool ?? false
        return .climbMirrored(mirrored: mirrored, sequence: sequence)
    }

    /// Route the queueUpdates dictionary to the correct parser based on __typename.
    static func parseQueueUpdate(_ updates: [String: Any]) -> QueueUpdateEvent? {
        guard let typename = updates["__typename"] as? String else { return nil }
        switch typename {
        case "FullSync":
            return parseFullSync(updates)
        case "CurrentClimbChanged":
            return parseCurrentClimbChanged(updates)
        case "QueueItemAdded":
            return parseQueueItemAdded(updates)
        case "QueueItemRemoved":
            return parseQueueItemRemoved(updates)
        case "QueueReordered":
            return parseQueueReordered(updates)
        case "ClimbMirrored":
            return parseClimbMirrored(updates)
        default:
            return nil
        }
    }

    /// Detect a sequence gap: returns true when `received` is more than one
    /// step ahead of `lastKnown`. A value of -1 for `lastKnown` means no
    /// previous sequence has been recorded (first message).
    static func hasSequenceGap(lastKnown: Int, received: Int) -> Bool {
        guard lastKnown >= 0 else { return false }
        return received > lastKnown + 1
    }

    // MARK: - Private Helpers

    static func parseDifficulty(_ value: Any?) -> String {
        if let str = value as? String { return str }
        if let num = value as? Double { return String(format: "%.1f", num) }
        if let num = value as? Int { return String(num) }
        return ""
    }

    static func parseIntValue(_ value: Any?) -> Int? {
        if let i = value as? Int { return i }
        if let d = value as? Double { return Int(d) }
        if let s = value as? String { return Int(s) }
        return nil
    }
}

// MARK: - WebSocket Message Delegate

protocol WebSocketMessageDelegate: AnyObject {
    func didReceiveRawMessage(_ text: String)
    func connectionStateDidChange(connected: Bool, reconnectAttempt: Int)
}

// MARK: - Session WebSocket Manager

final class SessionWebSocketManager {

    static let shared = SessionWebSocketManager()

    // MARK: - Callback

    /// Called whenever the queue state changes. Provides the full item list and
    /// the index of the current climb.
    private var _onQueueStateChanged: ((_ items: [SharedQueueItem], _ currentIndex: Int) -> Void)?

    var onQueueStateChanged: ((_ items: [SharedQueueItem], _ currentIndex: Int) -> Void)? {
        get { stateQueue.sync { _onQueueStateChanged } }
        set { stateQueue.sync { _onQueueStateChanged = newValue } }
    }

    // MARK: - Message Delegate

    private weak var _messageDelegate: WebSocketMessageDelegate?

    var messageDelegate: WebSocketMessageDelegate? {
        get { stateQueue.sync { _messageDelegate } }
        set { stateQueue.sync { _messageDelegate = newValue } }
    }

    // MARK: - Webview Buffering

    private var _isWebviewActive: Bool = true
    private var _messageBuffer: [String] = []
    private var _needsFullResync: Bool = false
    private let maxBufferSize = 500

    // MARK: - Configuration

    private var _sessionId: String?
    var sessionId: String? { stateQueue.sync { _sessionId } }
    private var _serverUrl: String?
    var serverUrl: String? { stateQueue.sync { _serverUrl } }
    private var _wsUrl: String?
    var wsUrl: String? { stateQueue.sync { _wsUrl } }
    private var _authToken: String?
    var authToken: String? { stateQueue.sync { _authToken } }

    // MARK: - Thread Safety

    /// Serial queue protecting all mutable state (isConnected, queueItems,
    /// currentIndex, pendingMutations, reconnectAttempt, webSocketTask, etc.).
    private let stateQueue = DispatchQueue(label: "com.boardsesh.SessionWebSocketManager.state")

    // MARK: - Connection State

    private var urlSession: URLSession
    private var webSocketTask: URLSessionWebSocketTask?
    private var _isConnected = false
    /// Thread-safe accessor for connection state.
    var isConnected: Bool {
        get { stateQueue.sync { _isConnected } }
    }
    private let internalSubscriptionId: String = "1"
    private var activeSubscriptionIds: Set<String> = ["1"]
    /// Stores query/variables for external subscriptions so they can be re-established after reconnect.
    private var externalSubscriptions: [String: (query: String, variables: [String: Any])] = [:]
    private var lastSequence: Int = -1

    // MARK: - Reconnection

    private var _reconnectAttempt: Int = 0
    /// Thread-safe accessor for reconnect attempt count.
    var reconnectAttempt: Int {
        get { stateQueue.sync { _reconnectAttempt } }
        // internal(set) so @testable import AppTests can write this in reconnect-delay tests
        set { stateQueue.sync { _reconnectAttempt = newValue } }
    }
    private var reconnectWorkItem: DispatchWorkItem?
    private let maxBackoff: TimeInterval = 30
    private let maxReconnectAttempts: Int = 20
    private var intentionalDisconnect = false

    // MARK: - Queue State

    private var queueItems: [SharedQueueItem] = []
    private var currentIndex: Int = 0
    private var pendingMutations: [String: Int] = [:]  // correlationId -> index before optimistic update

    // MARK: - Ping Timeout

    private var lastMessageReceived: Date = Date()
    private var pingTimeoutTimer: DispatchSourceTimer?
    private let pingTimeout: TimeInterval = 60

    // MARK: - Init

    init(urlSession: URLSession = .shared) {
        self.urlSession = urlSession
    }

    deinit {
        pingTimeoutTimer?.cancel()
    }

    // MARK: - Public API

    func connect(serverUrl: String, sessionId: String, authToken: String? = nil, wsUrl: String? = nil) {
        stateQueue.async { [weak self] in
            guard let self = self else { return }
            self._serverUrl = serverUrl
            self._sessionId = sessionId
            self._authToken = authToken
            self._wsUrl = wsUrl
            self.intentionalDisconnect = false
            self.lastSequence = -1
            self._openConnectionOnQueue()
        }
    }

    func disconnect() {
        stateQueue.async { [weak self] in
            guard let self = self else { return }
            self.intentionalDisconnect = true
            self.reconnectWorkItem?.cancel()
            self.reconnectWorkItem = nil
            self.pingTimeoutTimer?.cancel()
            self.pingTimeoutTimer = nil
            // Send complete for all active subscriptions before closing the task
            // Only send if connected (protocol requires connection_ack before any messages)
            if self._isConnected {
                for subId in self.activeSubscriptionIds {
                    let completeMsg: [String: Any] = [
                        "type": GQLMessageType.complete.rawValue,
                        "id": subId
                    ]
                    if let data = try? JSONSerialization.data(withJSONObject: completeMsg),
                       let text = String(data: data, encoding: .utf8) {
                        self.webSocketTask?.send(.string(text)) { _ in }
                    }
                }
            }
            self.activeSubscriptionIds = [self.internalSubscriptionId]
            self.externalSubscriptions.removeAll()
            self.webSocketTask?.cancel(with: .goingAway, reason: nil)
            self.webSocketTask = nil
            self._isConnected = false
            if let delegate = self._messageDelegate {
                DispatchQueue.main.async { delegate.connectionStateDidChange(connected: false, reconnectAttempt: 0) }
            }
        }
    }

    // MARK: - Webview Active / Buffering

    func setWebviewActive(_ active: Bool) {
        stateQueue.async { [weak self] in
            guard let self = self else { return }
            self._isWebviewActive = active
            if active {
                self._flushBufferOnQueue()
            }
        }
    }

    /// Must be called on `stateQueue`.
    private func _flushBufferOnQueue() {
        guard let delegate = _messageDelegate else {
            _messageBuffer.removeAll()
            _needsFullResync = false
            return
        }
        if _needsFullResync {
            _needsFullResync = false
            _messageBuffer.removeAll()
            DispatchQueue.main.async {
                delegate.didReceiveRawMessage("{\"type\":\"resync_needed\"}")
            }
        } else {
            let buffered = _messageBuffer
            _messageBuffer.removeAll()
            DispatchQueue.main.async {
                for message in buffered {
                    delegate.didReceiveRawMessage(message)
                }
            }
        }
    }

    // MARK: - Auth Token Update

    func updateAuthToken(_ token: String) {
        stateQueue.async { [weak self] in
            self?._authToken = token
        }
    }

    // MARK: - Generic Operation Sending

    func sendOperation(query: String, variables: [String: Any], operationId: String) {
        let message: [String: Any] = [
            "type": GQLMessageType.subscribe.rawValue,
            "id": operationId,
            "payload": [
                "query": query,
                "variables": variables
            ] as [String: Any]
        ]
        sendJSON(message)
    }

    // MARK: - External Subscription Management

    func addSubscription(query: String, variables: [String: Any], subscriptionId: String) {
        stateQueue.async { [weak self] in
            guard let self = self else { return }
            self.activeSubscriptionIds.insert(subscriptionId)
            self.externalSubscriptions[subscriptionId] = (query: query, variables: variables)
            // Only send if connected (protocol requires connection_ack first)
            guard self._isConnected else { return }
            self._sendSubscribeMessageOnQueue(subscriptionId: subscriptionId, query: query, variables: variables)
        }
    }

    func removeSubscription(_ subscriptionId: String) {
        stateQueue.async { [weak self] in
            guard let self = self else { return }
            self.activeSubscriptionIds.remove(subscriptionId)
            self.externalSubscriptions.removeValue(forKey: subscriptionId)
            guard self._isConnected else { return }
            let message: [String: Any] = [
                "type": GQLMessageType.complete.rawValue,
                "id": subscriptionId
            ]
            if let data = try? JSONSerialization.data(withJSONObject: message),
               let text = String(data: data, encoding: .utf8) {
                self.webSocketTask?.send(.string(text)) { error in
                    if let error = error {
                        print("[SessionWS] Send complete failed: \(error.localizedDescription)")
                    }
                }
            }
        }
    }

    /// Must be called on `stateQueue`.
    private func _sendSubscribeMessageOnQueue(subscriptionId: String, query: String, variables: [String: Any]) {
        let message: [String: Any] = [
            "type": GQLMessageType.subscribe.rawValue,
            "id": subscriptionId,
            "payload": [
                "query": query,
                "variables": variables
            ] as [String: Any]
        ]
        if let data = try? JSONSerialization.data(withJSONObject: message),
           let text = String(data: data, encoding: .utf8) {
            self.webSocketTask?.send(.string(text)) { error in
                if let error = error {
                    print("[SessionWS] Send subscribe failed: \(error.localizedDescription)")
                }
            }
        }
    }

    // MARK: - Connection Lifecycle

    private func openConnection() {
        stateQueue.async { [weak self] in
            self?._openConnectionOnQueue()
        }
    }

    /// Must be called on `stateQueue`.
    private func _openConnectionOnQueue() {
        guard let serverUrl = self._serverUrl else { return }

        let urlString: String
        if let wsUrl = self._wsUrl, !wsUrl.isEmpty {
            urlString = wsUrl
        } else {
            let wsScheme = serverUrl.hasPrefix("https") ? "wss" : "ws"
            let host = serverUrl
                .replacingOccurrences(of: "https://", with: "")
                .replacingOccurrences(of: "http://", with: "")
            urlString = "\(wsScheme)://\(host)/graphql"
        }

        guard let url = URL(string: urlString) else {
            print("[SessionWS] Failed to construct URL from: \(urlString) (serverUrl=\(serverUrl), wsUrl=\(self._wsUrl ?? "nil"))")
            return
        }

        let task = self.urlSession.webSocketTask(with: url, protocols: ["graphql-transport-ws"])
        self.webSocketTask = task
        task.resume()
        self.sendConnectionInit()
        self.listenForMessages(for: task)
    }

    // MARK: - graphql-ws Protocol Messages

    private func sendConnectionInit() {
        var payload: [String: Any] = [:]
        if let token = _authToken {
            payload["authToken"] = token
        }
        let message: [String: Any] = [
            "type": GQLMessageType.connectionInit.rawValue,
            "payload": payload
        ]
        sendJSON(message)
    }

    private func sendSubscription() {
        guard let sessionId = _sessionId else { return }

        let query = """
        subscription QueueUpdates($sessionId: ID!) {
          queueUpdates(sessionId: $sessionId) {
            __typename
            ... on FullSync {
              sequence
              state {
                sequence
                stateHash
                queue {
                  uuid
                  climb { uuid setter_username name frames angle ascensionist_count difficulty quality_average stars difficulty_error mirrored benchmark_difficulty }
                  addedBy
                  suggested
                }
                currentClimbQueueItem {
                  uuid
                  climb { uuid setter_username name frames angle ascensionist_count difficulty quality_average stars difficulty_error mirrored benchmark_difficulty }
                  addedBy
                  suggested
                }
              }
            }
            ... on CurrentClimbChanged {
              sequence
              currentItem: item {
                uuid
                climb { uuid setter_username name frames angle difficulty }
                addedBy
                suggested
              }
              clientId
              correlationId
            }
            ... on QueueItemAdded {
              sequence
              addedItem: item {
                uuid
                climb { uuid setter_username name frames angle difficulty }
                addedBy
                suggested
              }
              position
            }
            ... on QueueItemRemoved {
              sequence
              uuid
            }
            ... on QueueReordered {
              sequence
              uuid
              oldIndex
              newIndex
            }
            ... on ClimbMirrored {
              sequence
              mirrored
            }
          }
        }
        """

        let message: [String: Any] = [
            "type": GQLMessageType.subscribe.rawValue,
            "id": internalSubscriptionId,
            "payload": [
                "query": query,
                "variables": ["sessionId": sessionId]
            ]
        ]
        sendJSON(message)
    }

    private func sendJoinSession() {
        guard let sessionId = _sessionId else { return }

        // Build boardPath from shared UserDefaults (stored by LiveActivityPlugin.startSession)
        let defaults = SharedConstants.sharedDefaults
        let boardName = defaults?.string(forKey: SharedConstants.boardNameKey) ?? ""
        let layoutId = defaults?.integer(forKey: SharedConstants.layoutIdKey) ?? 0
        let sizeId = defaults?.integer(forKey: SharedConstants.sizeIdKey) ?? 0
        let setIds = defaults?.string(forKey: SharedConstants.setIdsKey) ?? ""
        let boardPath = "/\(boardName)/\(layoutId)/\(sizeId)/\(setIds)/0"

        let query = """
        mutation JoinSession($sessionId: ID!, $boardPath: String!) {
          joinSession(sessionId: $sessionId, boardPath: $boardPath) {
            id
            clientId
          }
        }
        """

        let joinId = "join-session"
        let message: [String: Any] = [
            "type": GQLMessageType.subscribe.rawValue,
            "id": joinId,
            "payload": [
                "query": query,
                "variables": [
                    "sessionId": sessionId,
                    "boardPath": boardPath,
                ] as [String: Any]
            ] as [String: Any]
        ]
        sendJSON(message)
    }

    private func sendComplete() {
        let message: [String: Any] = [
            "type": GQLMessageType.complete.rawValue,
            "id": internalSubscriptionId
        ]
        sendJSON(message)
    }

    private func sendPong() {
        sendJSON(["type": GQLMessageType.pong.rawValue])
    }

    private func sendSetCurrentClimb(item: SharedQueueItem, correlationId: String) {
        let query = """
        mutation SetCurrentClimb($item: ClimbQueueItemInput, $correlationId: ID) {
          setCurrentClimb(item: $item, correlationId: $correlationId) {
            uuid
            climb { uuid name difficulty }
          }
        }
        """

        let mutationId = "mutation-\(correlationId)"

        let climbInput: [String: Any] = [
            "uuid": item.climbUuid,
            "name": item.climbName,
            "frames": item.frames,
            "angle": item.angle,
            "difficulty": item.difficulty,
            "setter_username": item.setterUsername,
            "ascensionist_count": 0,
            "quality_average": "0",
            "stars": 0.0,
            "difficulty_error": "0",
        ]

        let itemInput: [String: Any] = [
            "uuid": item.uuid,
            "climb": climbInput,
            "addedBy": "",
            "suggested": false
        ]

        let message: [String: Any] = [
            "type": GQLMessageType.subscribe.rawValue,
            "id": mutationId,
            "payload": [
                "query": query,
                "variables": [
                    "item": itemInput,
                    "correlationId": correlationId
                ] as [String: Any]
            ] as [String: Any]
        ]
        sendJSON(message)
    }

    // MARK: - Message Handling

    private func listenForMessages(for task: URLSessionWebSocketTask) {
        task.receive { [weak self] result in
            guard let self = self else { return }
            switch result {
            case .success(let message):
                switch message {
                case .string(let text):
                    self.handleMessage(text)
                case .data(let data):
                    if let text = String(data: data, encoding: .utf8) {
                        self.handleMessage(text)
                    }
                @unknown default:
                    break
                }
                // Continue listening on the same task
                self.listenForMessages(for: task)

            case .failure(let error):
                print("[SessionWS] Receive failed: \(error.localizedDescription)")
                self.handleDisconnect(for: task)
            }
        }
    }

    private func handleMessage(_ text: String) {
        // Forward raw message to delegate BEFORE parsing
        stateQueue.async { [weak self] in
            guard let self = self else { return }
            self.lastMessageReceived = Date()
            self._forwardRawMessageOnQueue(text)
        }
        guard let msg = GQLMessage.parse(text) else { return }

        switch msg.type {
        case .connectionAck:
            stateQueue.async { [weak self] in
                guard let self = self else { return }
                self._isConnected = true
                self._reconnectAttempt = 0
                if let delegate = self._messageDelegate {
                    DispatchQueue.main.async { delegate.connectionStateDidChange(connected: true, reconnectAttempt: 0) }
                }
                self.sendJoinSession()
                self.sendSubscription()
                // Re-establish any external subscriptions after reconnect
                for (subId, sub) in self.externalSubscriptions {
                    self._sendSubscribeMessageOnQueue(subscriptionId: subId, query: sub.query, variables: sub.variables)
                }
            }
            startPingTimeoutTimer()

        case .ping:
            sendPong()

        case .next:
            handleNextMessage(msg)

        case .error:
            handleMutationError(msg)

        case .complete:
            handleMutationComplete(msg)

        default:
            break
        }
    }

    /// Must be called on `stateQueue`.
    private func _forwardRawMessageOnQueue(_ text: String) {
        guard let delegate = _messageDelegate else { return }
        if _isWebviewActive {
            // Dispatch off stateQueue to avoid blocking it on the Capacitor bridge
            DispatchQueue.main.async {
                delegate.didReceiveRawMessage(text)
            }
        } else {
            _messageBuffer.append(text)
            if _messageBuffer.count > maxBufferSize {
                _messageBuffer.removeAll()
                _needsFullResync = true
            }
        }
    }

    private func handleNextMessage(_ msg: GQLMessage) {
        guard let updates = QueueMessageParser.extractQueueUpdates(from: msg.payload) else { return }
        guard let event = QueueMessageParser.parseQueueUpdate(updates) else { return }

        let receivedSeq = sequenceFromEvent(event)

        // Sequence gap check and lastSequence update must be atomic
        stateQueue.async { [weak self] in
            guard let self = self else { return }

            if QueueMessageParser.hasSequenceGap(lastKnown: self.lastSequence, received: receivedSeq) {
                // Gap detected — cancel the current task so listenForMessages' failure
                // path calls handleDisconnect(), which schedules a reconnect and will
                // receive a FullSync restoring consistent state.
                print("[SessionWS] Sequence gap: expected \(self.lastSequence + 1), got \(receivedSeq) — reconnecting")
                self.webSocketTask?.cancel(with: .goingAway, reason: nil)
                return
            }
            self.lastSequence = receivedSeq

            // Apply event inline (already on stateQueue) rather than calling
            // applyEvent which would double-dispatch
            self.applyEventOnQueue(event)
        }
    }

    private func sequenceFromEvent(_ event: QueueUpdateEvent) -> Int {
        switch event {
        case .fullSync(_, _, let seq): return seq
        case .currentClimbChanged(_, let seq): return seq
        case .itemAdded(_, _, let seq): return seq
        case .itemRemoved(_, let seq): return seq
        case .reordered(_, _, _, let seq): return seq
        case .climbMirrored(_, let seq): return seq
        }
    }

    private func applyEvent(_ event: QueueUpdateEvent) {
        stateQueue.async { [weak self] in
            guard let self = self else { return }
            self.applyEventOnQueue(event)
        }
    }

    /// Applies a queue update event. MUST be called on `stateQueue`.
    private func applyEventOnQueue(_ event: QueueUpdateEvent) {
        switch event {
        case .fullSync(let items, let currentItem, _):
            queueItems = items
            if let currentItem = currentItem {
                currentIndex = items.firstIndex(where: { $0.uuid == currentItem.uuid }) ?? 0
            } else {
                currentIndex = 0
            }

        case .currentClimbChanged(let item, _):
            if let item = item {
                currentIndex = queueItems.firstIndex(where: { $0.uuid == item.uuid }) ?? currentIndex
            }

        case .itemAdded(let item, let position, _):
            let insertIndex = min(max(position, 0), queueItems.count)
            queueItems.insert(item, at: insertIndex)

        case .itemRemoved(let uuid, _):
            if let removeIndex = queueItems.firstIndex(where: { $0.uuid == uuid }) {
                queueItems.remove(at: removeIndex)
                if currentIndex >= queueItems.count {
                    currentIndex = max(0, queueItems.count - 1)
                }
            }

        case .reordered(let uuid, let oldIndex, let newIndex, _):
            guard oldIndex >= 0, oldIndex < queueItems.count else { return }
            let validOldItem = queueItems[oldIndex]
            // Prefer using the oldIndex if the uuid matches, otherwise search
            let item: SharedQueueItem
            if validOldItem.uuid == uuid {
                item = validOldItem
            } else if let found = queueItems.firstIndex(where: { $0.uuid == uuid }) {
                item = queueItems[found]
                queueItems.remove(at: found)
                let dest = min(max(newIndex, 0), queueItems.count)
                queueItems.insert(item, at: dest)
                persistAndNotify()
                return
            } else {
                return
            }
            queueItems.remove(at: oldIndex)
            let dest = min(max(newIndex, 0), queueItems.count)
            queueItems.insert(item, at: dest)

        case .climbMirrored:
            // Ignored for Live Activity display
            return
        }

        persistAndNotify()
    }

    private func persistAndNotify() {
        if let defaults = SharedConstants.sharedDefaults {
            SharedQueueState.save(items: queueItems, currentIndex: currentIndex, to: defaults)
        }
        if let callback = _onQueueStateChanged {
            let items = queueItems
            let index = currentIndex
            DispatchQueue.main.async {
                callback(items, index)
            }
        }
    }

    // MARK: - Reconnection

    private func handleDisconnect(for task: URLSessionWebSocketTask) {
        stateQueue.async { [weak self] in
            guard let self = self else { return }

            // Only process disconnect if this is still the current task.
            // A stale task from a previous connection must not tear down the
            // active connection.
            guard self.webSocketTask === task else {
                print("[SessionWS] Ignoring stale disconnect for superseded task")
                return
            }

            self._isConnected = false
            self.webSocketTask = nil
            self.pingTimeoutTimer?.cancel()
            self.pingTimeoutTimer = nil
            if let delegate = self._messageDelegate {
                let attempt = self._reconnectAttempt
                DispatchQueue.main.async { delegate.connectionStateDidChange(connected: false, reconnectAttempt: attempt) }
            }

            guard !self.intentionalDisconnect else { return }

            guard self._reconnectAttempt < self.maxReconnectAttempts else {
                print("[SessionWS] Max reconnect attempts (\(self.maxReconnectAttempts)) reached, giving up")
                return
            }

            let delay = self.reconnectDelay(attempt: self._reconnectAttempt)
            self._reconnectAttempt += 1

            let workItem = DispatchWorkItem { [weak self] in
                self?.openConnection()
            }
            self.reconnectWorkItem = workItem
            self.stateQueue.asyncAfter(deadline: .now() + delay, execute: workItem)
        }
    }

    func reconnectDelay(attempt: Int) -> TimeInterval {
        let base: TimeInterval = 1
        let exponential = base * pow(2, Double(attempt))
        return min(exponential, maxBackoff)
    }

    // MARK: - Widget Navigation

    /// Called by LiveActivityPlugin when the widget's Next/Previous intent fires.
    /// Sends the setCurrentClimb mutation over the native WebSocket.
    func navigateToItem(_ item: SharedQueueItem, at index: Int, totalItems items: [SharedQueueItem]) {
        stateQueue.async { [weak self] in
            guard let self = self else { return }

            // Sync internal state with SharedQueueState.
            self.queueItems = items
            let previousIndex = self.currentIndex
            self.currentIndex = index

            let correlationId = UUID().uuidString
            self.pendingMutations[correlationId] = previousIndex

            self.persistAndNotify()
            self.sendSetCurrentClimb(item: item, correlationId: correlationId)
        }
    }

    // MARK: - Mutation Response Handling

    private func handleMutationError(_ msg: GQLMessage) {
        guard let id = msg.id else { return }

        if id == "join-session" {
            // joinSession failed — the connection can't send mutations without a session.
            // Reconnect to retry.
            print("[SessionWS] joinSession failed — reconnecting")
            stateQueue.async { [weak self] in
                self?.webSocketTask?.cancel(with: .goingAway, reason: nil)
            }
            return
        }

        guard id.hasPrefix("mutation-") else { return }
        let correlationId = String(id.dropFirst("mutation-".count))
        // Server rejected the navigation — revert to the index before the optimistic update
        stateQueue.async { [weak self] in
            guard let self = self else { return }
            if let previousIndex = self.pendingMutations.removeValue(forKey: correlationId) {
                self.currentIndex = previousIndex
                self.persistAndNotify()
            }
        }
    }

    private func handleMutationComplete(_ msg: GQLMessage) {
        guard let id = msg.id else { return }
        if id == "join-session" { return } // joinSession completed successfully, nothing to clean up
        guard id.hasPrefix("mutation-") else { return }
        let correlationId = String(id.dropFirst("mutation-".count))
        // Mutation succeeded — clear the pending state
        stateQueue.async { [weak self] in
            self?.pendingMutations.removeValue(forKey: correlationId)
        }
    }

    // MARK: - Ping Timeout

    private func startPingTimeoutTimer() {
        stateQueue.async { [weak self] in
            guard let self = self else { return }
            self.pingTimeoutTimer?.cancel()
            let timer = DispatchSource.makeTimerSource(queue: self.stateQueue)
            timer.schedule(deadline: .now() + self.pingTimeout, repeating: self.pingTimeout)
            timer.setEventHandler { [weak self] in
                guard let self = self else { return }
                // Already on stateQueue — safe to read lastMessageReceived and webSocketTask
                let elapsed = Date().timeIntervalSince(self.lastMessageReceived)
                if elapsed > self.pingTimeout {
                    print("[SessionWS] Ping timeout — no message for \(Int(elapsed))s, reconnecting")
                    self.webSocketTask?.cancel(with: .goingAway, reason: nil)
                } else {
                    // Connection is healthy — push the Live Activity stale
                    // deadline forward so it doesn't show "Session ended".
                    if #available(iOS 16.1, *) {
                        Task {
                            await LiveActivityManager.shared.refreshStaleDate()
                        }
                    }
                }
            }
            timer.resume()
            self.pingTimeoutTimer = timer
        }
    }

    // MARK: - Transport Helpers

    private func sendJSON(_ dict: [String: Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: dict),
              let text = String(data: data, encoding: .utf8)
        else {
            print("[SessionWS] sendJSON: failed to serialize message")
            return
        }
        stateQueue.async { [weak self] in
            self?.webSocketTask?.send(.string(text)) { error in
                if let error = error {
                    print("[SessionWS] Send failed: \(error.localizedDescription)")
                }
            }
        }
    }
}
