import ActivityKit
import AppIntents
import os.log

@available(iOS 17.0, *)
struct TakeControlIntent: LiveActivityIntent {
    static var title: LocalizedStringResource = "Take Control"
    static var description = IntentDescription("Claim wall control for this session")

    private static let logger = Logger(subsystem: "com.boardsesh.app", category: "LiveActivityIntent")

    func perform() async throws -> some IntentResult {
        #if !WIDGET_EXTENSION
        let diagnosticRun = LiveActivityIntentDiagnostics.begin(kind: .takeControl)
        var completionClass = LiveActivityIntentCompletionClass.success
        defer { diagnosticRun.complete(completionClass) }
        #endif

        guard let defaults = SharedConstants.sharedDefaults else {
            #if !WIDGET_EXTENSION
            completionClass = .sharedDefaultsUnavailable
            #endif
            return .result()
        }

        let wallControl = SharedWidgetWallControlState.load(from: defaults)
        switch SharedWidgetTakeControlRuntime.action(for: wallControl) {
        case .enableLocalNavigation:
            SharedWidgetTakeControlRuntime.markControlClaimed(isPartySession: false, to: defaults)
            await refreshActivities()
            #if !WIDGET_EXTENSION
            diagnosticRun.mark(.activityKitUpdated)
            completionClass = .localNavigationEnabled
            #endif
            return .result()
        case .alreadyAllowed:
            await refreshActivities()
            #if !WIDGET_EXTENSION
            diagnosticRun.mark(.activityKitUpdated)
            completionClass = .alreadyAllowed
            #endif
            return .result()
        case .requestServerAuthorization:
            break
        }

        #if !WIDGET_EXTENSION
        diagnosticRun.mark(.networkStarted)
        #endif
        let result = await WidgetNetworking.sendTakeControl()
        #if !WIDGET_EXTENSION
        switch result {
        case .success:
            diagnosticRun.mark(.networkFinishedSuccess)
        case .serverRejected:
            diagnosticRun.mark(.networkFinishedTerminal)
            completionClass = .serverRejected
        case .retryableFailure:
            diagnosticRun.mark(.networkFinishedRetryable)
            completionClass = .retryableNetworkFailure
        }
        #endif
        guard result == .success else {
            Self.logger.notice("TakeControlIntent rejected or failed; leaving widget navigation disabled")
            return .result()
        }

        SharedWidgetTakeControlRuntime.markControlClaimed(isPartySession: true, to: defaults)
        await refreshActivities()
        #if !WIDGET_EXTENSION
        diagnosticRun.mark(.activityKitUpdated)
        #endif
        return .result()
    }

    private func refreshActivities() async {
        for activity in Activity<ClimbSessionAttributes>.activities {
            guard activity.activityState == .active else { continue }
            let content = ActivityContent(state: activity.content.state, staleDate: Date().addingTimeInterval(SharedConstants.liveActivityStaleInterval))
            await activity.update(content)
        }
    }
}
