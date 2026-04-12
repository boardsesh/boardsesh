import ActivityKit
import AppIntents

@available(iOS 17.0, *)
struct PreviousClimbIntent: LiveActivityIntent {
    static var title: LocalizedStringResource = "Previous Climb"
    static var description = IntentDescription("Navigate to the previous climb in the queue")

    func perform() async throws -> some IntentResult {
        guard let defaults = SharedConstants.sharedDefaults else {
            return .result()
        }

        let (items, currentIndex) = SharedQueueState.load(from: defaults)

        let prevIndex = currentIndex - 1
        guard prevIndex >= 0 else {
            return .result()
        }

        // Persist the new index so the main app picks it up.
        SharedQueueState.saveCurrentIndex(prevIndex, to: defaults)

        // Optimistically update every active Live Activity.
        let prevItem = items[prevIndex]
        let newState = ClimbSessionAttributes.ContentState(
            climbName: prevItem.climbName,
            climbDifficulty: VGradeFormatter.formatVGrade(prevItem.difficulty),
            angle: prevItem.angle,
            currentIndex: prevIndex,
            totalClimbs: items.count,
            hasNext: prevIndex < items.count - 1,
            hasPrevious: prevIndex > 0,
            climbUuid: prevItem.climbUuid
        )

        for activity in Activity<ClimbSessionAttributes>.activities {
            // ActivityKit's update() is non-throwing, but only update active
            // activities — calling update on ended/dismissed activities is a no-op
            // but logs warnings in the system.
            guard activity.activityState == .active else { continue }
            let content = ActivityContent(state: newState, staleDate: Date().addingTimeInterval(180))
            await activity.update(content)
        }

        // Send navigation to the backend directly via HTTP. This works even
        // when the main app is suspended. Only fall back to the Darwin
        // notification path (which wakes the main app to send a WS mutation)
        // if the HTTP request fails.
        let httpSuccess = await WidgetNetworking.sendNavigation(action: "previous", currentIndex: prevIndex)
        if !httpSuccess {
            defaults.set("previous", forKey: SharedConstants.pendingActionKey)
            postDarwinNotification()
        }

        return .result()
    }

    private func postDarwinNotification() {
        let name = SharedConstants.queueNavigateNotification as CFString
        CFNotificationCenterPostNotification(
            CFNotificationCenterGetDarwinNotifyCenter(),
            CFNotificationName(name),
            nil, nil, true
        )
    }
}
