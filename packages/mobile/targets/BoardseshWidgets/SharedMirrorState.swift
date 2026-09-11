import Foundation

struct SharedMirrorConfirmation: Codable, Equatable, Sendable {
    let sessionId: String
    let queueItemUuid: String
    let mirrored: Bool
    let sequence: Int
    let stateHash: String
    let stateHashOrdered: String?

    var eventBody: [String: Any] {
        var body: [String: Any] = [
            "kind": "confirmed", "sessionId": sessionId, "queueItemUuid": queueItemUuid,
            "mirrored": mirrored, "sequence": sequence, "stateHash": stateHash
        ]
        if let stateHashOrdered { body["stateHashOrdered"] = stateHashOrdered }
        return body
    }
}

/// A tap whose server request never got an authoritative answer, kept so the
/// main app can replay it. Carries no sequence: nothing was committed yet.
struct SharedMirrorRequest: Codable, Equatable, Sendable {
    let sessionId: String
    let queueItemUuid: String
    let mirrored: Bool

    var eventBody: [String: Any] {
        ["kind": "request", "sessionId": sessionId, "queueItemUuid": queueItemUuid, "mirrored": mirrored]
    }
}

/// A durable receipt, retained until JS has applied this sequence (or a newer full sync).
enum SharedMirrorState {
    private static let lock = NSLock()

    // MARK: - Unconfirmed requests

    static func saveRequest(_ request: SharedMirrorRequest, in defaults: UserDefaults) {
        guard let bytes = try? JSONEncoder().encode(request) else { return }
        defaults.set(bytes, forKey: SharedConstants.pendingMirrorRequestKey)
    }

    static func pendingRequest(in defaults: UserDefaults) -> SharedMirrorRequest? {
        guard let bytes = defaults.data(forKey: SharedConstants.pendingMirrorRequestKey),
              let request = try? JSONDecoder().decode(SharedMirrorRequest.self, from: bytes),
              request.sessionId == defaults.string(forKey: SharedConstants.sessionIdKey) else { return nil }
        return request
    }

    static func clearRequest(in defaults: UserDefaults) {
        defaults.removeObject(forKey: SharedConstants.pendingMirrorRequestKey)
    }

    static func pending(in defaults: UserDefaults) -> SharedMirrorConfirmation? {
        guard let bytes = defaults.data(forKey: SharedConstants.pendingMirrorKey),
              let receipt = try? JSONDecoder().decode(SharedMirrorConfirmation.self, from: bytes),
              receipt.sessionId == defaults.string(forKey: SharedConstants.sessionIdKey) else { return nil }
        return receipt
    }

    static func acknowledge(sessionId: String, sequence: Int, in defaults: UserDefaults) {
        lock.lock()
        defer { lock.unlock() }
        guard let receipt = pending(in: defaults), receipt.sessionId == sessionId,
              receipt.sequence <= sequence else { return }
        defaults.removeObject(forKey: SharedConstants.pendingMirrorKey)
    }

    static func sequence(in defaults: UserDefaults) -> Int {
        defaults.object(forKey: SharedConstants.queueSequenceKey) as? Int ?? -1
    }

    /// Publish a complete queue snapshot only if it is at least as new as the native receipt.
    @discardableResult
    static func persist(items: [SharedQueueItem], currentIndex: Int, sequence: Int, subscriptionSequence: Int? = nil, in defaults: UserDefaults) -> Bool {
        lock.lock()
        defer { lock.unlock() }
        if sequence < Self.sequence(in: defaults) {
            // A subscription requested after the last accepted update is authoritative,
            // including when the server recovered with a reset sequence counter.
            guard subscriptionSequence == Self.sequence(in: defaults) else { return false }
            defaults.removeObject(forKey: SharedConstants.pendingMirrorKey)
        }
        SharedQueueState.save(items: items, currentIndex: currentIndex, to: defaults)
        defaults.set(sequence, forKey: SharedConstants.queueSequenceKey)
        return true
    }

