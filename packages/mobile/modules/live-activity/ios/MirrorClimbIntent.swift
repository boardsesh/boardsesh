import ActivityKit
import AppIntents
import os.log

@available(iOS 17.0, *)
struct MirrorClimbIntent: LiveActivityIntent {
    static let title: LocalizedStringResource = "Mirror climb"
    @Parameter(title: "Session") var sessionId: String
    @Parameter(title: "Queue item") var queueItemUuid: String
    @Parameter(title: "Mirrored") var mirrored: Bool

    private static let logger = Logger(subsystem: "com.boardsesh.app", category: "LiveActivityIntent")

    init() { sessionId = ""; queueItemUuid = ""; mirrored = false }
    init(sessionId: String, queueItemUuid: String, mirrored: Bool) {
        self.sessionId = sessionId
        self.queueItemUuid = queueItemUuid
        self.mirrored = mirrored
    }

    func perform() async throws -> some IntentResult {
        guard await MirrorIntentGate.shared.begin() else { return .result() }
        await performMirror()
        await MirrorIntentGate.shared.end()
        return .result()
    }

    private func performMirror() async {
        #if !WIDGET_EXTENSION
        let diagnosticRun = LiveActivityIntentDiagnostics.begin(kind: .mirrorClimb)
        var completionClass = LiveActivityIntentCompletionClass.serverRejected
        defer { diagnosticRun.complete(completionClass) }
        #endif

        // One notice per firing, the same signal ClimbNavigationIntent carries.
        // Production TestFlight builds need it to separate "the intent never ran
        // in the app process" from "it ran and the wall still didn't move".
        Self.logger.notice("MirrorClimbIntent.perform() running bundle=\(Bundle.main.bundleIdentifier ?? "unknown", privacy: .public) process=\(ProcessInfo.processInfo.processName, privacy: .public) mirrored=\(mirrored, privacy: .public)")

        guard let defaults = SharedConstants.sharedDefaults else {
            #if !WIDGET_EXTENSION
            completionClass = .sharedDefaultsUnavailable
            #endif
            return
        }

        // Wake the main app on every exit path, as this intent has always done:
        // even a refused tap usually means the shared snapshot drifted, and the
        // handler resyncs. Registered after the diagnostics `defer` so it runs
        // first and the recorded stage still reflects the post.
        defer {
            postQueueNavigateDarwinNotification()
            #if !WIDGET_EXTENSION
            diagnosticRun.mark(.darwinPosted)
            #endif
        }

        guard SharedMirrorState.canMirror(sessionId: sessionId, queueItemUuid: queueItemUuid, in: defaults) else { return }

        #if !WIDGET_EXTENSION
        diagnosticRun.mark(.networkStarted)
        #endif
        let response = await WidgetNetworking.sendMirror(sessionId: sessionId, queueItemUuid: queueItemUuid, mirrored: mirrored)
        guard case .success(let receipt) = response else {
            if response == .retryableFailure {
                // No authoritative answer came back, so nothing is decided yet.
                // Park the tap for the main app to replay over the WebSocket —
                // the same recovery `pendingActionKey` gives navigation. Without
                // it a flaky lock-screen network loses the tap with no wall
                // change, no widget change and nothing to retry.
                SharedMirrorState.saveRequest(
                    SharedMirrorRequest(sessionId: sessionId, queueItemUuid: queueItemUuid, mirrored: mirrored),
                    in: defaults
                )
            }
            #if !WIDGET_EXTENSION
            diagnosticRun.mark(response == .retryableFailure ? .networkFinishedRetryable : .networkFinishedTerminal)
            completionClass = response == .retryableFailure ? .retryableNetworkFailure : .serverRejected
            #endif
            return
        }
        #if !WIDGET_EXTENSION
        diagnosticRun.mark(.networkFinishedSuccess)
        completionClass = .success
        #endif
        SharedMirrorState.clearRequest(in: defaults)

        // The server has committed the orientation, so the widget and the wall
        // follow it. Both used to sit inside `if let snapshot = apply(...)`, and
        // the activity update was additionally gated on an exact queue-sequence
        // match: either one declining left the climb mirrored on the server
        // while this phone kept showing and lighting the old orientation, with
        // nothing to retry.
        guard let snapshot = SharedMirrorState.apply(receipt, in: defaults),
              snapshot.items.indices.contains(snapshot.index)
        else {
            #if !WIDGET_EXTENSION
            completionClass = .mirrorNotCommitted
            #endif
            return
        }
        let updatedItems = snapshot.items
        let index = snapshot.index
        let item = updatedItems[index]
        let state = ClimbSessionAttributes.ContentState(
            climbName: item.climbName, climbDifficulty: VGradeFormatter.formatVGrade(item.difficulty),
            angle: item.angle, currentIndex: index, totalClimbs: updatedItems.count,
            hasNext: index < updatedItems.count - 1, hasPrevious: index > 0, climbUuid: item.climbUuid,
            queueItemUuid: item.uuid, mirrored: item.mirrored,
            supportsMirroring: defaults.bool(forKey: SharedConstants.supportsMirroringKey),
            // The mirror button is only shown while this device drives the wall,
            // so the optimistic frame keeps the bulb lit and the controls shown.
            boardConnection: "connectedByMe", holderDisplayName: nil
        )
        for activity in Activity<ClimbSessionAttributes>.activities where activity.attributes.sessionId == sessionId && activity.activityState == .active {
            await activity.update(ActivityContent(state: state, staleDate: Date().addingTimeInterval(SharedConstants.liveActivityStaleInterval)))
        }
        #if !WIDGET_EXTENSION
        diagnosticRun.mark(.activityKitUpdated)
        diagnosticRun.mark(.bleStarted)
        let succeeded = await LiveActivityBleBridge.writeBoardForIntent(items: updatedItems, currentIndex: index, mirrorReceipt: receipt)
        diagnosticRun.mark(succeeded ? .bleFinishedSuccess : .bleFinishedFailure)
        if !succeeded { completionClass = .bleFailure }
        #endif
    }

    private func postQueueNavigateDarwinNotification() {
        CFNotificationCenterPostNotification(
            CFNotificationCenterGetDarwinNotifyCenter(),
            CFNotificationName(SharedConstants.queueNavigateNotification as CFString), nil, nil, true
        )
    }
}

private actor MirrorIntentGate {
    static let shared = MirrorIntentGate()
    private var busy = false
    func begin() -> Bool {
        guard !busy else { return false }
        busy = true
        return true
    }
    func end() { busy = false }
}
