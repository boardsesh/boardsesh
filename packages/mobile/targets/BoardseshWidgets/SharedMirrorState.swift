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

/// A durable receipt, retained until JS has applied this sequence (or a newer full sync).
enum SharedMirrorState {
    private static let lock = NSLock()

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

    static func isCurrent(_ receipt: SharedMirrorConfirmation, in defaults: UserDefaults) -> Bool {
        let (items, index) = SharedQueueState.load(from: defaults)
        return sequence(in: defaults) == receipt.sequence
            && canMirror(sessionId: receipt.sessionId, queueItemUuid: receipt.queueItemUuid, in: defaults)
            && items.indices.contains(index) && items[index].mirrored == receipt.mirrored
    }

    /// Commit an HTTP result atomically against native WebSocket updates.
    static func apply(_ receipt: SharedMirrorConfirmation, in defaults: UserDefaults) -> (items: [SharedQueueItem], index: Int)? {
        lock.lock()
        defer { lock.unlock() }
        guard receipt.sessionId == defaults.string(forKey: SharedConstants.sessionIdKey),
              receipt.sequence >= sequence(in: defaults),
              let bytes = try? JSONEncoder().encode(receipt) else { return nil }
        defaults.set(bytes, forKey: SharedConstants.pendingMirrorKey)
        guard canMirror(sessionId: receipt.sessionId, queueItemUuid: receipt.queueItemUuid, in: defaults) else { return nil }
        let (items, index) = SharedQueueState.load(from: defaults)
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

    static func canMirror(sessionId: String, queueItemUuid: String, in defaults: UserDefaults) -> Bool {
        let (items, index) = SharedQueueState.load(from: defaults)
        return defaults.string(forKey: SharedConstants.sessionIdKey) == sessionId
            && defaults.bool(forKey: SharedConstants.supportsMirroringKey)
            && defaults.string(forKey: SharedConstants.boardConnectionKey) == "connectedByMe"
            && SharedWidgetWallControlState.load(from: defaults).navigationAllowed
            && items.indices.contains(index) && items[index].uuid == queueItemUuid
    }
}
