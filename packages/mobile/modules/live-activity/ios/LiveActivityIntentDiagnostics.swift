#if !WIDGET_EXTENSION || BOARDSESH_TESTS

import Foundation

/// Fixed, non-identifying intent kinds. Keep this exhaustive with every
/// `LiveActivityIntent` compiled into the main app and widget targets.
enum LiveActivityIntentDiagnosticKind: String, Codable, CaseIterable {
    case nextClimb
    case previousClimb
    case takeControl
    case reconnectBoard
}

/// Coarse progress only. These values deliberately carry no queue, climb,
/// session, endpoint, user, or peripheral details.
enum LiveActivityIntentDiagnosticStage: String, Codable, CaseIterable {
    case entered
    case networkStarted
    case networkFinishedSuccess
    case networkFinishedRetryable
    case networkFinishedTerminal
    case activityKitUpdated
    case bleStarted
    case bleFinishedSuccess
    case bleFinishedFailure
    case darwinPosted
    case completed
}

/// Stages that can cross the interrupted-run bridge. `completed` is
/// intentionally unrepresentable here: normal exits stay in native storage and
/// are never consumed by JS.
enum LiveActivityInterruptedIntentDiagnosticStage: String, Codable, CaseIterable {
    case entered
    case networkStarted
    case networkFinishedSuccess
    case networkFinishedRetryable
    case networkFinishedTerminal
    case activityKitUpdated
    case bleStarted
    case bleFinishedSuccess
    case bleFinishedFailure
    case darwinPosted
}

/// Sanitized normal-exit classes. An interrupted run has no completion class.
enum LiveActivityIntentCompletionClass: String, Codable, CaseIterable {
    case success
    case sharedDefaultsUnavailable
    case navigationOutOfBounds
    case serverRejected
    case retryableNetworkFailure
    case localNavigationEnabled
    case alreadyAllowed
    case bleFailure
}

struct LiveActivityIntentDiagnosticRecord: Codable, Equatable {
    static let currentSchemaVersion = 1

    let schemaVersion: Int
    let runId: String
    let processId: String
    let intentKind: LiveActivityIntentDiagnosticKind
    let appVersion: String
    let buildNumber: String
    let startedAt: Date
    var updatedAt: Date
    var lastStage: LiveActivityIntentDiagnosticStage
    var completionClass: LiveActivityIntentCompletionClass?
    var reactRootMounted: Bool

    var storageKey: String {
        "\(processId):\(runId)"
    }
}

/// Failable boundary between durable stored records and the JS bridge. The DTO
/// has neither a completed stage nor a completion class, so a future change to
/// store filtering cannot accidentally widen the consumed payload.
struct LiveActivityInterruptedIntentDiagnostic: Equatable {
    let schemaVersion: Int
    let runId: String
    let processId: String
    let intentKind: LiveActivityIntentDiagnosticKind
    let appVersion: String
    let buildNumber: String
    let startedAt: Date
    let updatedAt: Date
    let lastStage: LiveActivityInterruptedIntentDiagnosticStage
    let reactRootMounted: Bool

    init?(record: LiveActivityIntentDiagnosticRecord) {
        guard record.completionClass == nil,
              let interruptedStage = LiveActivityInterruptedIntentDiagnosticStage(rawValue: record.lastStage.rawValue)
        else {
            return nil
        }
        schemaVersion = record.schemaVersion
        runId = record.runId
        processId = record.processId
        intentKind = record.intentKind
        appVersion = record.appVersion
        buildNumber = record.buildNumber
        startedAt = record.startedAt
        updatedAt = record.updatedAt
        lastStage = interruptedStage
        reactRootMounted = record.reactRootMounted
    }

    var bridgePayload: [String: Any] {
        [
            "schemaVersion": schemaVersion,
            "runId": runId,
            "processId": processId,
            "intentKind": intentKind.rawValue,
            "appVersion": appVersion,
            "buildNumber": buildNumber,
            "startedAtMs": Int64(startedAt.timeIntervalSince1970 * 1_000),
            "updatedAtMs": Int64(updatedAt.timeIntervalSince1970 * 1_000),
            "lastStage": lastStage.rawValue,
            "reactRootMounted": reactRootMounted,
        ]
    }
}

