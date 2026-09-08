import ActivityKit
import AppIntents

@available(iOS 17.0, *)
struct MirrorClimbIntent: LiveActivityIntent {
    static let title: LocalizedStringResource = "Mirror climb"
    @Parameter(title: "Session") var sessionId: String
    @Parameter(title: "Queue item") var queueItemUuid: String
    @Parameter(title: "Mirrored") var mirrored: Bool

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
        guard let defaults = SharedConstants.sharedDefaults,
              SharedMirrorState.canMirror(sessionId: sessionId, queueItemUuid: queueItemUuid, in: defaults)
        else { return }
        #if !WIDGET_EXTENSION
        diagnosticRun.mark(.networkStarted)
        #endif
        let response = await WidgetNetworking.sendMirror(sessionId: sessionId, queueItemUuid: queueItemUuid, mirrored: mirrored)
        guard case .success(let receipt) = response else {
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
        if let snapshot = SharedMirrorState.apply(receipt, in: defaults) {
            let updatedItems = snapshot.items
            let index = snapshot.index
            let item = updatedItems[index]
            let state = ClimbSessionAttributes.ContentState(
                climbName: item.climbName, climbDifficulty: VGradeFormatter.formatVGrade(item.difficulty),
                angle: item.angle, currentIndex: index, totalClimbs: updatedItems.count,
                hasNext: index < updatedItems.count - 1, hasPrevious: index > 0, climbUuid: item.climbUuid,
                queueItemUuid: item.uuid, mirrored: item.mirrored, supportsMirroring: true,
                boardConnection: "connectedByMe", holderDisplayName: nil
            )
            for activity in Activity<ClimbSessionAttributes>.activities where activity.attributes.sessionId == sessionId && activity.activityState == .active {
                guard SharedMirrorState.isCurrent(receipt, in: defaults) else { break }
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
        CFNotificationCenterPostNotification(
            CFNotificationCenterGetDarwinNotifyCenter(),
            CFNotificationName(SharedConstants.queueNavigateNotification as CFString), nil, nil, true
        )
        #if !WIDGET_EXTENSION
        diagnosticRun.mark(.darwinPosted)
        #endif
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
