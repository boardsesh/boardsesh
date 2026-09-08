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

// Queue event types, payload parsing, sequence acceptance, and the state
// reducer live in SessionQueueState.swift so they compile into the test
// target; this file owns the socket, timers, and side effects.

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

    /// Fires every time the WebSocket transitions to the connected state
    /// (initial connect AND reconnects). Used by `LiveActivityPlugin` to retry
    /// pending push-token registrations that failed while we were offline.
    private var _onConnected: (() -> Void)?

    var onConnected: (() -> Void)? {
        get { stateQueue.sync { _onConnected } }
        set { stateQueue.sync { _onConnected = newValue } }
    }

    // MARK: - Configuration

    private(set) var sessionId: String?
    private(set) var serverUrl: String?
    private(set) var wsUrl: String?
    private(set) var authToken: String?

    // MARK: - Thread Safety

    /// Serial queue protecting all mutable state (isConnected, queueItems,
    /// currentIndex, pendingMutations, reconnectAttempt, webSocketTask, etc.).
    private let stateQueue = DispatchQueue(label: "com.boardsesh.SessionWebSocketManager.state")

    // MARK: - Connection State

    private var urlSession: URLSession
    private var subscriptionSequence = -1
    private var webSocketTask: URLSessionWebSocketTask?
    private(set) var isConnected = false
    private var subscriptionId: String = "1"
    private var lastSequence: Int = -1

    // MARK: - Reconnection

    // internal(set) so @testable import AppTests can write this in reconnect-delay tests
    internal(set) var reconnectAttempt: Int = 0
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
            self.serverUrl = serverUrl
            self.sessionId = sessionId
            self.authToken = authToken
            self.wsUrl = wsUrl
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
            self.sendComplete()
            self.webSocketTask?.cancel(with: .goingAway, reason: nil)
            self.webSocketTask = nil
            self.isConnected = false
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
        guard let serverUrl = self.serverUrl else { return }

        // Cancel any existing connection before opening a new one to prevent
        // leaked tasks (e.g. multiple reconnects firing after backgrounding).
        self.webSocketTask?.cancel(with: .goingAway, reason: nil)

        // A fresh subscription starts a fresh sequence stream (the server's
        // FullSync carries the room's *current* sequence, not a continuation
        // of the old one), so a sequence carried over from the previous
        // connection must not gap-check the new stream.
        self.lastSequence = -1
        self.subscriptionSequence = SharedConstants.sharedDefaults.map { SharedMirrorState.sequence(in: $0) } ?? -1

        let urlString: String
        if let wsUrl = self.wsUrl, !wsUrl.isEmpty {
            urlString = wsUrl
        } else {
            let wsScheme = serverUrl.hasPrefix("https") ? "wss" : "ws"
            let host = serverUrl
                .replacingOccurrences(of: "https://", with: "")
                .replacingOccurrences(of: "http://", with: "")
            urlString = "\(wsScheme)://\(host)/graphql"
        }

        guard let url = URL(string: urlString) else {
            print("[SessionWS] Failed to construct URL from: \(urlString) (serverUrl=\(serverUrl), wsUrl=\(self.wsUrl ?? "nil"))")
            return
        }

        let task = self.urlSession.webSocketTask(with: url, protocols: ["graphql-transport-ws"])
        self.webSocketTask = task
        // Measure ping freshness from connect time. Without this, the first
        // ping-timeout window after a reconnect compares against the stale
        // pre-disconnect timestamp and can immediately tear the new socket
        // down if the server is quiet, churning through reconnect attempts.
        self.lastMessageReceived = Date()
        task.resume()
        self.sendConnectionInit()
        self.listenForMessages(for: task)
    }

    // MARK: - graphql-ws Protocol Messages

    private func sendConnectionInit() {
        var payload: [String: Any] = [:]
        if let token = authToken {
            payload["authToken"] = token
        }
        let message: [String: Any] = [
            "type": GQLMessageType.connectionInit.rawValue,
            "payload": payload
        ]
        sendJSON(message)
    }

    private func sendSubscription() {
        guard let sessionId = sessionId else { return }

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
                  climb { uuid setter_username name frames framesCount framesPace angle ascensionist_count difficulty quality_average stars difficulty_error mirrored benchmark_difficulty }
                  addedBy
                  suggested
                }
                currentClimbQueueItem {
                  uuid
                  climb { uuid setter_username name frames framesCount framesPace angle ascensionist_count difficulty quality_average stars difficulty_error mirrored benchmark_difficulty }
                  addedBy
                  suggested
                }
              }
            }
            ... on CurrentClimbChanged {
              sequence
              currentItem: item {
                uuid
                climb { uuid setter_username name frames framesCount framesPace angle difficulty mirrored }
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
                climb { uuid setter_username name frames framesCount framesPace angle difficulty mirrored }
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
              mirroredUuid: uuid
              mirrored
            }
          }
        }
        """

        let message: [String: Any] = [
            "type": GQLMessageType.subscribe.rawValue,
            "id": subscriptionId,
            "payload": [
                "query": query,
                "variables": ["sessionId": sessionId]
            ]
        ]
        sendJSON(message)
    }

    private func sendJoinSession() {
        guard let sessionId = sessionId else { return }

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
            "id": subscriptionId
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
            "mirrored": item.mirrored,
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
                self.handleReceiveFailure(error, for: task)
            }
        }
    }

    private func handleMessage(_ text: String) {
        stateQueue.async { [weak self] in
            guard let self = self else { return }
            self.lastMessageReceived = Date()
        }
        guard let msg = GQLMessage.parse(text) else { return }

        switch msg.type {
        case .connectionAck:
            stateQueue.async { [weak self] in
                guard let self = self else { return }
                self.isConnected = true
                // reconnectAttempt is deliberately NOT reset here. An ack only
                // proves the transport; resetting on it let deterministic
                // post-ack failures (subscription error, joinSession error)
                // reconnect forever because the max-attempts guard never
                // tripped. It resets in handleNextMessage once queue data
                // actually flows.
                self.sendJoinSession()
                self.sendSubscription()
                // Fire after join/subscribe so observers can rely on the
                // session being usable when they're invoked.
                if let onConnected = self._onConnected {
                    DispatchQueue.main.async {
                        onConnected()
                    }
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

    private func handleNextMessage(_ msg: GQLMessage) {
        guard let updates = QueueMessageParser.extractQueueUpdates(from: msg.payload) else { return }
        guard let event = QueueMessageParser.parseQueueUpdate(updates) else { return }

        // Sequence acceptance and lastSequence update must be atomic
        stateQueue.async { [weak self] in
            guard let self = self else { return }

            switch QueueSequencePolicy.decision(for: event, lastKnown: self.lastSequence) {
            case .resync:
                // Mid-stream gap — cancel the current task so listenForMessages'
                // failure path calls handleDisconnect(), which schedules a
                // reconnect whose FullSync restores consistent state.
                print("[SessionWS] Sequence gap: expected \(self.lastSequence + 1), got \(event.sequence) — reconnecting")
                self.webSocketTask?.cancel(with: .goingAway, reason: nil)
                return
            case .apply(let newLastSequence):
                self.lastSequence = newLastSequence
            }

            // Queue data is flowing — the connection is genuinely healthy, so
            // the backoff ladder restarts from the bottom on the next drop.
            self.reconnectAttempt = 0

            // Apply event inline (already on stateQueue) rather than calling
            // applyEvent which would double-dispatch
            self.applyEventOnQueue(event)
        }
    }

    /// Applies a queue update event. MUST be called on `stateQueue`.
    private func applyEventOnQueue(_ event: QueueUpdateEvent) {
        let newState = QueueStateReducer.apply(
            event,
            to: QueueStateReducer.QueueState(items: queueItems, currentIndex: currentIndex)
        )
        queueItems = newState.items
        currentIndex = newState.currentIndex
        let fullSyncSequence: Int?
        if case .fullSync = event { fullSyncSequence = subscriptionSequence } else { fullSyncSequence = nil }
        persistAndNotify(repaintBoard: QueueEventRepaintPolicy.shouldRepaintBoard(for: event), subscriptionSequence: fullSyncSequence)
    }

    private func persistAndNotify(repaintBoard: Bool = false, subscriptionSequence: Int? = nil) {
        if let defaults = SharedConstants.sharedDefaults {
            // HTTP mirror may be ahead of this socket's buffered deltas. Reduce those
            // internally until it catches up, without repainting an older wall state.
            guard SharedMirrorState.persist(items: queueItems, currentIndex: currentIndex, sequence: lastSequence, subscriptionSequence: subscriptionSequence, in: defaults) else {
                // The FullSync was requested before a newer mirror confirmation.
                // Reconnect so a fresh authoritative snapshot can safely rebaseline.
                if subscriptionSequence != nil { webSocketTask?.cancel(with: .goingAway, reason: nil) }
                return
            }
        }
        if repaintBoard {
            BoardBleManager.shared.displayCurrentItem(items: queueItems, currentIndex: currentIndex)
        }
        _onQueueStateChanged?(queueItems, currentIndex)
    }

    // MARK: - Reconnection

    private func handleDisconnect(for task: URLSessionWebSocketTask) {
        stateQueue.async { [weak self] in
            guard let self = self else { return }
            self.handleDisconnectOnQueue(for: task)
        }
    }

    private func handleReceiveFailure(_ error: Error, for task: URLSessionWebSocketTask) {
        stateQueue.async { [weak self] in
            guard let self = self else { return }
            if self.webSocketTask === task && !self.intentionalDisconnect {
                print("[SessionWS] Receive failed: \(error.localizedDescription)")
            }
            self.handleDisconnectOnQueue(for: task)
        }
    }

    /// Must be called on `stateQueue`.
    private func handleDisconnectOnQueue(for task: URLSessionWebSocketTask) {
        // Only process disconnect if this is still the current task.
        // A stale task from a previous connection must not tear down the
        // active connection.
        guard self.webSocketTask === task else {
            if !self.intentionalDisconnect {
                print("[SessionWS] Ignoring stale disconnect for superseded task")
            }
            return
        }

        self.isConnected = false
        self.webSocketTask = nil
        self.pingTimeoutTimer?.cancel()
        self.pingTimeoutTimer = nil

        guard !self.intentionalDisconnect else { return }

        guard self.reconnectAttempt < self.maxReconnectAttempts else {
            print("[SessionWS] Max reconnect attempts (\(self.maxReconnectAttempts)) reached, giving up")
            return
        }

        let delay = self.reconnectDelay()
        self.reconnectAttempt += 1

        // Cancel any previously scheduled reconnect to prevent duplicate
        // connections piling up (e.g. rapid disconnect/reconnect during background).
        self.reconnectWorkItem?.cancel()

        let workItem = DispatchWorkItem { [weak self] in
            self?.openConnection()
        }
        self.reconnectWorkItem = workItem
        DispatchQueue.main.asyncAfter(deadline: .now() + delay, execute: workItem)
    }

    func reconnectDelay(attempt: Int? = nil) -> TimeInterval {
        let effectiveAttempt = attempt ?? reconnectAttempt
        let base: TimeInterval = 1
        let exponential = base * pow(2, Double(effectiveAttempt))
        return min(exponential, maxBackoff)
    }

    // MARK: - Widget Navigation

    /// Called by LiveActivityPlugin when the widget's Next/Previous intent fires.
    /// Sends the setCurrentClimb mutation over the native WebSocket.
    func navigateToItem(_ item: SharedQueueItem, at index: Int, totalItems items: [SharedQueueItem], correlationId: String) {
        stateQueue.async { [weak self] in
            guard let self = self else { return }

            // Sync internal state with SharedQueueState.
            self.queueItems = items
            let previousIndex = self.currentIndex
            self.currentIndex = index

            self.pendingMutations[correlationId] = previousIndex

            self.persistAndNotify(repaintBoard: true)
            self.sendSetCurrentClimb(item: item, correlationId: correlationId)
        }
    }

    // MARK: - Mutation Response Handling

    private func handleMutationError(_ msg: GQLMessage) {
        switch QueueGraphQLErrorRouting.action(forOperationId: msg.id, subscriptionId: subscriptionId) {
        case .reconnect:
            // joinSession failed (no session → mutations rejected) or the
            // queueUpdates subscription itself errored. For the latter, server
            // pings keep the ping-timeout watchdog quiet, so without this the
            // connection would look healthy while delivering zero queue
            // updates for the rest of the session. Reconnect to re-establish —
            // bounded, because reconnectAttempt only resets once queue data
            // actually flows.
            print("[SessionWS] operation \(msg.id ?? "?") errored: \(msg.payload ?? [:]) — reconnecting")
            stateQueue.async { [weak self] in
                self?.webSocketTask?.cancel(with: .goingAway, reason: nil)
            }

        case .revertOptimisticNavigation(let correlationId):
            // Server rejected the navigation — revert to the index before the optimistic update
            stateQueue.async { [weak self] in
                guard let self = self else { return }
                if let previousIndex = self.pendingMutations.removeValue(forKey: correlationId) {
                    self.currentIndex = previousIndex
                    self.persistAndNotify(repaintBoard: true)
                }
            }

        case .ignore:
            break
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
