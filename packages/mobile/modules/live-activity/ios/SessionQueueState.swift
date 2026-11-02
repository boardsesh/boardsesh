import Foundation

// Pure queue-update logic for the native session WebSocket: event types,
// payload parsing, sequence acceptance, and the state reducer. Split out of
// SessionWebSocketManager so the state transitions compile into the
// BoardseshTests target (the manager itself drags in URLSession/BLE and
// can't) — keep everything here side-effect free.

// MARK: - Queue Update Events

enum QueueUpdateEvent {
    /// `historyCount` is `QueueState.historyCount` (F3, #6666): the number of
    /// `items` before Up next. The server sends it on every FullSync; it only
    /// matters when `currentItem` is nil, and is nil from a pre-F3 server. It
    /// trails with a default so a three-argument `.fullSync(items:currentItem:sequence:)`
    /// (the tests `main` adds) still compiles after the train merges `main` in.
    case fullSync(items: [SharedQueueItem], currentItem: SharedQueueItem?, sequence: Int, historyCount: Int? = nil)
    case currentClimbChanged(item: SharedQueueItem?, sequence: Int)
    case itemAdded(item: SharedQueueItem, position: Int, sequence: Int)
    case itemRemoved(uuid: String, sequence: Int)
    case reordered(uuid: String, oldIndex: Int, newIndex: Int, sequence: Int)
    case climbMirrored(uuid: String?, mirrored: Bool, sequence: Int)

    var sequence: Int {
        switch self {
        case .fullSync(_, _, let sequence, _),
             .currentClimbChanged(_, let sequence),
             .itemAdded(_, _, let sequence),
             .itemRemoved(_, let sequence),
             .reordered(_, _, _, let sequence),
             .climbMirrored(_, _, let sequence):
            return sequence
        }
    }
}

enum QueueEventRepaintPolicy {
    static func shouldRepaintBoard(for event: QueueUpdateEvent) -> Bool {
        switch event {
        case .currentClimbChanged(_, _), .climbMirrored(_, _, _):
            return true
        case .fullSync(_, _, _, _), .itemAdded(_, _, _), .itemRemoved(_, _), .reordered(_, _, _, _):
            return false
        }
    }
}

// MARK: - Sequence Acceptance

/// Decides what to do with an incoming event's sequence number. FullSync is an
/// authoritative snapshot the server sends on every (re)subscribe, so it is
/// accepted unconditionally — gap-checking it against a sequence recorded on a
/// previous connection made every reconnect after ≥2 missed events cancel the
/// socket, refetch the same FullSync, and cancel again, forever.
enum QueueSequencePolicy {
    enum Decision: Equatable {
        /// Apply the event and advance lastSequence to the given value.
        case apply(newLastSequence: Int)
        /// A mid-stream gap — drop the event and resync (reconnect fetches a
        /// fresh FullSync).
        case resync
    }

    static func decision(for event: QueueUpdateEvent, lastKnown: Int) -> Decision {
        if case .fullSync = event {
            return .apply(newLastSequence: event.sequence)
        }
        if QueueMessageParser.hasSequenceGap(lastKnown: lastKnown, received: event.sequence) {
            return .resync
        }
        return .apply(newLastSequence: event.sequence)
    }
}

// MARK: - graphql-ws Error Routing

/// Routes a graphql-ws `error` message by its operation id. Pure so the
/// routing is testable: a subscription-level error used to fall through the
/// mutation-only handling and was silently dropped — server pings kept the
/// connection looking healthy while it delivered zero queue updates.
enum QueueGraphQLErrorRouting {
    enum Action: Equatable {
        /// join-session or the queueUpdates subscription failed — reconnect so
        /// the session/subscription is re-established.
        case reconnect
        /// The queueUpdates subscription was rejected because the server's
        /// schema has no `QueueState.historyCount` (a backend from before F3,
        /// #6666, or one rolled back past it). Resubscribe on the same socket
        /// without that field instead of reconnecting: every reconnect would
        /// send the same document, burn the attempt cap and leave the lock
        /// screen frozen until the app restarts.
        case resubscribeWithoutHistoryCount
        /// An optimistic widget navigation was rejected — revert to the index
        /// recorded before it.
        case revertOptimisticNavigation(correlationId: String)
        case ignore
    }