private struct ConsumedIntentDiagnostic: Codable {
    let storageKey: String
    let consumedAt: Date
}

private struct IntentDiagnosticEnvelope: Codable {
    static let currentSchemaVersion = 1

    let schemaVersion: Int
    var records: [LiveActivityIntentDiagnosticRecord]
    var consumed: [ConsumedIntentDiagnostic]

    static var empty: IntentDiagnosticEnvelope {
        IntentDiagnosticEnvelope(
            schemaVersion: currentSchemaVersion,
            records: [],
            consumed: []
        )
    }
}

/// App-local, bounded storage for Live Activity intent markers.
///
/// The main app is the only production target that compiles this file. The
/// `BOARDSESH_TESTS` exception above lets the generated XCTest target exercise
/// the exact production store while still compiling shared intent sources with
/// `WIDGET_EXTENSION`. The real widget target never defines that test flag.
///
/// One encoded envelope is replaced under a process lock on each transition.
/// `UserDefaults.set(Data, forKey:)` is a best-effort atomic replacement at the
/// app-local persistence boundary; failures must never affect intent behavior.
final class LiveActivityIntentDiagnosticStore {
    static let defaultStorageKey = "bs_live_activity_intent_diagnostics_v1"
    static let defaultMaxRecords = 16
    static let defaultTimeToLive: TimeInterval = 24 * 60 * 60
    static let defaultIncompleteGrace: TimeInterval = 30

    private let defaults: UserDefaults
    private let storageKey: String
    private let processId: String
    private let appVersion: String
    private let buildNumber: String
    private let maxRecords: Int
    private let timeToLive: TimeInterval
    private let incompleteGrace: TimeInterval
    private let now: () -> Date
    private let lock = NSLock()

    init(
        defaults: UserDefaults = .standard,
        storageKey: String = defaultStorageKey,
        processId: UUID = UUID(),
        appVersion: String,
        buildNumber: String,
        maxRecords: Int = defaultMaxRecords,
        timeToLive: TimeInterval = defaultTimeToLive,
        incompleteGrace: TimeInterval = defaultIncompleteGrace,
        now: @escaping () -> Date = Date.init
    ) {
        self.defaults = defaults
        self.storageKey = storageKey
        self.processId = processId.uuidString.lowercased()
        self.appVersion = Self.sanitizeBuildComponent(appVersion)
        self.buildNumber = Self.sanitizeBuildComponent(buildNumber)
        self.maxRecords = max(1, maxRecords)
        self.timeToLive = max(1, timeToLive)
        self.incompleteGrace = max(0, incompleteGrace)
        self.now = now
    }

    func begin(kind: LiveActivityIntentDiagnosticKind) -> LiveActivityIntentDiagnosticRun {
        let timestamp = now()
        let record = LiveActivityIntentDiagnosticRecord(
            schemaVersion: LiveActivityIntentDiagnosticRecord.currentSchemaVersion,
            runId: UUID().uuidString.lowercased(),
            processId: processId,
            intentKind: kind,
            appVersion: appVersion,
            buildNumber: buildNumber,
            startedAt: timestamp,
            updatedAt: timestamp,
            lastStage: .entered,
            completionClass: nil,
            reactRootMounted: false
        )

        mutateEnvelope { envelope in
            envelope.records.removeAll { $0.storageKey == record.storageKey }
            envelope.records.append(record)
            self.pruneAndBound(&envelope, at: timestamp)
        }

        return LiveActivityIntentDiagnosticRun(
            store: self,
            runId: record.runId,
            processId: record.processId
        )
    }