    /// Whether writing this receipt to the wall is still the right thing to do.
    ///
    /// Deliberately NOT keyed on sequence equality. The board write happens after
    /// an `await` on BLE readiness, so any unrelated queue event arriving in that
    /// window used to bump `queueSequenceKey` and silently cancel the write — the
    /// server kept the flip and the wall never moved. What actually matters is
    /// that the current slot is still this queue item, still carries the
    /// orientation the server confirmed, and that this device still drives the
    /// board.
    static func isCurrent(_ receipt: SharedMirrorConfirmation, in defaults: UserDefaults) -> Bool {
        let (items, index) = SharedQueueState.load(from: defaults)
        return defaults.string(forKey: SharedConstants.sessionIdKey) == receipt.sessionId
            && holdsBoard(in: defaults)
            && items.indices.contains(index)
            && items[index].uuid == receipt.queueItemUuid
            && items[index].mirrored == receipt.mirrored
    }

    /// Commit an HTTP result atomically against native WebSocket updates, and
    /// hand back the snapshot the caller should publish.
    ///
    /// The server is authoritative: it already refused a stale slot with
    /// `MirrorTargetChangedError`, so holding a receipt means the write was
    /// correct when it committed. The slot is therefore found by uuid rather
    /// than required to sit at the current index — a widget Next landing while
    /// the request was in flight used to make this return nil, which dropped
    /// the widget refresh and the board write on the floor.
    ///
    /// Returns nil only when there is nothing to publish: a different session,
    /// or no queue at all. A receipt older than the committed snapshot leaves
    /// that snapshot alone and returns it unchanged, so the caller still
    /// republishes current truth instead of going silent.
    static func apply(_ receipt: SharedMirrorConfirmation, in defaults: UserDefaults) -> (items: [SharedQueueItem], index: Int)? {
        lock.lock()
        defer { lock.unlock() }
        guard receipt.sessionId == defaults.string(forKey: SharedConstants.sessionIdKey) else { return nil }
        let (items, index) = SharedQueueState.load(from: defaults)
        let publishable: (items: [SharedQueueItem], index: Int)? = items.isEmpty ? nil : (items: items, index: index)
        // A receipt older than the committed snapshot is not stored: it would
        // displace a newer one JS has yet to apply.
        guard receipt.sequence >= sequence(in: defaults) else { return publishable }
        if let bytes = try? JSONEncoder().encode(receipt) {
            defaults.set(bytes, forKey: SharedConstants.pendingMirrorKey)
        }
        guard items.contains(where: { $0.uuid == receipt.queueItemUuid }) else { return publishable }
        let updatedItems = items.map { item in
            item.uuid == receipt.queueItemUuid ? SharedQueueItem(
                uuid: item.uuid, climbUuid: item.climbUuid, climbName: item.climbName,
                difficulty: item.difficulty, angle: item.angle, frames: item.frames,
                setterUsername: item.setterUsername, mirrored: receipt.mirrored
            ) : item
        }
        SharedQueueState.save(items: updatedItems, currentIndex: index, to: defaults)
        defaults.set(receipt.sequence, forKey: SharedConstants.queueSequenceKey)
        return (updatedItems, index)
    }

    /// Whether this device is the one driving the wall.
    static func holdsBoard(in defaults: UserDefaults) -> Bool {
        defaults.string(forKey: SharedConstants.boardConnectionKey) == "connectedByMe"
    }

    /// The pre-request gate.
    ///
    /// No `navigationAllowed` check: the button is only rendered for
    /// `connectedByMe`, and gating the intent on a separately persisted flag is
    /// exactly what made Prev/Next no-op when the flag drifted from the shown
    /// state (see the note in `ClimbNavigationIntent.perform`). The queue only
    /// has to contain the tapped item — whether it is still the current slot is
    /// the server's call, and it answers with 409.
    static func canMirror(sessionId: String, queueItemUuid: String, in defaults: UserDefaults) -> Bool {
        let (items, _) = SharedQueueState.load(from: defaults)
        return defaults.string(forKey: SharedConstants.sessionIdKey) == sessionId
            && defaults.bool(forKey: SharedConstants.supportsMirroringKey)
            && holdsBoard(in: defaults)
            && items.contains { $0.uuid == queueItemUuid }
    }
}