    static func action(forOperationId id: String?, subscriptionId: String, errorMessages: [String] = []) -> Action {
        guard let id else { return .ignore }
        if id == subscriptionId, QueueSubscriptionDocument.rejectsHistoryCount(errorMessages: errorMessages) {
            return .resubscribeWithoutHistoryCount
        }
        if id == "join-session" || id == subscriptionId {
            return .reconnect
        }
        if id.hasPrefix("mutation-") {
            return .revertOptimisticNavigation(correlationId: String(id.dropFirst("mutation-".count)))
        }
        return .ignore
    }

    /// The `message` of each GraphQL error in a graphql-ws `error` payload,
    /// which is an array of errors rather than an object.
    static func errorMessages(inPayload payload: Any?) -> [String] {
        guard let errors = payload as? [[String: Any]] else { return [] }
        return errors.compactMap { $0["message"] as? String }
    }
}

// MARK: - Subscription Document

/// The native queueUpdates document selects `QueueState.historyCount` (F3,
/// #6666). A backend without the field rejects the whole document with a
/// validation error, so the socket falls back to the same document minus that
/// one line, which reads as a pre-F3 server: index 0 when nothing is current.
enum QueueSubscriptionDocument {
    static let historyCountField = "historyCount"

    /// The document without its `historyCount` selection line.
    static func withoutHistoryCount(_ document: String) -> String {
        document
            .components(separatedBy: "\n")
            .filter { $0.trimmingCharacters(in: .whitespaces) != historyCountField }
            .joined(separator: "\n")
    }

    /// True when a validation error names the field, e.g. graphql-js's
    /// `Cannot query field "historyCount" on type "QueueState".`
    static func rejectsHistoryCount(errorMessages: [String]) -> Bool {
        errorMessages.contains { $0.contains("\"\(historyCountField)\"") }
    }
}

// MARK: - State Reducer

/// Applies queue events to (items, currentIndex), keeping the *current item*
/// stable by uuid the way the JS reducer does — a raw index survives inserts,
/// removals, and reorders ahead of it only if it moves with the item.
enum QueueStateReducer {
    struct QueueState: Equatable {
        var items: [SharedQueueItem]
        var currentIndex: Int
    }

    static func apply(_ event: QueueUpdateEvent, to state: QueueState) -> QueueState {
        var items = state.items
        let currentUuid = currentItemUuid(in: state)

        switch event {
        case .fullSync(let syncedItems, let currentItem, _, let historyCount):
            // With nothing current, land on the History / Up next line (the
            // climb Next would pick) instead of index 0, which is History's
            // oldest climb — the lock screen used to show it after a crewmate
            // removed the current climb.
            return stateSettingCurrent(
                item: currentItem,
                items: syncedItems,
                fallbackIndex: lineIndex(historyCount: historyCount, itemCount: syncedItems.count)
            )

        case .currentClimbChanged(let item, _):
            guard let item else { return state }
            // Mirrors the JS reducer's shouldAddToQueue: a current climb that
            // isn't a queue member (picked from search) is appended so the
            // wall, Live Activity, and widget nav all see it — instead of the
            // stale index repainting the previous climb over the peer's choice.
            return stateSettingCurrent(item: item, items: items, fallbackIndex: state.currentIndex)

        case .itemAdded(let item, let position, _):
            let insertIndex = min(max(position, 0), items.count)
            items.insert(item, at: insertIndex)
            return QueueState(items: items, currentIndex: resolveCurrentIndex(previousUuid: currentUuid, previousIndex: state.currentIndex, items: items))

        case .itemRemoved(let uuid, _):
            guard let removeIndex = items.firstIndex(where: { $0.uuid == uuid }) else { return state }
            items.remove(at: removeIndex)
            // When the current item itself was removed the uuid lookup misses
            // and the clamped old index lands on its successor.
            return QueueState(items: items, currentIndex: resolveCurrentIndex(previousUuid: currentUuid, previousIndex: state.currentIndex, items: items))

        case .reordered(let uuid, let oldIndex, let newIndex, _):
            let sourceIndex: Int
            if oldIndex >= 0, oldIndex < items.count, items[oldIndex].uuid == uuid {
                sourceIndex = oldIndex
            } else if let found = items.firstIndex(where: { $0.uuid == uuid }) {
                sourceIndex = found
            } else {
                return state
            }
            let item = items.remove(at: sourceIndex)
            let dest = min(max(newIndex, 0), items.count)
            items.insert(item, at: dest)
            return QueueState(items: items, currentIndex: resolveCurrentIndex(previousUuid: currentUuid, previousIndex: state.currentIndex, items: items))

        case .climbMirrored(let uuid, let mirrored, _):
            guard let uuid, let itemIndex = items.firstIndex(where: { $0.uuid == uuid }) else { return state }
            let item = items[itemIndex]
            items[itemIndex] = SharedQueueItem(
                uuid: item.uuid,
                climbUuid: item.climbUuid,
                climbName: item.climbName,
                difficulty: item.difficulty,
                angle: item.angle,
                frames: item.frames,
                setterUsername: item.setterUsername,
                mirrored: mirrored
            )
            return QueueState(items: items, currentIndex: state.currentIndex)
        }
    }