    fileprivate func mark(
        runId: String,
        processId: String,
        stage: LiveActivityIntentDiagnosticStage
    ) {
        let timestamp = now()
        mutateEnvelope { envelope in
            guard let index = envelope.records.firstIndex(where: {
                $0.runId == runId && $0.processId == processId
            }) else { return }
            guard envelope.records[index].lastStage != .completed else { return }
            envelope.records[index].lastStage = stage
            envelope.records[index].updatedAt = timestamp
            self.pruneAndBound(&envelope, at: timestamp)
        }
    }

    fileprivate func complete(
        runId: String,
        processId: String,
        completionClass: LiveActivityIntentCompletionClass
    ) {
        let timestamp = now()
        mutateEnvelope { envelope in
            guard let index = envelope.records.firstIndex(where: {
                $0.runId == runId && $0.processId == processId
            }) else { return }
            guard envelope.records[index].lastStage != .completed else { return }
            envelope.records[index].lastStage = .completed
            envelope.records[index].completionClass = completionClass
            envelope.records[index].updatedAt = timestamp
            self.pruneAndBound(&envelope, at: timestamp)
        }
    }

    /// Marks only currently-running records from this process. This is called
    /// from a React effect after the root has committed, never at module import.
    func markReactRootMounted() {
        let timestamp = now()
        mutateEnvelope { envelope in
            for index in envelope.records.indices {
                guard envelope.records[index].processId == self.processId,
                      envelope.records[index].lastStage != .completed
                else { continue }
                envelope.records[index].reactRootMounted = true
                envelope.records[index].updatedAt = timestamp
            }
            self.pruneAndBound(&envelope, at: timestamp)
        }
    }

    /// Atomically returns and removes eligible interrupted runs. Records from
    /// this process or within the grace window stay pending. Invalid schema,
    /// corrupt shape, wrong-build, future-dated, and TTL-expired records are
    /// discarded rather than reported.
    func consumeInterruptedRuns() -> [LiveActivityIntentDiagnosticRecord] {
        let timestamp = now()
        var interrupted: [LiveActivityIntentDiagnosticRecord] = []

        mutateEnvelope { envelope in
            var consumedKeys = Set(
                envelope.consumed
                    .filter { self.isWithinTimeToLive($0.consumedAt, at: timestamp) }
                    .map(\.storageKey)
            )
            var retained: [LiveActivityIntentDiagnosticRecord] = []

            for record in envelope.records {
                guard self.isValid(record, at: timestamp) else { continue }
                guard record.lastStage != .completed else {
                    retained.append(record)
                    continue
                }
                guard record.processId != self.processId else {
                    retained.append(record)
                    continue
                }
                guard timestamp.timeIntervalSince(record.updatedAt) >= self.incompleteGrace else {
                    retained.append(record)
                    continue
                }
                guard !consumedKeys.contains(record.storageKey) else { continue }

                consumedKeys.insert(record.storageKey)
                interrupted.append(record)
                envelope.consumed.append(
                    ConsumedIntentDiagnostic(storageKey: record.storageKey, consumedAt: timestamp)
                )
            }

            envelope.records = retained
            self.pruneAndBound(&envelope, at: timestamp)
        }

        return interrupted
    }

    #if BOARDSESH_TESTS
    func recordsSnapshot() -> [LiveActivityIntentDiagnosticRecord] {
        lock.lock()
        defer { lock.unlock() }
        return readEnvelope().records
    }
    #endif

    private func mutateEnvelope(_ mutation: (inout IntentDiagnosticEnvelope) -> Void) {
        lock.lock()
        defer { lock.unlock() }
        var envelope = readEnvelope()
        mutation(&envelope)
        writeEnvelope(envelope)
    }

    private func readEnvelope() -> IntentDiagnosticEnvelope {
        guard let encoded = defaults.data(forKey: storageKey),
              let envelope = try? JSONDecoder().decode(IntentDiagnosticEnvelope.self, from: encoded),
              envelope.schemaVersion == IntentDiagnosticEnvelope.currentSchemaVersion
        else {
            return .empty
        }
        return envelope
    }

