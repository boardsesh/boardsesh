import ActivityKit
import AppIntents
import os.log

@available(iOS 17.0, *)
struct TakeControlIntent: LiveActivityIntent {
    static var title: LocalizedStringResource = "Take Control"
    static var description = IntentDescription("Claim wall control for this session")

    private static let logger = Logger(subsystem: "com.boardsesh.app", category: "LiveActivityIntent")

    func perform() async throws -> some IntentResult {
        guard let defaults = SharedConstants.sharedDefaults else { return .result() }

        let wallControl = SharedWidgetWallControlState.load(from: defaults)
        guard wallControl.requiresServerAuthorization else {
            SharedWidgetWallControlState.save(navigationAllowed: true, isPartySession: false, to: defaults)
            await refreshActivities()
            return .result()
        }

        guard !wallControl.navigationAllowed else {
            await refreshActivities()
            return .result()
        }

        let result = await WidgetNetworking.sendTakeControl()
        guard result == .success else {
            Self.logger.notice("TakeControlIntent rejected or failed; leaving widget navigation disabled")
            return .result()
        }

        SharedWidgetWallControlState.save(navigationAllowed: true, isPartySession: true, to: defaults)
        await refreshActivities()
        return .result()
    }

    private func refreshActivities() async {
        for activity in Activity<ClimbSessionAttributes>.activities {
            guard activity.activityState == .active else { continue }
            let content = ActivityContent(state: activity.content.state, staleDate: Date().addingTimeInterval(180))
            await activity.update(content)
        }
    }
}