    private static func currentItemUuid(in state: QueueState) -> String? {
        guard state.currentIndex >= 0, state.currentIndex < state.items.count else { return nil }
        return state.items[state.currentIndex].uuid
    }

    /// The index to show when nothing is current: `queue[historyCount]`, the
    /// head of Up next. With Up next empty (`historyCount >= items.count`) it
    /// is `items.count`, one past History's newest climb, deliberately out of
    /// bounds: `buildContentState` and `SharedQueueState.currentItem` read it
    /// as no climb, so the lock screen is not handed an already-climbed climb
    /// as current (JS sends no climb in that state too), and the widget's
    /// Previous lands on `count - 1`, the climb the server's Previous picks
    /// (`queue[historyCount - 1]`). A pre-F3 server sends no `historyCount`,
    /// which keeps today's index 0.
    static func lineIndex(historyCount: Int?, itemCount: Int) -> Int {
        guard let historyCount else { return 0 }
        return min(max(historyCount, 0), max(itemCount, 0))
    }

    /// The current item follows its uuid; if it vanished, clamp the old index
    /// into bounds.
    private static func resolveCurrentIndex(previousUuid: String?, previousIndex: Int, items: [SharedQueueItem]) -> Int {
        if let previousUuid, let index = items.firstIndex(where: { $0.uuid == previousUuid }) {
            return index
        }
        return min(max(previousIndex, 0), max(items.count - 1, 0))
    }

    private static func stateSettingCurrent(item: SharedQueueItem?, items: [SharedQueueItem], fallbackIndex: Int) -> QueueState {
        guard let item else {
            return QueueState(items: items, currentIndex: fallbackIndex)
        }
        if let index = items.firstIndex(where: { $0.uuid == item.uuid }) {
            return QueueState(items: items, currentIndex: index)
        }
        var appended = items
        appended.append(item)
        return QueueState(items: appended, currentIndex: appended.count - 1)
    }
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
        let mirrored = climb["mirrored"] as? Bool ?? false

        return SharedQueueItem(
            uuid: uuid,
            climbUuid: climbUuid,
            climbName: name,
            difficulty: difficulty,
            angle: angle,
            frames: frames,
            setterUsername: setter,
            mirrored: mirrored
        )
    }

    /// Parse a FullSync event from the queueUpdates dictionary.
    static func parseFullSync(_ updates: [String: Any]) -> QueueUpdateEvent? {
        guard let state = updates["state"] as? [String: Any] else { return nil }
        let sequence = Self.parseIntValue(updates["sequence"]) ?? 0

        let queueArray = state["queue"] as? [[String: Any]] ?? []
        let items = queueArray.compactMap { parseQueueItem($0) }

        let currentItem = parseQueueItem(state["currentClimbQueueItem"] as? [String: Any])
        // JSON null and an absent field (a pre-F3 server) both parse to nil.
        let historyCount = Self.parseIntValue(state["historyCount"])

        return .fullSync(items: items, currentItem: currentItem, sequence: sequence, historyCount: historyCount)
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
        let uuid = updates["mirroredUuid"] as? String ?? updates["uuid"] as? String
        let mirrored = updates["mirrored"] as? Bool ?? false
        return .climbMirrored(uuid: uuid, mirrored: mirrored, sequence: sequence)
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

    private static func parseDifficulty(_ value: Any?) -> String {
        if let str = value as? String { return str }
        if let num = value as? Double { return String(format: "%.1f", num) }
        if let num = value as? Int { return String(num) }
        return ""
    }

    private static func parseIntValue(_ value: Any?) -> Int? {
        if let i = value as? Int { return i }
        if let d = value as? Double { return Int(d) }
        if let s = value as? String { return Int(s) }
        return nil
    }
}