    private func writeEnvelope(_ envelope: IntentDiagnosticEnvelope) {
        guard let encoded = try? JSONEncoder().encode(envelope) else { return }
        defaults.set(encoded, forKey: storageKey)
    }

    private func pruneAndBound(_ envelope: inout IntentDiagnosticEnvelope, at timestamp: Date) {
        envelope.records = envelope.records
            .filter { self.isValid($0, at: timestamp) }
            .suffix(maxRecords)
            .map { $0 }
        envelope.consumed = envelope.consumed
            .filter { self.isWithinTimeToLive($0.consumedAt, at: timestamp) }
            .suffix(maxRecords * 2)
            .map { $0 }
    }

    private func isValid(_ record: LiveActivityIntentDiagnosticRecord, at timestamp: Date) -> Bool {
        guard record.schemaVersion == LiveActivityIntentDiagnosticRecord.currentSchemaVersion,
              UUID(uuidString: record.runId) != nil,
              UUID(uuidString: record.processId) != nil,
              record.appVersion == appVersion,
              record.buildNumber == buildNumber,
              record.startedAt <= record.updatedAt,
              record.lastStage == .completed ? record.completionClass != nil : record.completionClass == nil,
              isWithinTimeToLive(record.startedAt, at: timestamp),
              timestamp.timeIntervalSince(record.updatedAt) >= -300
        else {
            return false
        }
        return true
    }

    private func isWithinTimeToLive(_ date: Date, at timestamp: Date) -> Bool {
        let age = timestamp.timeIntervalSince(date)
        return age >= -300 && age <= timeToLive
    }

    /// Build metadata is diagnostic context, but still bounded and restricted
    /// to a small safe alphabet before persistence or Sentry emission.
    static func sanitizeBuildComponent(_ component: String) -> String {
        let allowed = CharacterSet(charactersIn: "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._-")
        let scalars = component.unicodeScalars.filter { allowed.contains($0) }
        let sanitized = String(String.UnicodeScalarView(scalars)).prefix(64)
        return sanitized.isEmpty ? "unknown" : String(sanitized)
    }
}

/// Per-run scoped handle. `complete` is idempotent and prevents later stages
/// from reopening a normal exit. Callers use `defer` so every normal early
/// return is marked completed while process termination leaves it incomplete.
final class LiveActivityIntentDiagnosticRun {
    private let store: LiveActivityIntentDiagnosticStore
    private let runId: String
    private let processId: String
    private let lock = NSLock()
    private var isCompleted = false

    fileprivate init(
        store: LiveActivityIntentDiagnosticStore,
        runId: String,
        processId: String
    ) {
        self.store = store
        self.runId = runId
        self.processId = processId
    }

    func mark(_ stage: LiveActivityIntentDiagnosticStage) {
        lock.lock()
        defer { lock.unlock() }
        guard !isCompleted, stage != .completed else { return }
        store.mark(runId: runId, processId: processId, stage: stage)
    }

    func complete(_ completionClass: LiveActivityIntentCompletionClass) {
        lock.lock()
        defer { lock.unlock() }
        guard !isCompleted else { return }
        isCompleted = true
        store.complete(
            runId: runId,
            processId: processId,
            completionClass: completionClass
        )
    }
}

enum LiveActivityIntentDiagnostics {
    private static let store = LiveActivityIntentDiagnosticStore(
        processId: UUID(),
        appVersion: Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "unknown",
        buildNumber: Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "unknown"
    )

    static func begin(kind: LiveActivityIntentDiagnosticKind) -> LiveActivityIntentDiagnosticRun {
        store.begin(kind: kind)
    }

    static func markReactRootMounted() {
        store.markReactRootMounted()
    }

    static func consumeInterruptedRuns() -> [[String: Any]] {
        store.consumeInterruptedRuns()
            .compactMap { LiveActivityInterruptedIntentDiagnostic(record: $0) }
            .map(\.bridgePayload)
    }
}

#endif
